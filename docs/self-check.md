# Temporal 自测与迁移

完成[五阶段学习路径](learning-path.md)后，先合上参考解释，用自己的话作答。页面「自测与迁移练习」提供相同的 10 个开放题、草稿输入和折叠参考要点；这里保留便于本地笔记使用的题目索引与验收方式。问题来源见 [learning-practice.ts](../src/learning-practice.ts)。

页面作答和手工笔记会尝试保存在当前浏览器，刷新后可继续；不会上传或跨设备同步。存储不可用时会明确提示，请在离开前用「导出作答与实验记录」保存 Markdown；重要笔记即使已自动保存也建议导出备份。也可以复制[实验记录模板](experiment-record-template.md)到自己的文件。没有学习进度后端和自动评分，已读标记与参考解释不会替代真实运行记录。

## 先作答

每题写出预测、原因和会推翻预测的证据，再运行对应实验；暂时无法取得的观察写“未知”。

| 题目 | 要解释的问题 | 应引用的证据 |
| --- | --- | --- |
| 1. 谁在执行订单？ | 浏览器关闭后流程为何还能继续，API / Server / Worker / Workflow / Activity 如何分工？ | 同 Run 的活动、Signal、Workflow 完成 #ID，以及 Query / Describe |
| 2. 变量怎样回来？ | Worker 内存消失后变量如何重建，已记录成功的付款为什么不重复调用？ | 恢复向导基线、停机边界、停机 Signal、重启后任务与账本对照 |
| 3. 重试会从库存重来吗？ | 付款第三次成功时 await 在等什么，为什么未必有三套失败事件？ | 付款最终 attempt、库存调度、Pending 和账本真实调用 |
| 4. 成功返回之前已经扣款 | 结果丢失后怎样防重复效果，取消时能否只看本地成功变量？ | 稳定幂等键、事务、debit / reused、未知结果查账清理 |
| 5. 两个截止时间 | HTTP 请求超时与确认 Timer 有何区别，Worker 停机时谁计时、谁执行补偿？ | 对应确认期限、关联 Timer、补偿 Activity、最终执行状态 |
| 6. 已取消但还在运行 | 为什么业务取消可先于执行终态，回执是否代表清理完成？ | CancelRequested、逐项补偿、退款流水和最终 CANCELLED |
| 7. 这个心跳属于哪次尝试？ | Pending attempt 2 带 heartbeat attempt 1 能证明什么，批次是否逐条入 History？ | Pending state / attempt、匹配心跳、resumedFrom 与最终 Query |
| 8. 收件、接受与完成 | Signal、Update Accepted / Completed、handler approved 和 Workflow 完成分别说明什么？ | 真实回执、同 ID 历史 outcome、新鲜业务确认与发货 |
| 9. 没有拿到结果怎么办？ | unknown 是否等于未执行，能否换 ID，validator 拒绝是否必定持久化？ | 原 Run / Update ID / 参数、原结果查询与事件缺口 |
| 10. 这份记录能证明什么？ | 旧 Query、非原子读取和 Workflow ID 账本如何限制结论，怎样迁移到新流程？ | 来源、时间、范围、新鲜度，以及独立练习的角色 / 幂等 / 补偿设计 |

运行入口、源码与字段对照见[源码与运行证据导读](source-evidence-guide.md)。订单停机操作始终以[Worker 恢复实验向导](worker-recovery-guide.md)为准，不为了回答 unknown 题目另造停机故障。

## 再核对要点

<details>
<summary>作答后展开：角色、恢复与重试</summary>

- Server 保存 History 并调度；Worker 执行业务代码。Workflow 决定编排，Activity 执行外部操作，API 返回创建标识。创建成功和 Workflow Task 完成不等于整个业务完成。
- 新 Worker 根据 History 重放确定性编排，局部变量随相同路径重建；不是恢复原 JavaScript 堆。已记入历史的成功 Activity 结果被复用，缓存意味着无需每轮从入口重放。
- Activity 的多次尝试是真实执行，await 等其最终结果。最大尝试数含首次；中间失败可能聚合，不能用 History 数量推扣款笔数。
- 业务效果已发生但成功结果未记录时仍可能重试。单笔效果靠外部业务幂等键、唯一约束和事务；幂等键应跨尝试稳定。取消或失败也需查账处理结果未知的已尝试操作。

</details>

<details>
<summary>作答后展开：Timer、取消与心跳</summary>

- HTTP 截止只限制请求等待。Server 的持久化 Timer 在 Worker 停机时仍计时，分支和补偿代码等待 Worker 执行；需关联确认 Timer 和后续结果。
- 业务取消、清理完成和执行 CANCELLED 是不同事实。应用显式安排补偿，在不可取消作用域中完成清理；每项清理失败应保留并继续尝试其他项。
- 心跳是 Server 最近收到的检查点，可能节流，尾部批次可重做。新 Pending attempt 可能带旧心跳；当前可靠进度先匹配 attempt 和活动状态。
- Workflow 重放恢复编排变量；Activity 新尝试读取 heartbeatDetails 恢复进度。两者不同；自动心跳超时并不单独证明进程崩溃恢复。

</details>

<details>
<summary>作答后展开：消息、结果未知与观察范围</summary>

- Signal 收件只说明消息持久化，业务可忽略提前或重复确认；Query 只读。Update validator 拒绝通常没有 Accepted / Completed，以真实回执为准；Completed 可能是失败 outcome。
- handler 返回 approved 只表示确认处理完成，后续发货另查。unknown 只表示未拿到确定结果，保留原 Run / Update ID 和参数查询或重试；同 ID 规则有服务端保留范围，不能替代业务副作用幂等。
- Query 失败后的旧 state 不是当前事实；整次详情失败时所有保留观测都过期。Describe、Query、History 与外部账本不构成原子快照；Workflow ID 汇总账本也不是 Run 专属数据。
- 合格解释必须指出缺失证据，不把单次最终成功当作恢复或外部效果精确执行一次的证明。

</details>

## 自己判定是否说清楚

对每题逐项核对，未满足时记录下一次获取证据的方法，不需要计算总分。

- [ ] 能说明因果机制和角色，引用对应的真实源码符号。
- [ ] 引用同一次执行的完整 Workflow ID / Run ID、事件 ID 和真实观测值。
- [ ] 区分历史事实、当前尝试、业务效果和请求回执，注明来源及新鲜度。
- [ ] 能提出反例或失败边界，承认尚不能确认的部分。
- [ ] 能把预测与实际差异解释清楚，而不只是复述最终状态。

## 独立迁移作业

接着进入[资料审核练习题目](../exercises/01-transfer/01.01-document-review/problem/readme.md)。先自行实现“准备资料 → Signal / 超时等待 → 归档或清理”，再查看题目提供的参考入口。练习有独立 Workflow、Task Queue、SQLite 模拟资料账本和 CLI，不改变订单页面的业务。

验收至少包含正常完成、等待时同 Run 恢复、准备已提交但结果丢失后的幂等，以及超时 / 取消后的清理。`npm run test:exercise` 默认验证参考实现；完成题目后，用 `DOCUMENT_REVIEW_TEST_VARIANT=problem npm run test:exercise` 验证自己的编排，再按题目中的 CLI 步骤填写记录。自动验收还会检查提前确认被忽略、重复确认不覆盖首次时间；未结束的分支会在有限期限后报告阶段、预期结果与最后观察状态。即使测试通过，也需解释哪些是历史结果复用、哪些是新尝试、哪些由业务存储去重。
