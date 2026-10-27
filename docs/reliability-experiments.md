# 幂等、心跳与补偿实验

这组实验接在[订单执行流程](temporal-execution-flow.md)之后，重点观察三个边界：业务状态与执行状态的差异、Activity 重试与实际扣款的差异，以及 Activity 心跳如何支持取消和检查点恢复。

启动方式见[项目 README](../README.md)。新增场景与原来的正常、重试、失败、超时场景共用同一个 `orderWorkflow`、Namespace 和 Task Queue。本地「实验台」的当前运行面板用「确认 / 取消」操作订单，用「心跳 / 账本」查看检查点、补偿与支付流水；小屏先切「当前运行」。手工停止 Worker 的向导从顶部「恢复实验」进入。

## 1. 先认识页面上的数据来源

| 页面信息 | 数据来源 | 含义 |
| --- | --- | --- |
| 业务状态、订单步骤、补偿进度 | Workflow 的 `orderState` Query | 编排代码当前决定做什么、已完成什么 |
| Temporal 执行状态 | `handle.describe()` | Server 记录的 `RUNNING / COMPLETED / FAILED / CANCELLED` 等状态 |
| 打包当前尝试与最后心跳 | Describe 的 `pendingActivities` | Server 已收到的 Activity 心跳检查点；有发送和轮询延迟 |
| 打包最终结果 | `state.packing` | Activity 成功返回后，Workflow 记录的最终检查点 |
| 支付调用、扣款与退款流水 | 独立 SQLite 账本 | 模拟支付系统中的实际业务效果 |
| 事件历史 | `fetchHistory()` | 持久化的 Workflow / Activity / Signal / Timer 事件 |

这些读取不是跨系统的原子快照。在结束边界，Describe 可能先读到 `RUNNING`，接着 Query 读到 `completed`，下一次轮询即可更新。Query 暂时失败时，前端只复用同一个 Run 的旧业务快照并标记过期；不能据此把旧业务状态当作最新状态。

## 2. 实验一：业务已取消，执行为什么仍是 RUNNING

### 操作

1. 创建一条正常订单，等待人工确认。
2. 点击取消并确认。
3. 同时观察业务状态、Temporal 执行状态和补偿列表。
4. 等待退款和释放库存完成。

### 预期观察

```text
收到取消请求
→ Workflow 捕获取消异常
→ 业务状态 cancelled，Temporal 仍为 RUNNING
→ 退款：running → completed
→ 释放库存：running → completed
→ 重新抛出取消异常
→ Temporal 执行状态 CANCELLED
```

每项模拟补偿约 1.4 秒，页面轮询约在请求结束后 1.5 秒再次发起；单个过渡状态可能在两次刷新之间完成。最终结果以执行状态、补偿列表和 History 为准。

### 代码如何表达

[server/workflows.ts](../server/workflows.ts) 在异常分支先设置业务状态，再使用 `CancellationScope.nonCancellable` 等待补偿：

```ts
const scope = CancellationScope.current();
if (isCancellation(error) || scope.consideredCancelled) {
  state.status = 'cancelled';
  await CancellationScope.nonCancellable(compensate);
  if (scope.consideredCancelled) await scope.cancelRequested;
  throw error;
}
```

`consideredCancelled` 表示作用域是否已取消；`cancelRequested` 是收到取消后以 SDK 取消异常拒绝的 Promise。这样即使 Activity 先返回心跳超时，也能在补偿后抛出取消异常。

每项补偿的状态放在：

```ts
state.compensationProgress = {
  status: 'running',
  steps: [
    { id: 'refund', label: '退款或核对扣款', status: 'pending' },
    { id: 'inventory', label: '释放库存', status: 'pending' },
  ],
};
```

真实步骤会根据此前尝试过的业务确定。只要已经尝试支付，失败或取消时都会调用幂等退款 Activity 核对账本：扣款提交和 Temporal 确认成功之间没有共享事务，普通场景也可能遇到结果未知。如果尚未扣款，核对不会产生退款流水；如果已经扣款，则退款一次。库存已预留时继续释放库存。

每个补偿独立捕获失败，退款失败仍会尝试释放库存。如果某项最终失败，补偿总状态为 `failed`，页面保留具体错误；Workflow 的最终失败或取消状态不代表所有业务清理都成功。

## 3. 实验二：Activity 调用两次，为什么只扣一次款

### 操作

1. 选择“支付幂等”，创建订单。
2. 观察付款步骤和支付账本。
3. 等待自动重试，确认调用次数为 2，扣款次数为 1。
4. 人工确认后正常发货；也可在等待确认时取消，验证只产生一笔退款。

### 故障发生在哪里

