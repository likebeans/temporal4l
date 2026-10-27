# 自行实现资料审核编排

从 [练习题目与验收](../readme.md) 开始；先完成本目录的 [workflow.ts](workflow.ts)，无需打开参考实现。共享的 [类型契约](../support/types.ts)、[活动](../support/activities.ts) 和 [存储](../support/store.ts) 已实现本地业务效果，你负责把它们编排成可恢复的 Workflow。

## 运行入口

从仓库根目录执行：

```bash
npm run exercise:review -- worker
# 在另一个终端：
npm run exercise:review -- start --document my-first-review --timeout 300
```

没有根脚本时，同样可以直接运行：

```bash
npx tsx exercises/01-transfer/01.01-document-review/problem/main.ts worker
npx tsx exercises/01-transfer/01.01-document-review/problem/main.ts start --document my-first-review --timeout 300
```

Worker 打印真实 PID；任务队列固定为 `temporal-learning-document-review`。同一队列只保留一个练习 Worker；不要同时运行参考版本。保存 start 输出的完整 `workflowId` 和 `runId`，后续 `inspect / approve / cancel / result` 都要显式传这两个 ID。命令、独立账本路径和每项验收的完整步骤在练习题目中。

## 实现顺序

1. 保留 `documentReviewWorkflow`、`approveDocument` Signal 和 `documentReviewState` Query 的共享契约。校验输入，并确定提前/重复确认的处理策略。
2. 配置真实活动的超时、最多两次尝试和协作取消。用 `workflowInfo().workflowId` 作为传给活动的稳定业务身份；不要把 attempt、随机数或 Run ID 拼进准备幂等键。
3. 准备后进入审核等待点，用 Temporal 的持久化等待机制等待 Signal 或超时。状态包含确定性的 `reviewDeadline` 和首次有效的 `approvedAt`。
4. 审核通过后归档，并返回已完成状态。
5. 异常路径必须处理“已尝试准备，但没有收到成功结果”。取消屏蔽作用域内清理并查账，记录清理进度后以适当失败/取消结束；不要把业务状态当成 Temporal 执行状态。

保留当前明确占位失败，直到实现各分支；原样运行会收到 `DocumentReviewNotImplemented`，这是题目未完成的信号，不是验收通过。

## 验证自己的实现

```bash
DOCUMENT_REVIEW_TEST_VARIANT=problem npm run test:exercise
# 不依赖根脚本：
DOCUMENT_REVIEW_TEST_VARIANT=problem npx tsx --test tests/document-review.test.ts
```

这会把真实活动行为测试切换到本目录的 Workflow，使用临时 Temporal 环境、随机队列与临时 SQLite。初始 TODO 版本应无法通过。自动验收也检查准备期间的提前 Signal、归档期间的重复 Signal 和首次确认时间。某个分支未结束时，测试会在有限期限后报告阶段、预期结果与最后观察状态，先按该信息定位编排。测试通过后再执行题目中的手工恢复步骤，观察停止单个练习 Worker 时 Query、Signal 和 History 的差异。修改 Workflow 代码后先结束旧执行、退出旧练习 Worker，再重新启动并创建新执行；不要拿不同代码恢复同一 Run。
