# 迁移练习：资料审核

把已经学过的 Temporal 编排迁移到一份新的本地资料业务。先完成 [problem/workflow.ts](problem/workflow.ts) 中的 TODO，再用下方步骤独立验收。此页给出题目、接口和观察标准；参考实现放在单独的 `solution/` 里。

练习不调用支付、邮件或外部业务服务。唯一业务效果是本机 SQLite 中资料的准备、归档、清理；原有订单业务继续使用自己的队列和账本。

## 开始前

从仓库根目录执行命令，使用已有 Node 和依赖。需要可连接的 Temporal Server；已有服务运行时直接复用。连接参数复用 [server/config.ts](../../../server/config.ts) 的公开配置，支持根 `.env`、`TEMPORAL_ADDRESS` 和 `TEMPORAL_NAMESPACE`，默认 `127.0.0.1:7233` / `temporal-learning`。namespace 应提前存在。

| 设置 | 本练习约定 |
| --- | --- |
| Task queue | `temporal-learning-document-review`，与订单队列独立 |
| 默认数据库 | 仓库根 `.data/document-review.db` |
| 自定义数据库 | `DOCUMENT_REVIEW_DB_PATH=/absolute/path/document-review.db`；Worker 与所有 CLI 使用同一路径 |
| Workflow 名称 | `documentReviewWorkflow`，两个版本相同 |
| Worker 进程 | 无热重载；就绪时打印真实 PID；`Ctrl+C` / `SIGTERM` 由 SDK 优雅关闭 |

每次只运行一个练习 Worker。不要让 `problem` 和 `solution` 同时消费这个队列，也不要用订单 Worker 代替。CLI 有按地址、namespace、task queue 隔离的本机互斥锁，已有锁时拒绝第二个练习 Worker；它不代替多机器部署的协调。不同地址别名或绕过 CLI 启动的 Worker 也需人工核对。正常退出会释放锁；异常退出留下锁时，错误会给出锁内 PID 和具体路径，只有人工确认没有练习 Worker 后才删除该锁，不会自动抢占。

## 题目与契约

只需编写自己的 `problem/workflow.ts`；[共享类型](support/types.ts)、[本地活动](support/activities.ts)、[SQLite 存储](support/store.ts)、[CLI](support/runner.ts) 已提供。`problem/main.ts` 和 `solution/main.ts` 仅把 Workflow 文件位置传入同一个 runner。

```ts
documentReviewWorkflow({
  documentId: 'material-001',
  reviewTimeoutSeconds: 300,
  losePrepareResponse: false,
}): Promise<DocumentReviewState>
```

- `documentId`：1–100 个文字、数字、下划线、点或连字符。
- `reviewTimeoutSeconds`：1–3600 的整数；准备完成后开始审核计时。
- `losePrepareResponse`：可选；仅第一次资料写入提交后故意抛可重试错误。后续重试应复用既有资料。
- `approveDocument`：无参数 Signal；仅在 `waiting_review` 接受第一次确认，提前或重复 Signal 忽略。
- `documentReviewState`：Query 返回 `workflowId`、`runId`、`documentId`、业务 `status`、`prepareAttempted`、`prepareCompleted`、`reviewDeadline`、`approvedAt` 和 `cleanup`。
- `prepareDocument`、`archiveDocument`、`cleanupDocument`：活动契约见共享类型。最多 2 次尝试，包含首次调用；`attempt` 用于审计，不用作业务幂等键。

你要实现：准备资料 → 等人工 Signal 或审核超时 → 确认后归档；失败、超时、协作取消后清理已尝试准备的资料。结果未知时也必须查账，清理应在取消屏蔽作用域里完成。成功返回 `completed` 状态；失败与超时抛 nonretryable failure，协作取消在清理后抛 `CancelledFailure`。清理失败不能显示成已清理。

未实现时 `problem` 明确以 `DocumentReviewNotImplemented` 失败，Query 为 `not_implemented`，不会写资料或伪造成功。改好后创建新 Workflow 验收；已经失败的占位执行不会因为改文件自动重跑。