```text
第一次 chargePayment
→ SQLite 事务提交一笔扣款
→ 故意抛出 PaymentResponseLost
→ Temporal 安排下一次尝试

第二次 chargePayment
→ 使用同一个 workflowId:charge
→ 账本发现已处理
→ 返回原付款结果，不再扣款
→ Workflow 继续等待人工确认
```

第一次是在**业务效果已经提交之后、Activity 成功结果报告之前**故意失败。它模拟“已经扣款，但调用方未拿到成功结果”的一种情况，没有真的杀死 Worker 或断开网络。

### 幂等键与事务

[server/payment-ledger.ts](../server/payment-ledger.ts) 使用：

```text
幂等键 = ${workflowId}:charge
```

`payments.workflow_id` 为主键，`idempotency_key` 有唯一约束。`charge()` 在 `BEGIN IMMEDIATE` 事务中检查已有付款、插入扣款和记账流水。

同一个 Workflow 的 Activity 重试使用相同键。若已经付款，就返回 `reused: true`；同一个键携带不同金额会报错，避免把不同业务误当作重试。

退款检查同一笔付款是否已退，重复调用不会增加退款流水。账本的调用流水、扣款流水、退款流水分别统计，因此不会用 Temporal History 中的事件数量冒充支付系统的扣款次数。

### 数据保存在哪里

默认路径：

```text
.data/payments.db
```

它独立于 Worker 的内存，也独立于 Temporal 的数据库。API / Worker 重启后还可以读取原流水。使用 `PAYMENT_DB_PATH` 时，两者必须配置同一个绝对路径。

Node 内置 SQLite 无需额外依赖，要求 Node 22.13 或更新版本，推荐 Node 24 LTS。部分 Node 版本会输出实验性模块提示，不影响这个本地示例。

升级前的历史订单没有模拟账本记录，不能根据零笔流水判断旧订单是否付款。本例不会反向伪造旧流水。

### 这个实验没有保证什么

- 它不等于支付操作由 Temporal 精确执行一次；Activity 仍可能多次调用。
- 两次 HTTP 创建请求生成不同 Workflow ID，因此是两张不同订单；创建请求去重需另外设计。
- 本地 SQLite 只适用于同机学习；实际支付系统应在自己的事务边界内实现稳定幂等键与结果查询。
- 检查点、Workflow 局部变量和外部支付数据库没有共享事务；结果不确定时仍需查询、退款或对账。

## 4. 实验三：心跳、运行中取消与检查点恢复

这两个场景在人工确认后增加一个 `packOrder` Activity，再创建发货单：

```text
库存 → 付款 → 人工确认 → 分批打包 → 发货
```

### 4.1 观察正常心跳

1. 选择“长任务心跳”，创建并人工确认订单。
2. 观察打包进度从 0 到 12 批；每批约 1 秒。
3. 查看当前尝试序号、已保存批次和最后心跳时间。
4. 等待完成，Query 中出现最终 `state.packing`，随后发货。

[server/activities.ts](../server/activities.ts) 每完成一批后调用：

```ts
context.heartbeat({
  completedBatches,
  totalBatches: 12,
  attempt: context.info.attempt,
  resumedFrom,
  phase: 'packing',
  updatedAt: new Date().toISOString(),
});
```

这是用于解释字段的摘录；完整代码保留并更新同一个检查点对象。心跳不会自动修改 Workflow 的 `state`，也不会为每批创建新的 Workflow Task。API 从 Describe 的 Pending Activities 读取并解码心跳，Activity 完成后才把最终结果交给 Workflow。

页面展示最近送达 Server 的检查点，受 Worker 节流与页面轮询影响，可能跳过某些批次，但不会由浏览器编造进度。

### 4.2 在 Activity 运行中取消

1. 再创建一条“长任务心跳”订单并确认。
2. 在打包进行中点击取消。
3. 观察打包不再继续，退款、释放库存依次执行。
4. 确认最终 Temporal 状态为 `CANCELLED`，没有创建发货单。

流程是：

```text
Client 请求取消 Workflow
→ Workflow 的取消作用域请求取消 Activity
→ Activity 发心跳并收到 Server 取消通知
→ context.sleep() 抛出取消异常
→ WAIT_CANCELLATION_COMPLETED 等待 Activity 结束
→ Workflow 捕获并运行 nonCancellable 补偿
→ 重新抛出取消异常，执行结束
```

所有短 Activity 也每 200 毫秒调用一次 heartbeat；打包任务约每秒调用一次。Worker 配置 `maxHeartbeatThrottleInterval: '500ms'`，以便实验中较快观察进度和取消。网络、调度和节流会影响实际延迟，取消并不等于立即中断任意外部 I/O。

