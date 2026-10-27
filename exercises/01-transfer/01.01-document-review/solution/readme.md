# 资料审核参考设计

完成 [题目与验收](../readme.md) 和自己的实现后，再阅读本页与 [workflow.ts](workflow.ts)。参考版本与题目使用同一套输入、成功返回值、Signal、Query、活动和 CLI，区别集中在 Workflow 编排。

## 独立运行

先让题目版本的已有执行结束，然后在其终端正常退出题目 Worker。启动参考 Worker：

```bash
npm run exercise:review:solution -- worker
# 在另一个终端：
npm run exercise:review:solution -- start --document reference-001 --timeout 300
```

无需根脚本时：

```bash
npx tsx exercises/01-transfer/01.01-document-review/solution/main.ts worker
npx tsx exercises/01-transfer/01.01-document-review/solution/main.ts start --document reference-001 --timeout 300
```

其余命令使用 start 输出的完整 ID：

```bash
WF='填入完整WorkflowID'
RUN='填入完整RunID'
npm run exercise:review:solution -- inspect "$WF" "$RUN"
npm run exercise:review:solution -- approve "$WF" "$RUN"
npm run exercise:review:solution -- result "$WF" "$RUN"
# 取消验收时，用一个新的、仍在等待审核的执行：
npm run exercise:review:solution -- cancel "$WF" "$RUN"
```

切勿同时运行两个版本的 Worker；默认 task queue 固定为 `temporal-learning-document-review`。停止/恢复实验用同一个版本、同一 SQLite、同一连接配置重启。完整手工验收使用练习首页步骤，把命令前缀换为 `exercise:review:solution` 即可。

## 编排设计

尽早注册 Query 与 Signal。Query 只读取状态；Signal 只在 `waiting_review` 记录第一次确认，提前、重复或进入清理后的确认不改变状态。Query 本身不能证明 Temporal 执行终态，Signal 返回也不能证明 handler 已执行。

在 `await prepareDocument` 之前标记 `prepareAttempted`，成功返回后再标记 `prepareCompleted`。等待审核使用 `condition` 和持久化 Timer；`Date.now()` / `new Date()` 是 Workflow 沙箱时间，重放时由历史驱动。Workflow 中没有 SQLite、进程、文件、网络或现实世界随机数。

准备完成后开始计算审核截止时间，输入 `reviewTimeoutSeconds` 只约束审核等待。确认通过后归档，返回 `completed`。超时、活动失败、协作取消统一进入清理路径；先进入 `cleaning_up`，再在 `CancellationScope.nonCancellable` 中执行真实清理活动。只有清理确认后才写入终端业务状态：

| 路径 | Query 业务状态 | Temporal Describe / result |
| --- | --- | --- |
| 审核通过并归档 | `completed` | `COMPLETED` / 返回 `DocumentReviewState` |
| 审核 Timer 到期并清理 | `timed_out` | `FAILED` / nonretryable `DocumentReviewTimedOut` |
| 协作取消并清理 | `cancelled` | `CANCELLED` / `CancelledFailure` |
| 其它业务或活动失败并清理 | `failed` | `FAILED` / nonretryable `DocumentReviewFailed` |
| 清理重试后仍失败 | `failed`，`cleanup.status=failed` | `FAILED` / nonretryable `DocumentCleanupFailed` |

清理失败会保留待处理信息，明确以失败结束；它不能被包装为成功取消。

## 结果未知与本地幂等

`workflowId` 是本练习的业务幂等范围，准备键是 `${workflowId}:prepare`。Run ID 和 Activity attempt 只用于审计；否则一次 Activity 重试或换 Run 会得到另一个键，无法避免重复资料。

[SQLite 存储](../support/store.ts) 在 `BEGIN IMMEDIATE` 事务中提交本地效果和审计。首次准备写内容、状态、`prepared` 记录；重复准备复用同一记录并追加 `reused`；归档也检查当前资料并幂等执行。`--lose-response` 只在第一次准备事务提交后抛 `PrepareResponseLost`，故障标记也在事务中持久化，不能靠 Worker 内存决定是否再次注入。

活动配置最多 2 次尝试（含首次），首次失败后约 2 秒重试。正常丢响应验收应为 `prepareAttempts=2`、`prepared=1`、`reused=1`。`attempt` 不决定幂等效果，它只让你能看见真实调用次数。