业务状态与执行状态分开看：`cleaning_up` 期间 Temporal 仍可为 `RUNNING`；业务 `cancelled` 必须再由 Describe `CANCELLED` 和 `result` 的取消失败确认。审核超时在本练习中是业务失败，Temporal 为 `FAILED`，不是执行级 `TIMED_OUT`。

## 命令

终端 A 独立启动题目 Worker：

```bash
npm run exercise:review -- worker
```

终端 B 创建执行，保存输出中的完整 `workflowId` / `runId`，再把它们填入自己的 shell 变量：

```bash
npm run exercise:review -- start --document material-001 --timeout 300

# 用本次 start 的真实输出替换，不要省略或截断 ID。
WF='document-review-problem-替换为完整ID'
RUN='替换为完整RunID'
npm run exercise:review -- inspect "$WF" "$RUN"
```

完整命令表：

```bash
npm run exercise:review -- --help
npm run exercise:review -- worker
npm run exercise:review -- start --document material-001 --timeout 300 --lose-response
npm run exercise:review -- inspect "$WF" "$RUN"
npm run exercise:review -- approve "$WF" "$RUN"
npm run exercise:review -- cancel "$WF" "$RUN"
npm run exercise:review -- result "$WF" "$RUN"
```

`start` 的 `--timeout` 默认 300 秒；其余命令必须提供两个执行 ID。`approve` 直接发 Signal，不做 Query 前置校验。`cancel` 提交协作取消请求；两者的命令返回都不表示业务已完成。`result` 最多等 15 秒，仍在运行时会报 RPC deadline，可以稍后再次执行；它不会因为命令等待超时而取消 Workflow。失败/超时/取消的 `result` 会输出失败原因并以非零状态退出，这是预期验收结果。

没有根 npm 脚本时可直接运行，所有参数相同：

```bash
npx tsx exercises/01-transfer/01.01-document-review/problem/main.ts worker
npx tsx exercises/01-transfer/01.01-document-review/problem/main.ts start --document material-001 --timeout 300
npx tsx exercises/01-transfer/01.01-document-review/problem/main.ts inspect "$WF" "$RUN"
```

命令发送的编排名称相同，实际代码由当前 Worker 决定。不要仅按 Workflow ID 的 `problem` / `solution` 前缀认定执行了哪个版本。切换版本时先让当前执行结束，再退出当前练习 Worker，然后启动另一个版本；恢复验收始终重启同一个版本。

## 如何阅读 inspect

输出同时保留成功数据和各数据源的独立错误：

| JSON 字段 | 查看内容 |
| --- | --- |
| `description.value` | Describe 的 Workflow ID、Run ID、Temporal 执行状态、类型、队列 |
| `query.value` 或 `query.error` | 本次新鲜 Query 的业务状态，或约 2 秒 RPC 时限内未能查询的错误；不回退缓存 |
| `history.value.lastEventId` | 本次真实历史的最后事件 ID，可作为停机观察边界 |
| `history.value.events` | 真实 `eventId`、Temporal `EVENT_TYPE_*` 类型；活动的 `activityId`、`activityType`、`scheduledEventId`、可用的 `attempt`；Signal 名称 |
| `ledger.value` | 独立只读 SQLite 的路径、`idempotencyKey`、资料内容/状态、计数、审计 `entries` |
| 每个来源的 `observedAt` | 该来源本次读取结束的观察时间 |

History 在 Query 成功或失败之后读取，Worker 停止时仍可以查看 Server 已持久化的事件和 SQLite。账本审计的 `runId`、`activityId` 可以与 History 的活动关联。`prepareAttempts` 数活动实际调用，`prepared` 数真实资料写入，`reused` 数复用，`archived` 数归档效果，`removed` 数实际清理，不能互相代替。

**证据边界**：Describe、Query、History、SQLite 分别读取，不构成跨系统原子快照；短暂不一致时再次 inspect。SQLite 幂等键 `${workflowId}:prepare` 和统计按 Workflow ID 跨 Run 聚合，Temporal History 按指定 Run 读取。CLI 每次生成新 Workflow ID，禁止重复使用；不要把其它 Run 的账本效果解释成当前 Run 的活动执行。Activity 重试可能被 Temporal 合并进后续 Started 事件，不能要求 History 为每次调用都提供一条独立 Started；实际尝试还需看 SQLite 审计。

