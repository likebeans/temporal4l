# Temporal Lab 五阶段学习路径

第一次学习按这条顺序走：**①正常订单与角色分工 → ②等待确认时停止重启 Worker → ③重试、超时与幂等 → ④取消、补偿与心跳 → ⑤Signal / Update 深入对照。** 先看一条正常订单如何推进，再用恢复和故障解释机制。

启动方式见[项目 README](../README.md)。已有服务运行时直接打开学习页面，无需重复启动。顶部在「实验台」「恢复实验」「学习路线」「自测笔记」之间切换；实验台的「确认 / 取消」提供人工操作，「心跳 / 账本」提供检查点、补偿和支付记录。先在「准备实验」创建或选择订单；「观察运行」在桌面并排显示流程与真实事件，「查看证据」独占内容区阅读。小屏在这三个任务视图之间切换。第二阶段需要独立控制 Worker，准备和进程操作统一以[Worker 恢复实验向导](worker-recovery-guide.md)为准。

每阶段先写一句预测，再实际操作、记录证据，最后用自己的话解释差异。可用纸笔或本地笔记记录 Workflow ID / Run ID 和相关事件 ID；这些是各阶段的手工学习提示，记录与解释由学习者完成。「深入观察 → 源码与证据」用于对照当前源码摘录与真实观测，History 证据可按事件 ID 跳到显示 `#ID` 的「事件历史」；先读数据新鲜度提示，再解释当前结果。五阶段后进入页面「自测与迁移练习」或[自测文档](self-check.md)，用[实验记录模板](experiment-record-template.md)整理证据，再独立完成[资料审核迁移作业](../exercises/01-transfer/01.01-document-review/problem/readme.md)。页面作答和手工笔记会尝试保存在当前浏览器，刷新后可继续；存储不可用时会提示导出。重要笔记请导出备份，恢复向导的临时观测记录仍只保留在本次页面中。

## 阶段一：正常订单与角色分工

**学习目标**：能说明浏览器、API / Client、Temporal Server、Worker 的职责，区分 Workflow 的编排和 Activity 的具体执行；用 Query 观察业务状态，用 History 追溯发生过的事实。

**先预测**：创建请求返回后，订单是否已经发货？收到确认 Signal 的回执，能否据此断定订单已经完成？

**操作入口与步骤**：

1. 在学习页面创建订单，选择「正常处理」，保留初始 120 秒确认等待时间。记下返回的 Workflow ID / Run ID。
2. 等库存、付款成功，看到「等待人工确认」。打开「深入观察 → 状态 JSON」查看 `orderState` Query 中的 `status: waiting_approval`；主面板的 Temporal 执行状态此时仍为 `RUNNING`。
3. 点击「前往确认」或「确认 / 取消」，保持默认 **Signal**，点击「发送确认 Signal」。观察 `status: sent` 收件回执，再继续等发货步骤结束。
4. 等业务状态为 `completed`、Temporal 执行状态为 `COMPLETED`，打开「事件历史」回看同一次 Run。完整事件属性可在页面链接的官方 Temporal UI 查看。

**观察证据**：

| 要确认的事实 | 去哪里看 |
| --- | --- |
| 库存、付款成功结果已经记入历史 | 找 `reserveInventory`、`chargePayment` 对应的 `ActivityTaskScheduled / Completed`；页面关联活动名称，官方 UI 可查看结果 Payload |
| 订单曾经持久化等待，随后收到确认 | `TimerStarted`、名为 `approveOrder` 的 `WorkflowExecutionSignaled`，以及正常确认后的 `TimerCanceled` |
| 发货和整个执行完成 | `shipOrder` 的成功事件、物流单号与 `WorkflowExecutionCompleted`，配合最终 Query / Describe 状态 |

页面按顺序展示事件及 `#ID`；完整属性或 Payload 到官方 Temporal UI 查看。「源码与证据」中的 History 引用可按 ID 跳到对应事件。把同一活动的调度与完成事件关联起来，而不是要求每两条业务事件紧邻出现；其间还有 Workflow Task。`WorkflowTaskCompleted` 只表示一轮编排提交完成，整个执行的完成事件是 `WorkflowExecutionCompleted`。Signal 回执只说明 Server 已接收，不等待业务 handler，也不能靠回执与 handler 的先后判断是否发货。Query 是只读观察，不会代替确认，也不产生一条持久化的确认消息事件。

