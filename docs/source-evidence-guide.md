# 源码与运行证据导读

先完成[五阶段学习路径](learning-path.md)中的一项操作，再用本页回答：**哪段代码决定了下一步？当前观察支持什么解释？还缺哪份证据？** 第二期“源码分层与运行证据对照”已完成，本页与「深入观察 → 源码与证据」标签配套。

标签中的真实源码摘录直接来自当前源码，标明文件、符号和行号；本导读使用文件与可搜索表达式定位，避免固化易漂移的行号。源码范围固定为六个项目文件，作为文本随前端模块加载，页面只展示选定摘录；没有任意本机文件读取入口。原「核心代码概念」保留概念教学示意；要核对真实实现，使用「源码与证据」。证据区只读当前选中订单的 detail、数据新鲜度标志及页面已有的真实确认回执，不会执行实验，也不会跨请求自动判定 Worker 恢复。History 证据可按事件 ID 跳到「事件历史」，用显示的 `#ID` 对照；完整属性与 Payload 到同一 Run 的官方 Temporal UI 查看。

## 先找到执行链路，再分层读函数

| 阅读顺序 | 文件与搜索入口 | 要找出的关系 |
| --- | --- | --- |
| API / Client | [server/index.ts](../server/index.ts)：`'/api/orders'`、`client.workflow.start` | HTTP 创建请求传入 `WORKFLOW_TYPE`、`TASK_QUEUE`、`args`，返回 Workflow ID / Run ID；后续编排异步推进 |
| Worker | [server/worker.ts](../server/worker.ts)：`Worker.create`、`workflowsPath`、`activities`、`worker.run()` | Worker 在同一 Task Queue 上注册 Workflow 与 Activity，主动领取并执行任务 |
| Workflow | [server/workflows.ts](../server/workflows.ts)：`orderWorkflow` | 编排库存、付款、等待确认、可选打包、发货，并决定失败后的补偿 |
| Activity | [server/activities.ts](../server/activities.ts)：`simulatedRequest`、`chargePayment`、`packOrder`、`shipOrder` | Worker 实际执行的模拟业务、故障注入与检查点处理；付款进一步进入 SQLite 账本 |

`workflows.ts` 可以按以下五层定位，不必从文件开头一次读完：

1. **Activity 配置**：`sharedActivityOptions` 与三组 `proxyActivities`。先分清通用超时 / 取消策略、付款退避、打包的心跳与执行期限。这些代理调用由 Temporal 调度，Activity 函数体在 Worker 执行。
2. **消息 handler**：`setHandler(stateQuery`、`applyApproval`、`validateApprovalUpdate`、`setHandler(approveSignal`、`setHandler(approveUpdate`。把只读观察、确认状态修改、Update 校验与返回值分开理解。
3. **补偿函数**：`compensate`。找出退款检查与释放库存的条件、顺序和逐项失败处理。
4. **`try` 主干**：搜索 `await reserveInventory`，顺着付款 → `condition` → 可选打包 → 发货阅读。第一阶段先读这一层，遇到确认再回看 handler。
5. **`catch` 分支**：`isCancellation`、`CancellationScope.nonCancellable(compensate)`、`OrderWorkflowFailed`。解释业务状态何时改变、清理为何能继续、何时提交执行终态。

`activities.ts` 先读 `simulatedRequest`：心跳帮助接收取消，`Context.sleep` 响应取消。再读库存 / 发货等薄封装，随后读 `chargePayment` 的尝试号、扣款与故障位置，最后读 `packOrder` 的 `heartbeatDetails`、批次循环和暂停心跳分支。类型或常量不清楚时按需查 [shared/types.ts](../shared/types.ts)。

本阶段保留现有 Workflow runtime，以现有文件中的分区、符号和当前源码摘录达到分层阅读目标，暂不拆分运行时。`orderWorkflow` 仍是唯一的订单编排，没有新增一份教学副本 Workflow。