## 验收一：正常完成

1. 终端 A 运行已实现的 `problem` Worker。终端 B `start --document normal-001 --timeout 300`，保存新的 `WF` / `RUN`。
2. `inspect "$WF" "$RUN"`，等待 Query `waiting_review`、`prepareCompleted=true`，账本 `prepareAttempts=1`、`prepared=1`、`archived=0`、`removed=0`。保存 `reviewDeadline`；此时未收到确认，`approvedAt` 应缺失。
3. `approve "$WF" "$RUN"`，然后 `result "$WF" "$RUN"` 和 `inspect "$WF" "$RUN"`。
4. 验收：同 Run 的 Describe `COMPLETED`、Query/返回值 `completed`、`approvedAt` 有值、`cleanup.status=idle`；账本 `prepared=1`、`archived=1`、`removed=0`，History 存在该 Signal 以及准备/归档的真实调度与完成事件。

以上步骤中的命令都以 `npm run exercise:review --` 为前缀，例如 `npm run exercise:review -- approve "$WF" "$RUN"`。

## 验收二：等待时 Worker 恢复

1. 确保练习队列仅有终端 A 的一个练习 Worker，使用 `start --document recovery-001 --timeout 600` 创建新的执行。保留输出的两个 ID，整个实验都使用它们。
2. 等 `inspect` 显示新鲜 Query `waiting_review`、`prepareCompleted=true`、Describe `RUNNING`，且无确认 Signal / `approvedAt` / 归档调度。保存基线：Run ID、prepare 完成事件的 `eventId`、账本 `prepareAttempts=1` / `prepared=1` / `archived=0` / `removed=0`。
3. **仅在终端 A 按 Ctrl+C 并等待该练习 Worker 退出。** 不停止 Temporal、API、订单 Worker 或其他服务。核对退出的是终端打印的本练习 PID；不要操作示例 PID。
4. 保持该 Worker 退出，在终端 B `inspect "$WF" "$RUN"`，应仍为同 Run / `RUNNING`，Query 超时不可用，但 History / SQLite 可读。记录这次 `history.value.lastEventId=N`。若 Query 始终可用，核对其他练习 Worker，不要继续声称已建立停机证据。
5. **保存这次中断边界后**，仍不启动 Worker，执行 `approve "$WF" "$RUN"`。直接 Signal 不需要 Query。
6. 再 `inspect`：在同 Run 的真实 History 中找到 `signalName=approveDocument` 的 `EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED`，其 `eventId>N`。此时 Query 仍不可用、Describe 仍 `RUNNING`、归档数仍 0。Signal 入库只证明 Server 接受；handler 还没有处理。
7. 终端 A 重跑原来的 `worker` 命令，使用**同一版本、同一 namespace、同一数据库**。`result` / `inspect` 直到完成。
8. 验收：Workflow ID 和 Run ID 均保持；Describe `COMPLETED`，Query `completed`；原 prepare 完成事件仍在，只有一次 prepare 调度，基线之后没有新增 prepare 调度；Signal 后出现 Workflow Task 完成与归档；账本准备调用/实际写入仍是 1/1，归档为 1，清理为 0。

审核 Timer 在 Worker 停机时不会暂停；不要把等待耗尽导致的超时清理解读为恢复成功。若在截止边缘发 Signal，最终分支应以持久化历史和实际执行结果为准。Query 失败可能来自网络或调度，本身不证明某 PID 退出；终端进程证据和上述业务证据需一起记录。自动测试使用优雅关闭后的新 Worker 验证这一机制，并不冒充验证了操作系统强杀。

## 验收三：写入结果未知与业务幂等

1. Worker 保持运行，新建 `start --document lost-response-001 --timeout 300 --lose-response`。
2. 保存新的 ID，重复 `inspect`，直到 Query 为 `waiting_review`。首次提交后会模拟 `PrepareResponseLost`，大约 2 秒后重试；这是故障注入的预期日志。
3. 确认账本 `prepareAttempts=2`、`prepared=1`、`reused=1`；`response_lost` 仅一条，两次 `prepare_attempt` 的 attempt 为 1、2，但幂等键相同。资料只有一份，不能靠内存变量去重。
4. 发 Signal 并等待完成，最终 `archived=1`、`removed=0`。结合 History 与账本观察：工作流重试机制不等于业务效果恰好一次。