**对照文档与源码**：[执行流程](temporal-execution-flow.md)第 1–3 节解释角色、启动与两类任务，第 5.1 / 5.3 节解释 Signal / Query，第 6 / 9.1 节解释 Timer 与 History。源码沿 [API 的 `POST /api/orders` / `workflow.start`](../server/index.ts) → [Worker 注册](../server/worker.ts) → [Workflow 的库存、付款、`condition`、发货主干与 Signal / Query handler](../server/workflows.ts) → [Activity 函数体](../server/activities.ts) 阅读；输入与常量按需查 [shared/types.ts](../shared/types.ts)。

配套[源码分层阅读顺序](source-evidence-guide.md#先找到执行链路再分层读函数)与[正常订单证据](source-evidence-guide.md#正常订单谁决定付款后等待确认后发货)，在新标签核对真实摘录，原「核心代码概念」仍用于概念教学。

**用自己的话解释**：API 启动执行，Server 保存历史并调度任务，Worker 运行 Workflow 和 Activity；Workflow 决定下一步，Activity 执行具体操作。用这条分工解释为什么创建请求和 Signal 回执都不能代表订单完成。随后进入 Worker 恢复课。

## 阶段二：等待确认时停止重启 Worker

**学习目标**：亲眼观察 Worker 停机后 Server 仍可保存 Signal，Worker 重启后恢复同一个 Run；理解 History、重放重建变量与已记录 Activity 结果复用。

**先预测**：Worker 的内存丢失后，库存、付款完成的事实在哪里？停机时谁保存 Signal？重启为什么不必再扣一次款？

**操作入口与步骤**：

本课复用页面的「Worker 恢复实验 → 等待确认时重启」。**全部准备条件、进程操作和判定边界以[恢复向导第 1、2、4 节](worker-recovery-guide.md)为准。** 进程控制使用向导已有的独立 `npm run worker:recovery`，无热重载；按向导拆分进程并保证任务队列只有一个 Worker，保持 Temporal、API、前端运行。

1. 按向导创建等待确认实验订单，使用 `normal` 场景、300 秒确认期限。等库存、付款完成，满足向导的 `waiting_approval`、新鲜 Query、`RUNNING` 和付款基线条件后，保存实验前快照。
2. 按向导在独立 Worker 终端停止进程，并记录操作。**先等向导取得同一个 Run 仍为 `RUNNING`、Query 不可用的响应，并保存停机 History 边界 `#N`；看到边界前不要发确认。** 请求可能约 4–6 秒后返回。
3. 保持 Worker 停止，在向导链接的官方 UI 中选择 `More Actions → Send a Signal`，发送无参数 `approveOrder`。等待向导在停机阶段的后续响应中认证事件 ID 大于 `N` 的 Signal。
4. 认证 Signal 已入库后，按向导重新运行 `npm run worker:recovery`，记录重启并等待新鲜响应核对。观察同一个 Workflow ID / Run ID 恢复、发货和完成。

停机时通过官方 UI 发送 Signal 的原因是：本项目普通确认 API 先做 Query，Worker 不在时可能失败。不要用该 API 的失败推断 Server 无法收件。Timer 在停机期间仍计时；操作过慢可能走超时补偿，应保留实际结果，按原向导处理或重做。顶部健康状态和“已停止 / 已重启”按钮都不能单独证明恢复成功。

**观察证据**：同一个 Workflow ID / Run ID；Query 中断和后续恢复；中断边界后的停机 Signal；该 Signal 之后的 Workflow Task 完成和最终 `COMPLETED`；原库存、付款完成事件仍在，基线之后没有新增对应调度；独立账本的付款调用次数、扣款次数与金额不增加，没有退款。缺少停机或入库证据时保持待观察，不能只凭“最后完成了”判断实验成功。

**用历史解释恢复**：

- **Server 保存 History。** 输入、Activity 完成结果、Timer、Signal 等持久化事件在 Server，Worker 普通内存消失不会删除这些历史。
- **Worker 重放编排。** SDK 在新 Worker 中沿确定性的 `orderWorkflow` 代码恢复状态，`state`、`inventoryReserved`、`paymentCharged` 等变量随相同路径重新建立；Server 不会把原进程的 JavaScript 堆直接搬回来。
- **已记录成功结果被复用。** 重放遇到已经完成并记入历史的库存、付款 `await`，SDK 使用历史结果推进，不会仅因重放再调用对应 Activity 函数体。
- **缓存与重试边界仍在。** 运行中的 Worker 有 Workflow 缓存，并非每个 Workflow Task 都从入口完整重放。历史结果复用也不等于 Activity 绝不重跑：业务效果已发生但成功结果未被 Server 记录，或 Activity 按策略重试时，仍可能真实再执行，因此外部操作需要幂等。这正是下一阶段要观察的问题。

**对照文档与源码**：[Worker 恢复实验向导](worker-recovery-guide.md)是操作依据；[执行流程第 8 节](temporal-execution-flow.md#8-worker-重启后为什么能接着执行)解释重放。源码先看 [worker.ts](../server/worker.ts) 的注册和进程入口、[workflows.ts](../server/workflows.ts) 的局部变量与主干；再按需追 [index.ts](../server/index.ts) 中 Query 结束后读取 History 的顺序、[history.ts](../server/history.ts) 的真实事件关联，以及 [RecoveryGuide.tsx](../src/components/RecoveryGuide.tsx) / [recovery.ts](../src/recovery.ts) 的基线和证据保护。

配套[Worker 恢复源码与证据](source-evidence-guide.md#worker-恢复哪些结果来自旧历史哪些步骤在重启后推进)。新标签解释当前 detail，跨请求的停机窗口和恢复判定仍以原向导为准；Query 不可用本身不等于 Worker 进程停机。

**用自己的话解释**：用本次记录指出“历史在哪里”“变量如何回来”“哪些活动结果被复用”，再给出一种 Activity 仍可能重跑的情况。

## 阶段三：重试、超时与幂等

**学习目标**：区分同一个 Activity 的多次尝试、Workflow 编排恢复和业务副作用；认识重试上限、持久化确认 Timer，以及结果不确定时的幂等处理。

**先预测**：付款重试会重新预留库存吗？Worker 停机是否让确认期限暂停？一次付款 Activity 被调用两次，是否一定扣两次款？

**操作入口与步骤**：每个场景创建新订单，顺序做三组。

1. **自动重试**：选择「自动重试」，观察前两次付款故意失败、第 3 次成功，再用默认 Signal 确认完成。查看付款成功时的 attempt 和库存事件。
2. **等待超时**：选择「等待超时」，保持不确认。该场景由 API 固定为 15 秒，从付款成功、开始等待确认时计时。等待 `TimerFired`、退款与释放库存，以及最终 `FAILED`。想进一步观察重试耗尽，可另建「失败与补偿」订单，看 3 次付款尝试后进入失败清理。
3. **支付幂等**：选择「支付幂等」，观察第一次扣款已入账后故意失败、第二次尝试复用原付款；查看支付账本，等付款成功后默认 Signal 确认并完成订单。

**观察证据**：自动重试最终的 `ActivityTaskStarted.attempt` 为 3，库存未因付款重试重新调度；超时路径有 `TimerFired`、补偿 Activity 和执行失败；幂等场景账本为付款调用 2 次、实际模拟扣款 1 次，并有幂等命中记录。Activity 中间重试可能被 History 聚合，不要求每次尝试都有独立的 `Started / Failed` 事件对；结合最终 attempt、Worker 日志和官方 UI Pending Activities 阅读。最大尝试次数包含首次执行。

这三组使用不同层面的证据：History 说明编排和记录的结果，账本说明模拟支付系统的业务效果；HTTP 等待截止与业务 Timer 也不同。Temporal 没有与支付账本共享原子事务，重试可能真实调用 Activity，稳定幂等键使重复调用复用同一业务效果。重复创建订单仍会生成新的 Workflow ID，不属于同一支付幂等范围。

**对照文档与源码**：[执行流程第 4、6、8.2 节](temporal-execution-flow.md)解释重试、Timer 与结果不确定性；[幂等、心跳与补偿实验第 3 节](reliability-experiments.md#3-实验二activity-调用两次为什么只扣一次款)提供幂等实操。源码看 [workflows.ts](../server/workflows.ts) 的 Activity 选项与确认 `condition`、[activities.ts](../server/activities.ts) 的 `chargePayment` 故障注入、[payment-ledger.ts](../server/payment-ledger.ts) 的稳定键和事务，以及 [validation.ts](../server/validation.ts) 的超时场景归一化。

配套[重试](source-evidence-guide.md#重试attempt-解释了哪一次执行)、[确认超时](source-evidence-guide.md#确认超时timerfired-为什么让订单走补偿)与[幂等](source-evidence-guide.md#幂等付款调用两次为什么账本只扣一次)的源码和字段对照。账本按 Workflow ID 聚合，不能当作某一 Run 的独立流水。

**用自己的话解释**：用本次 attempt 与账本记录解释“调用次数”和“扣款次数”的区别；再解释为什么已记录成功结果的重放和未确认完成的重试是不同机制。

## 阶段四：取消、补偿与心跳

**学习目标**：理解取消请求、业务清理和执行终态不是同一时刻；区分 Workflow 重放与未完成 Activity 基于心跳检查点的新尝试。

**先预测**：点击取消会立刻结束外部操作吗？业务显示已取消而 Temporal 仍为 `RUNNING` 是否一定错误？心跳检查点是否等于进程退出瞬间的全部内存？

**操作入口与步骤**：

1. 创建「正常处理」订单，等付款完成、等待确认时取消。观察退款、释放库存，再等 Temporal 最终为 `CANCELLED`。
2. 创建「长任务心跳」订单，用默认 Signal 确认，观察分批打包的当前尝试、已保存批次和最后心跳；在打包进行中取消，继续观察补偿与终态。
3. 创建「心跳超时恢复」订单，确认后让故障自动发生。第一次尝试在第 3 批附近暂停心跳，等待 Server 的 5 秒心跳超时和后续尝试，观察从已保存批次继续并最终完成。
4. 完成上述观察后，再做现有「Worker 恢复实验 → 打包期间崩溃」。**只按[恢复向导第 3 节](worker-recovery-guide.md#3-实验二打包期间崩溃)执行准备、检查点保存和进程操作**：使用 `heartbeat` 场景与独立 `worker:recovery`，操作终端打印的真实 Worker PID。该实验使用强制结束；普通 `Ctrl+C` 有退出宽限期，短任务可能先完成。

**观察证据**：

- 取消之后可能先看到业务 `cancelled`、Temporal `RUNNING` 和进行中的补偿；退款、释放库存完成后才到 `CANCELLED`。最终对照取消请求、Activity 与补偿事件、账本退款和执行终态；补偿失败也要保留事实。
- 运行中的心跳来自 Describe 的 Pending Activities；Activity 成功返回后，最终打包结果才进入 Query 的 `state.packing`。不要要求每批都产生 History 事件或页面逐批刷新。
- 恢复时检查新尝试号与心跳 Payload 的 `attempt` 是否一致，再判断 `resumedFrom` 与已完成批次；旧尝试的心跳不能冒充新尝试的恢复证据。手工崩溃实验还需按向导核对同 Run、停机窗口、检查点、付款未重新调用和最终结果。

心跳只保存 Server 最近收到的检查点，受发送节流和轮询延迟影响；最后若干批可能再次执行，真实批次副作用仍需幂等。取消是协作式的，补偿由应用代码显式安排；它不会把已经发生的外部效果自动回滚。本例打包只有等待和心跳，没有真实物理打包。

**对照文档与源码**：[幂等、心跳与补偿实验第 2、4 节](reliability-experiments.md)是取消、心跳与自动超时恢复的实操依据；[Worker 恢复实验向导](worker-recovery-guide.md)提供打包崩溃的完整条件。源码看 [workflows.ts](../server/workflows.ts) 的 `compensate`、取消分支与 `CancellationScope.nonCancellable`，[activities.ts](../server/activities.ts) 的 `packOrder`、`heartbeatDetails`、heartbeat / sleep，以及 [pending-activities.ts](../server/pending-activities.ts) 的检查点读取。需要追页面证据时再看 [WorkflowPanel.tsx](../src/components/WorkflowPanel.tsx) 和 [recovery.ts](../src/recovery.ts)。

配套[取消与补偿](source-evidence-guide.md#取消与补偿为什么业务已取消执行仍在-running)及[心跳检查点](source-evidence-guide.md#心跳新尝试从哪个检查点继续)，先确认新鲜度与 attempt 匹配，再解释当前打包进度。

**用自己的话解释**：用一次取消记录说明为何业务状态可以先变化；再用一次打包恢复记录区分“Workflow 重放恢复编排变量”和“Activity 新尝试读取心跳继续”。

## 阶段五：Signal / Update 深入对照

**学习目标**：在已理解基础运行与恢复的前提下，比较 Signal 的收件语义、Update 的校验与业务结果，以及 Query 的只读观察；理解结果未知和同 Run / Update ID 的处理边界。

**先预测**：Update 确认成功是否等于订单已经发货？HTTP 等待超时是否说明 Update 没有生效？validator 拒绝后是否一定能在 History 找到 Accepted / Completed？

**操作入口与步骤**：

1. 按[订单确认对照文档](signal-update-comparison.md)创建两条新的正常订单，分别等到 `waiting_approval`；一条保持默认 Signal，另一条选择 Update。
2. Signal 订单观察 `status: sent`，继续对照 Query、确认事件、发货和最终完成。
3. Update 订单先不勾选核对复选框，发送真实校验拒绝请求；观察 `ApprovalConfirmationRequired` 和继续等待的业务状态。随后勾选，按页面策略用新的 Update ID 提交，观察 handler 的真实返回结果。
4. 对照本次 Run / Update ID 在 History 中的 Accepted / Completed。若实际出现 `unknown`，按现有页面保留的原 Run ID、Update ID 与参数，查询原结果或重试同一请求；完整接口操作、复用范围和保留期见对照文档，不需另造停机步骤来制造未知结果。

**观察证据**：Signal 的 `WorkflowExecutionSignaled` 表示 Server 已保存消息；Update 成功返回 `status: approved` 并有对应 ID 的 Accepted / Completed，但仍需另外查看发货与 Workflow 完成。Completed 的 outcome 也可以是失败，事件名本身不能证明 handler 成功。validator 在接受前拒绝时通常没有这两类事件，以页面真实反馈与 HTTP 回执为依据，不能为了对照补造记录；Admitted 是否出现以实际 History 为准。Query 不执行确认，也不产生对应的持久化业务消息事件。

Update 的 `unknown` 只说明本次 HTTP 等待未拿到确定答案，不能推断取消或未生效。同 ID 重试与结果复用限于同一个 Run、同一个 Update ID 及服务端保留范围，不能替代支付幂等，也不能把 validator 拒绝 ID 当作已持久化的拒绝结果依赖。等待 Worker 处理的 Update 与第二阶段停机时 Server 先保存 Signal 的实验语义不同。

**对照文档与源码**：[Signal、Update 与 Query：订单确认对照](signal-update-comparison.md)包含完整页面实验、返回语义、HTTP 契约、未知结果恢复与去重边界。源码看 [workflows.ts](../server/workflows.ts) 的 `applyApproval`、validator 和 handler，[index.ts](../server/index.ts) 的 Signal 与 Update POST / GET，[history.ts](../server/history.ts) 的真实事件转换；再看 [ApprovalComparison.tsx](../src/components/ApprovalComparison.tsx)、[App.tsx](../src/App.tsx)、[api.ts](../src/api.ts) 和 [shared/approval.ts](../shared/approval.ts) 的请求标识与反馈处理。

配套[Signal 收件与业务确认](source-evidence-guide.md#signal收件与业务确认如何对应)和[Update outcome 对照](source-evidence-guide.md#updatecompleted-是否意味着确认成功)，把当前回执、同 Run / Update ID 的事件与后续发货分别核对。

**用自己的话解释**：按“调用返回什么、谁执行、持久化什么、结果未知怎么办”比较 Signal、Update、Query，并分别指出它们为什么不能代替整个订单的完成证据。

完成五阶段后，先在页面「自测与迁移练习」回答 10 个开放题，再展开参考要点自行核对；[自测文档](self-check.md)也提供题目索引和解释。用[实验记录模板](experiment-record-template.md)记录预测、同 Run 证据和结论边界，或从页面导出本次草稿。随后进入[资料审核迁移作业](../exercises/01-transfer/01.01-document-review/problem/readme.md)，先独立实现并按 CLI 验收，再查看参考解释。页面不自动评分，也不会替你执行练习命令；已读标记仅记录当前浏览器的阅读选择，不代表完成实验。