若要了解这个标签如何工作，再读 [learning-catalog.ts](../src/learning-catalog.ts) 的问题与源码定位、[source-excerpts.ts](../src/source-excerpts.ts) 的摘录和行号提取、[learning-sources.ts](../src/learning-sources.ts) 的固定源码文本入口，以及 [learning-evidence.ts](../src/learning-evidence.ts) 的只读证据模型；[SourceEvidencePanel.tsx](../src/components/SourceEvidencePanel.tsx) 负责呈现，[InspectorTabs.tsx](../src/components/InspectorTabs.tsx) 负责同一 Run 内的事件跳转。

## 这次观察够新吗？

[详情 API](../server/index.ts) 的 `GET /api/orders/:workflowId` 先 Describe，取得当前 Run 后固定该 Run，等待 `handle.query(STATE_QUERY)` 结束，再 `handle.fetchHistory()`。Query 失败也会继续取 History，因此等待 Query 期间到达的 Signal 可以包含在响应里。`observedAt` 是这份响应的观测时间，**Describe → Query → History 不是原子快照**；同一响应中执行状态、心跳、Query 和后读的 History 可能反映不同进度。

| 教学问题 | 真实来源与字段 | 能解释到哪里 |
| --- | --- | --- |
| 业务代码现在走到哪里？ | Query：`detail.state.status`、`steps`、`approvedAt`、`compensationProgress`、`packing`；失败信息 `stateError` | 只有新鲜 Query 才能说明本次业务状态。同 Run 保留的旧 state 便于阅读，但已过期，不能据此判断仍在等待或刚完成补偿 |
| Server 观察到的执行与活动状态是什么？ | Describe：`detail.status`、`pendingActivities[].state / attempt / lastHeartbeatAt / heartbeat / lastFailure` | 执行状态与业务状态含义不同；心跳是 Server 最近收到的检查点，Pending 的新 attempt 也可能暂时带着旧尝试的 heartbeat |
| 哪些事实已经入历史？ | History 经 [presentHistory](../server/history.ts) 转换：`history[].id / type / activityType / attempt / signalName / updateId / detail` | 用同一 Run 内的事件 ID 关联事实；页面是事件摘要，完整 outcome、失败原因与活动关联属性需查官方 UI |
| 模拟支付实际记了什么？ | SQLite 经 [PaymentStore.get](../server/payment-ledger.ts)：`payment.attempts / debitCount / refundCount / totalCharged / totalRefunded / entries` | 账本按 **Workflow ID** 聚合，没有按 Run ID 隔离；付款调用、实际扣款、退款分别计数，也不与 Temporal History 共享原子事务 |

[App.tsx](../src/App.tsx) 的 `pollDetail` 区分 Query 失败和整次详情失败：前者可能带回新的 History、Describe 与账本，但旧 state 已过期；后者保留的 state、History、Pending 和账本全部过期。先读页面的新鲜度提示，再作解释。Query 不可用还可能来自初始化、任务积压或连接问题，本身不能证明 Worker 进程停机。

以下各题都先记下 Workflow ID / Run ID，按对应学习阶段操作；引用旧数据时只描述“上次观察到”，等待新鲜响应后再判断当前结果。

## 正常订单：谁决定付款后等待、确认后发货？