清理永远按 Workflow ID 查账，不能只判断 `prepareCompleted`。清理将实际内容设为 `NULL`、状态设为 `removed`，保留业务身份、幂等键和审计；重复清理只追加查账审计，`removed` 效果数不增加。墓碑禁止相同 Workflow ID 再次创建被清理资料。同一幂等键也禁止换成不同 `documentId`。

本地 SQLite 写入同步执行，不跨越 `await`；活动有心跳、`WAIT_CANCELLATION_COMPLETED`、执行/整体超时。这样协作取消会先等待活动退出，再安排查账清理，减少“清理后旧准备仍在写”的竞态。真实远端资源若能在调用超时后继续提交，需要提供端到端幂等、栅栏或额外对账机制，不能直接把此例的同步事务保证推广过去。

## 恢复证据与范围

等待审核的 Workflow 不依赖 Node 进程内的 Promise 长期存活。停止唯一练习 Worker 后，Server 保存 Timer 与 Signal；重启相同版本的 Worker 时历史重放使用已完成的 prepare 结果，继续等待或处理 Signal，无需重新安排已完成 prepare。

`inspect` 为 Query 设置约 2 秒 RPC deadline，无缓存回退，失败后仍读真实 History 和只读账本。手工验收须先建立同 Run / `RUNNING` / Query 不可用的 History 边界，再于停机期间发送 Signal 并确认新事件 ID，最后重启。单看最后完成、Query 失败或点击“停止”都不够。

边界必须保留：

- Describe、Query、History、SQLite 不是跨系统原子快照，允许短暂不一致；每项输出独立观察时间/错误。
- History 是指定 Run 的，账本计数和幂等键按 Workflow ID 跨 Run 聚合。CLI 为每次 start 生成新 ID，不提供重用选项；分析时用审计的 Run ID / Activity ID 与真实调度事件关联。
- Signal 入库不表示业务确认已应用；持久化 Timer 不因停 Worker 暂停，临近截止时以实际历史/结果为准。
- 本机锁阻止 CLI 的题目/参考 Worker 并行启动，无法约束多机 Worker、地址别名或绕过 runner 的启动方式。
- `cancel` 是协作取消；执行级 Terminate 或 Workflow Execution Timeout 不会运行此 Workflow 的清理代码。审核超时是业务 Timer，不能用强杀/Terminate 代替。
- 这是本机 SQLite 资料演示，没有真实支付或外部业务网络效果；SQLite 文件需保留在持久卷，进程恢复不等于机器磁盘丢失后仍能恢复。
- 已有订单页面的恢复向导只覆盖订单业务；此练习使用独立 CLI 和步骤，不声称现有向导支持资料审核。

## 自动验证

```bash
npx tsx --test tests/document-review.test.ts
# 等价的项目脚本：
npm run test:exercise
```

一个临时 `TestWorkflowEnvironment` 内使用真实 Workflow 与活动、临时 SQLite 和随机 task queue。验证准备/归档、首次丢响应、超时清理、取消清理、结果未知后取消查账、归档提交后的失败清理、清理失败显式失败、输入校验及未实现题目的明确失败。

边界验收在准备和归档 Activity 的可释放等待点发送提前 / 重复 Signal，并核对 Signal 后的 Workflow Task 已完成；提前确认不会跳过审核，重复确认不会覆盖首次 `approvedAt`，最终归档一次。测试中的 Query、结果和失败等待均有 RPC 截止；未结束时报告阶段、预期与最后观察状态，诊断查询本身也有期限。

恢复测试在等待点优雅关闭第一个 Worker，证实 Query deadline、同 Run 的停机 Signal 新事件、账本尚未归档，再启动第二个 Worker。它断言完成后 Run ID 不变、原 prepare 完成事件保留、prepare 只有一次调度且实际调用/写入没有增加。另用真实 CLI 子进程验证 start 的完整 ID、停机 inspect 的真实活动事件关联与账本、直接 Signal、取消与 result 失败退出。CLI 子进程使用同一临时 Server 的练习专用队列，其余行为测试使用随机队列。测试不操作开发服务或用户默认账本，也不把程序化优雅关闭当作验证了操作系统强杀。