取消发生在准备结果未知的窗口时，还必须查账清理。下方自动验收在真实首次提交丢响应之后，确定性地卡住第二次响应再取消，验证 `prepareCompleted=false` 仍 `removed=1`；手工抢 2 秒窗口不作为可靠验收。

## 验收四：协作取消后的清理

1. 新建 `start --document cancel-001 --timeout 300`，保存新 ID；等待 `waiting_review` / `prepared=1`。
2. `cancel "$WF" "$RUN"` 只提交取消请求；接着 `result "$WF" "$RUN"` 应报取消失败。
3. `inspect` 验收 Describe `CANCELLED`，Query `cancelled`、`cleanup.status=completed`、`cleanup.outcome=removed`；账本 `removed=1`、`archived=0`，`document.status=removed`、`document.content=null`。
4. History 中应有取消请求、cleanup 活动及执行取消终态。不要把短暂 `cleaning_up` 或命令“请求已提交”当作清理完成。

## 验收五：审核超时后的清理

1. 新建 `start --document timeout-001 --timeout 3`，保存新 ID，不发送确认。
2. `result "$WF" "$RUN"` 应以 `DocumentReviewTimedOut` 失败；`inspect` 应有持久化 Timer 触发和 cleanup 活动。
3. 验收 Describe `FAILED`，Query `timed_out`、`cleanup.status=completed`；账本 `prepared=1`、`removed=1`、`archived=0`、资料内容已清空。

若清理活动自身失败，正确结果是业务 `failed`、`cleanup.status=failed` 和 Temporal `FAILED`，错误类型 `DocumentCleanupFailed`；不能声称已经清理或正常取消。修复存储故障后需要人工处置，不能靠改 Query 文案掩盖。

## 自动验收

参考版本的真实集成测试：

```bash
npm run test:exercise
# 不依赖根脚本：
npx tsx --test tests/document-review.test.ts
```

自己的题目实现使用同一组行为测试：

```bash
DOCUMENT_REVIEW_TEST_VARIANT=problem npm run test:exercise
# 不依赖根脚本：
DOCUMENT_REVIEW_TEST_VARIANT=problem npx tsx --test tests/document-review.test.ts
```

默认测试参考实现及未实现题目的明确失败；选 `problem` 时把所有行为测试切到自己的 Workflow，并跳过占位失败测试。未实现题目跑行为测试应失败。

验收包括 preparing 时的提前确认不生效、首次有效确认进入归档后重复 Signal 不覆盖 `approvedAt`，并在对应 Workflow Task 处理后核对状态，而不是只看 Signal 回执。Query 与终态等待有各自的 RPC 截止时间；超时会报告用例阶段、预期结果、Workflow ID 和最后已观察状态，避免一个漏写的等待分支拖到整组测试截止。

测试只启动一个 `TestWorkflowEnvironment.createLocal()` 临时环境，显式使用 `document-review-test` namespace，使用临时 SQLite、随机 task queue，结束后释放 Worker、环境、数据库；不复用开发服务、不读取用户默认账本或 namespace 测试数据。覆盖正常、丢响应幂等、超时、取消、结果未知后取消查账、归档提交后失败的清理、清理失败显式失败、非法输入、两个 Worker 先后消费并恢复同 Run，以及题目占位失败。另在同一临时服务的专用练习队列验证真实 CLI 子进程，覆盖完整 ID、停机 inspect 读 History/账本、直接 Signal、取消和 result 的失败退出。

<details>
<summary>完成自测后：打开参考设计</summary>

先读 [solution/readme.md](solution/readme.md) 的设计与边界，再按需查看 [solution/workflow.ts](solution/workflow.ts)。参考命令把 `exercise:review` 换成 `exercise:review:solution`；不要和题目 Worker 同时运行。

</details>