**操作**：按[阶段一](learning-path.md#阶段一正常订单与角色分工)创建正常订单，等到人工确认，用默认 Signal 确认并观察完成。

**源码定位**：[index.ts](../server/index.ts) 的 `client.workflow.start` → [worker.ts](../server/worker.ts) 的 `Worker.create` → [workflows.ts](../server/workflows.ts) 的 `orderWorkflow`，搜索 `await reserveInventory`、`await chargePayment`、`condition(() => approvalReceived`、`await shipOrder`；对应 Activity 在 [activities.ts](../server/activities.ts)。

**真实证据**：新鲜 `state.status: waiting_approval` 与 Describe `status: RUNNING`；History 中库存 / 付款的 `ActivityTaskCompleted`、确认等待的 `TimerStarted`、`signalName: approveOrder` 的 `WorkflowExecutionSignaled`、正常确认后的 `TimerCanceled`。最后核对 `shipOrder` 成功、`state.trackingNumber`、`WorkflowExecutionCompleted` 与 Describe `COMPLETED`，记录相关 `#ID`。

**解释**：Workflow 决定等待和继续，Activity 执行具体步骤。创建成功与 Signal 收件回执都不能证明已经发货；`WorkflowTaskCompleted` 只是一轮编排提交完成，整个执行完成要看 `WorkflowExecutionCompleted`。

## Worker 恢复：哪些结果来自旧历史，哪些步骤在重启后推进？

**操作**：沿用[阶段二](learning-path.md#阶段二等待确认时停止重启-worker)及[Worker 恢复向导](worker-recovery-guide.md)的准备条件和阶段门禁。保存付款后的基线，取得 Query 中断与停机 History 边界 `#N`，在停机阶段认证边界之后的 Signal，再重启核对。

**源码定位**：[worker.ts](../server/worker.ts) 的 `workflowsPath`、`worker.run()`；[workflows.ts](../server/workflows.ts) 的 `state`、`inventoryReserved`、`paymentCharged` 与主干；[RecoveryGuide.tsx](../src/components/RecoveryGuide.tsx) 调用 [recovery.ts](../src/recovery.ts) 的 `observeRecovery`、`recoveryPhaseReadiness`、`recoveryChecks`；[index.ts](../server/index.ts) 搜索 `Query 结束后再读 History`。

**真实证据**：向导保存的同 Workflow ID / Run ID 基线、原库存 / 付款完成事件；停机阶段 `RUNNING` 且 Query 不可用的响应、边界 `#N` 后新增的确认 Signal；重启后的新鲜 Query、该 Signal 后完成的 Workflow Task 与最终 `COMPLETED`。对照基线之后无新增库存 / 付款调度，`payment.attempts / debitCount / totalCharged` 不增加且没有退款。

**解释**：Server 保存 History，新 Worker 的 SDK 重放确定性的编排以重建变量；已记录的成功 Activity 结果被复用。当前 detail 能展示这些事实，但单次观察无法认证整个停机窗口。没有停机证据，或 Signal 在边界前已到达，就不能以“同一 Run 最后完成”证明本次恢复；仍由现有向导保留基线并判定。缓存意味着运行中的 Worker 不必每轮从头重放，结果未被 Server 记录的 Activity 仍可能再次执行。

## 重试：attempt 解释了哪一次执行？

**操作**：按[阶段三](learning-path.md#阶段三重试超时与幂等)创建「自动重试」订单；另建「失败与补偿」订单观察耗尽。

**源码定位**：[workflows.ts](../server/workflows.ts) 的付款 `proxyActivities`，搜索 `maximumAttempts: 3`、`initialInterval`、`backoffCoefficient`；[activities.ts](../server/activities.ts) 的 `chargePayment`，搜索 `Context.current().info.attempt`、`attempt < 3`、`PaymentGatewayUnavailable`。

**真实证据**：`chargePayment` 对应的最终 `ActivityTaskStarted.attempt`，正常重试成功为 3；运行时可结合 `pendingActivities[].attempt / lastFailure` 和 Worker 日志；账本 `entries` 中的 `attempt / failure / debit` 说明实际模拟调用与入账。库存没有因付款重试重新调度。耗尽路径查看最终失败、补偿与 Workflow 失败事件。

**解释**：最大尝试次数包含首次执行。History 会聚合 Activity 中间失败，不能要求三组独立的 Started / Failed；最终 attempt 表示尝试序号，不能据此推算扣款笔数。达到重试上限后，最终失败才传回 Workflow 的 `catch`。

## 确认超时：TimerFired 为什么让订单走补偿？

**操作**：创建「等待超时」订单，不确认，观察付款后开始的 15 秒等待与最终失败。

**源码定位**：[validation.ts](../server/validation.ts) 的 `normalizeOrder` 固定该场景的确认期限；[workflows.ts](../server/workflows.ts) 搜索 `approvalTimeoutMs`、`approvalDeadline`、`approvedInTime`、`ApprovalTimedOut`；[client.ts](../server/client.ts) 的 `withTemporal` 是独立的 HTTP 请求等待期限。

**真实证据**：新鲜 Query 的 `approvalDeadline`、确认步骤失败及 `state.error`；关联本次确认等待的 `TimerStarted / TimerFired`，随后退款检查、释放库存和 `WorkflowExecutionFailed`，Describe 最终为 `FAILED`。完整 Timer 关联属性在官方 UI 核对。

**解释**：`condition` 到期返回 false，应用抛出 `ApprovalTimedOut` 并进入失败补偿；持久化 Timer 在 Worker 停机期间仍计时，分支代码等 Worker 可运行时继续执行。HTTP 的约 6 秒等待截止只约束一次请求，不能代替确认 Timer；任意一个 `TimerFired` 也不足以证明确认超时，要关联等待分支和后续失败。

## 幂等：付款调用两次，为什么账本只扣一次？

**操作**：创建「支付幂等」订单，观察付款成功后确认并完成。

**源码定位**：[activities.ts](../server/activities.ts) 的 `chargePayment`，搜索 `payments.charge`、`PaymentResponseLost`；[payment-ledger.ts](../server/payment-ledger.ts) 的 `PaymentStore.charge`、`transaction`、`idempotency_key`、`${workflowId}:charge`。

**真实证据**：`payment.attempts: 2`、`debitCount: 1`，`entries[].kind` 依次说明调用、`debit`、故障、再次调用与 `reused`；金额看 `totalCharged`。History 中付款最终成功的 attempt 为 2，表示 Server 最终记录了第二次尝试的结果。

**解释**：第一次账本事务已提交，Activity 在报告成功前失败；第二次真实执行时用稳定键复用已入账结果。History 中成功一次无法证明业务只调用一次，attempt 为 2 也无法证明扣款两笔。账本以 Workflow ID 为范围，不能当作某一 Run 的独立流水；重新创建订单生成新 Workflow ID，不属于同一扣款幂等范围。本例验证的是本地模拟支付效果。

## 取消与补偿：为什么业务已取消，执行仍在 RUNNING？

**操作**：按[阶段四](learning-path.md#阶段四取消补偿与心跳)在付款后取消，再用「长任务心跳」观察打包中的取消。

**源码定位**：[index.ts](../server/index.ts) 的 `'/api/orders/:workflowId/cancel'`、`handle.cancel()`；[workflows.ts](../server/workflows.ts) 的 `isCancellation`、`markUnfinishedCancelled`、`compensate`、`CancellationScope.nonCancellable`；[activities.ts](../server/activities.ts) 的 `simulatedRequest`、`packOrder`、`refundPayment`、`releaseInventory`。

**真实证据**：`WorkflowExecutionCancelRequested` 与可能出现的 Activity 取消事件；新鲜 `state.status: cancelled`、`compensationProgress.status / steps[].status / detail`，此时 Describe 可能仍为 `RUNNING`。继续看退款 / 释放库存的 Activity 结果、`payment.refundCount / totalRefunded`，最后核对 `WorkflowExecutionCanceled` 与 `CANCELLED`。

**解释**：应用先标记业务取消，在不可取消作用域中完成补偿，再提交执行终态；取消回执只是请求已交给 Temporal。Activity 通过心跳与可取消等待协作响应。`paymentAttempted` 也会触发查账退款，因为扣款可能已发生但成功结果尚未返回；退款检查成功不保证一定产生退款流水。补偿逐项记录失败，不能只凭取消请求或一个业务状态推断清理全部成功，也没有自动回滚外部效果。

## 心跳：新尝试从哪个检查点继续？

**操作**：先用「长任务心跳」观察实时打包，再用「心跳超时恢复」让首次尝试暂停心跳。手工打包崩溃仍按[原恢复向导](worker-recovery-guide.md#3-实验二打包期间崩溃)保存基线和操作进程。

**源码定位**：[workflows.ts](../server/workflows.ts) 的 `packOrder` 代理与 `state.packing = await packOrder`；[activities.ts](../server/activities.ts) 的 `packOrder`，搜索 `heartbeatDetails`、`resumedFrom`、`context.heartbeat(checkpoint)`、`heartbeat_timeout`；[pending-activities.ts](../server/pending-activities.ts) 的 `checkpoint`、`presentPendingActivities`。

**真实证据**：Describe 的 `pendingActivities` 中找 `activityType: packOrder`，读取 `attempt`、`lastHeartbeatAt` 和 `heartbeat.completedBatches / totalBatches / attempt / resumedFrom / phase`。新尝试可能暂时保留旧 heartbeat，必须先确认 **`pending.attempt === pending.heartbeat.attempt`**，再解释新尝试的进度。Activity 成功后，对照新鲜 Query 的 `state.packing` 与 History 成功结果；中间超时 / 重试不一定逐次出现在 History。

**解释**：Server 的 5 秒心跳期限可触发新尝试，新 Activity 从最近收到的批次检查点继续；这与重放 Workflow 编排不同。心跳会节流，页面也有轮询延迟，检查点不等于退出瞬间内存，每批也没有独立 History 事件。自动心跳故障只证明 Activity 超时重试；要证明 Worker 进程崩溃恢复，仍需向导的停机窗口与基线。真实批次副作用还需幂等，本例仅模拟等待和进度。

## Signal：收件与业务确认如何对应？

**操作**：正常订单等待确认时发送默认 Signal，观察回执、状态与后续发货；停机 Signal 实验沿用恢复向导。

**源码定位**：[index.ts](../server/index.ts) 的 `'/api/orders/:workflowId/approve'`、`handle.query`、`handle.signal(APPROVE_SIGNAL)`；[workflows.ts](../server/workflows.ts) 的 `setHandler(approveSignal`、`applyApproval`、`condition`。

**真实证据**：页面真实回执 `status: sent` 与 `runId`；History 的 `WorkflowExecutionSignaled`、`signalName: approveOrder`；新鲜 Query 的 `approvedAt / approvalMethod: signal`，随后另查 `shipOrder` 成功和 Workflow 完成。

**解释**：回执证明 Server 收件，不等待 handler；`applyApproval` 只在允许确认时改变状态，提前或重复 Signal 会被静默忽略。Signal 事件不能单独证明业务确认或发货，也不能用回执与 handler 的先后推断完成。本项目普通确认 API 先做 Query，Query 不可用导致 API 失败不代表 Server 无法接收 Signal，因此停机实验使用官方 UI。

## Update：Completed 是否意味着确认成功？

**操作**：按[阶段五](learning-path.md#阶段五signal--update-深入对照)先不勾选核对复选框，提交并观察真实拒绝；再勾选，按页面策略用新 Update ID 提交。若出现 `unknown`，用页面保留的原 Run ID、Update ID 与参数查询或重试。

**源码定位**：[workflows.ts](../server/workflows.ts) 的 `validateApprovalUpdate`、`setHandler(approveUpdate`、`currentUpdateInfo`、`applyApproval`；[index.ts](../server/index.ts) 的 `executeUpdate`、`getUpdateHandle`、`WorkflowUpdateFailedError`；[history.ts](../server/history.ts) 的 `acceptedUpdates`、`completedUpdate?.outcome?.failure`；[ApprovalComparison.tsx](../src/components/ApprovalComparison.tsx) 的 `feedback` 展示真实回执。

**真实证据**：validator 拒绝看页面真实反馈的 `status: rejected` 与消息（HTTP 回执另含 `failureType: ApprovalConfirmationRequired`），不为它补造 History。接受后的事件按 `history[].updateId / updateName` 对照 `WorkflowExecutionUpdateAccepted / Completed`，同时看 `detail` 中的失败说明和官方 UI 的完整 outcome。成功确认还要有 handler 返回的 `status: approved`、`runId / updateId / approvedAt`，以及新鲜 Query 的 `approvalMethod / approvalUpdateId`；发货与执行完成另查各自证据。

**解释**：Completed 表示 Update 已有 outcome，其中可以是失败；不能只看事件名就推断 handler 成功或订单已发货。validator 在接受前拒绝通常没有 Accepted / Completed，可观察到的依据是本次真实回执；Admitted 是否存在以实际 History 为准。HTTP `unknown` 只表示没有拿到确定结果，不表示未生效或已取消。同 ID 重试与结果复用限于同一个 Run、同一个 Update ID 及服务端保留范围，也不能把 validator 拒绝当作已持久化且可反复查询的结果。完整语义见[Signal / Update 对照](signal-update-comparison.md)。
