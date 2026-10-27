# Temporal 实验记录模板

复制本文件到自己的笔记中填写，或使用页面「自测与迁移练习 → 实验记录」手工填写并导出 Markdown。模板不读取运行数据，也不评定通过；空缺保留为“尚未观察到”，不要把示例值当作证据。

## 1. 操作前预测

- 学习问题 / 场景：
- 预计发生的结果：
- 为什么会这样，关联哪段 Workflow / Activity：
- 什么观察会推翻这个预测：

## 2. 执行与环境

- 记录人 / 日期 / 时区：
- Workflow Type：
- Workflow ID（完整）：
- Run ID（完整）：
- namespace / Task Queue：
- 使用的代码版本或本地修改说明：
- 业务输入与场景参数：
- Worker 进程与启动方式（只在恢复实验中填写）：
- 账本路径与归集范围（Workflow ID 或其他业务键）：

## 3. 实际操作

按实际发生的时间填写。进程停止、消息发送等是操作记录；是否被 Server 接收、是否被业务接受，需要后续证据说明。

| 时间与时区 | 操作 | 请求回执 / 进程输出 | 尚不能确认什么 |
| --- | --- | --- | --- |
| 待填写 | 待填写 | 待填写 | 待填写 |

## 4. 逐条观察与来源

不同响应、不同来源分别记。`observedAt` 是响应观测时间，Query 的 `updatedAt` 是业务快照更新时间；两者含义不同。同一次 Describe、Query、History、SQLite 读取也不是原子快照。

| 观测时间 / 新鲜度 | 来源 | 范围与引用 | 实际值 / 失败信息 | 能说明什么 |
| --- | --- | --- | --- | --- |
| 待填写 | History | 同 Run 的 #ID、type、activityType / Signal / Update ID | 待填写 | 待填写 |
| 待填写 | Query | status、approvedAt、approvalMethod、compensationProgress、packing 等 | 待填写 | 待填写 |
| 待填写 | Describe | 执行状态、Pending state / attempt、lastHeartbeatAt | 待填写 | 待填写 |
| 待填写 | 业务账本 | Workflow ID、稳定幂等键、流水 ID | 调用 / 写入或扣款 / reused / 清理 | 待填写 |
| 待填写 | HTTP / CLI 回执 | Workflow ID / Run ID / Update ID、原参数 | 成功 / 拒绝 / unknown 及消息 | 待填写 |

### 按实验补充

- **重试 / 幂等**：首次与最终 attempt、History 中间事件是否聚合、真实业务调用次数、实际效果次数、`reused`；流水 ID 不等于 History #ID。
- **确认超时**：确认 `approvalDeadline` 或练习的 `reviewDeadline`；关联等待 Timer 的 Started / Fired，补偿与执行终态；说明 HTTP 截止的独立范围。
- **取消 / 清理**：取消回执、CancelRequested、业务状态、每项清理结果、账本变化、最终执行状态；清理失败也保留原记录。
- **心跳**：Pending state / attempt、heartbeat.attempt、completedBatches、resumedFrom、lastHeartbeatAt；先匹配当前 attempt，完成后再读新鲜 Query 的最终结果。
- **Signal / Update**：原回执、同 Run 的 Update ID 和原参数、Accepted / Completed 的 outcome、Query 的业务确认、后续步骤结果；没有事件就保留缺口。

## 5. 恢复实验的前后对照

订单的手工停机只按[原 Worker 恢复向导](worker-recovery-guide.md)执行；资料审核练习按[独立题目说明](../exercises/01-transfer/01.01-document-review/problem/readme.md)操作自己的练习 Worker。不要停止其他队列的 Worker。

- 停机前同 Run 的新鲜基线、已成功 Activity #ID、账本调用 / 效果次数：
- 实际停止的 PID / 时间与退出确认：
- 停机响应：Describe 状态、Query 不可用错误、History 边界 #N：
- 该边界之后入库的 Signal #ID、停机期间是否已有后续 Workflow Task 完成：
- 重启 PID / 时间、同一实现与队列：
- 同 Run 的 Query 恢复、Signal 后 Workflow Task、后续 Activity 和执行终态：
- 基线后是否新增已成功活动的调度、调用或业务效果；证据：
- 若缺停机窗口、Signal 入库或同 Run 证据，结论写“尚不能确认”，说明重做条件：

## 6. 用机制解释差异

- 预测与结果有哪些一致 / 不一致：
- 哪些结果从 History 复用，哪些是 Activity 新尝试：
- 哪些证据属于业务系统的实际效果，为什么需要稳定幂等键：
- 哪段编排决定等待、继续、失败或补偿：
- 清理为什么也要处理“已经尝试但结果未知”：

## 7. 结论与缺失证据

- 我能用上述证据支持的结论：
- 尚缺的数据、过期来源或相互不一致的观察：
- 当前记录不能证明的事：
- 下一次如何获取缺失证据或推翻自己的解释：

核对边界：Query 不可用不独立证明进程停机；整个请求失败时保留数据都已过期；同次响应非原子；账本范围可能按 Workflow ID；Signal 收件不等于业务接受；Update Completed 可能失败；最后成功不单独证明恢复或外部效果只执行一次。