在“心跳超时恢复”的暂停窗口请求取消时，Activity 可能先以心跳超时结束，而不是抛取消异常。Workflow 同时检查取消作用域；若取消已经请求，仍在补偿后以 `CANCELLED` 结束。没有取消请求的 Activity 超时继续按重试、最终失败规则处理。

### 4.3 停止心跳，观察真实超时恢复

1. 选择“心跳超时恢复”，创建并确认订单。
2. 第一次尝试完成第 3 批后，故意停止业务处理和心跳。
3. 页面显示最后保存的检查点，约 5 秒的心跳期限到期后，Temporal 安排重试。
4. 第二次尝试从 `Context.current().info.heartbeatDetails` 读取最近保存的 `completedBatches`。
5. 观察“从第 N 批恢复”，继续剩余批次并最终发货。

关键配置：

| 配置 | 值 | 作用 |
| --- | --- | --- |
| `heartbeatTimeout` | 5 秒 | 运行中超过期限未收到心跳，Server 判定该尝试心跳超时 |
| `startToCloseTimeout` | 45 秒 | 限制每一次打包尝试的总运行时间 |
| `scheduleToCloseTimeout` | 2 分钟 | 限制整个打包 Activity，包含排队、重试与执行 |
| `maximumAttempts` | 3 | 包含首次执行，总共最多 3 次尝试 |
| `initialInterval` | 1 秒 | 首次失败后的重试退避间隔 |

故障注入在旧尝试中暂停 8 秒，随后退出；暂停期间不会再处理批次。通常 Server 会在它退出前触发真实 heartbeat timeout，下一次尝试可以与旧尝试的退出过程交错。必须避免把服务端超时当作“原代码立即停止”的保证。

在重试等待期，Pending Activity 的尝试号可能已变为 2，但心跳 Payload 仍来自第 1 次尝试。这表示“准备下一次尝试”和“上一次保存的检查点”来自不同观察字段，不是第二次尝试又执行到暂停处。

### 4.4 检查点不是事务

恢复起点是**Server 最后保存的进度**，不保证等于故障前本地内存中最新的进度。SDK 心跳存在节流，最后一批的通知也可能在故障前未送达。

真实批处理应让每一批操作幂等，允许最后若干批重复执行。本例打包只等待并记录心跳，没有真实物理打包和外部副作用。

这里恢复的是未完成的 Activity 尝试；[执行流程文档中的 Worker 重放](temporal-execution-flow.md)恢复的是 Workflow 编排状态。两种机制分别解决不同层面的恢复问题。

### 4.5 实际结束 Worker，再观察恢复

页面上的“Worker 恢复实验”进一步提供人工操作向导：一组在等待确认时停止 Worker、通过官方 UI 发送 Signal；另一组在 `heartbeat` 打包中强制结束独立 Worker，观察新的尝试从服务端检查点继续。向导保存真实基线，核对同一个 Run、Query 中断与恢复、Activity 调度和支付账本，不把按钮当作恢复证据。

完整启动命令、进程操作、优雅退出与崩溃的区别见[Worker 恢复实验向导](worker-recovery-guide.md)。

## 5. 对照源码与验证

| 文件 | 重点 |
| --- | --- |
| [shared/types.ts](../shared/types.ts) | 七种场景、补偿步骤、心跳检查点、账本响应结构 |
| [server/workflows.ts](../server/workflows.ts) | 可选打包步骤、Activity 超时策略、逐项补偿 |
| [server/activities.ts](../server/activities.ts) | 扣款后故障、心跳循环、检查点恢复、取消响应 |
| [server/payment-ledger.ts](../server/payment-ledger.ts) | 幂等事务、独立支付流水和退款 |
| [server/pending-activities.ts](../server/pending-activities.ts) | 从 Describe 读取和校验心跳 Payload |
| [server/index.ts](../server/index.ts) | 使用固定 Run 读取 Query / History，返回三类观察信息 |
| [src/components/WorkflowPanel.tsx](../src/components/WorkflowPanel.tsx) | 双状态、补偿、支付与心跳可视化 |
| [tests/payment-ledger.test.ts](../tests/payment-ledger.test.ts) | 重复扣款、金额不匹配、重开数据库与退款去重 |
| [tests/experiments.test.ts](../tests/experiments.test.ts) | 真实 Activity 的幂等、心跳超时恢复和运行中取消 |
| [tests/workflow.test.ts](../tests/workflow.test.ts) | 编排分支、补偿进度与退款失败后继续释放库存 |

运行自动化验证：

```bash
npm test
npm run build

# Temporal、API、Worker 运行后
npm run test:e2e
```

测试使用隔离的账本文件和任务队列；测试付款不会向外部系统发起真实请求。真实心跳超时实验需要等待服务端计时，测试运行时间会比只验证数据结构更长。
