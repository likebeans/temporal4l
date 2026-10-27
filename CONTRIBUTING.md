# 参与贡献

感谢你愿意改进 Temporal Lab。本项目以中文维护，同时欢迎英文 Issue、Discussion 和 Pull Request。初次贡献者也很欢迎；描述不必完美，能清楚说明问题、改动和验证依据即可。

本项目不要求签署 CLA。维护者会尽力审阅贡献，但不承诺固定响应时间或支持 SLA。

## 开始之前

1. 阅读[项目 README](README.md)和[五阶段学习路径](docs/learning-path.md)，确认改动符合“通过可观察的本地订单工作流学习 Temporal”的目标。
2. Bug 和明确任务使用 [GitHub Issues](https://github.com/likebeans/temporal4l/issues)；使用问题、学习讨论和尚未成形的想法使用 [GitHub Discussions](https://github.com/likebeans/temporal4l/discussions)。
3. 安全漏洞不要公开提交 Issue 或 Discussion，请按[安全政策](SECURITY.md)私密报告。
4. 较大的功能、依赖升级或学习路径调整，建议先发起 Discussion，避免实现方向与项目范围不一致。

## 本地开发

Fork 仓库后，从默认分支创建一个范围清晰的分支：

```bash
git clone https://github.com/<your-account>/temporal4l.git
cd temporal4l
git switch -c feat/short-description
npm ci
```

分支名可使用 `feat/`、`fix/`、`docs/`、`test/` 等前缀。请使用 **Node.js 22.13 或更高版本，推荐 Node.js 24 LTS**；依赖安装使用 `npm ci`，不要无故改写锁文件。

本地运行方式见 [README 的快速启动说明](README.md#快速启动)。原生 Temporal 开发服务和 Docker 模式二选一，不要让两个实例同时占用 `7233` / `8233` 端口。

## 项目特有的贡献约定

### 保持 Workflow 可重放

`server/workflows.ts` 中的编排会被 Temporal 使用已有 History 重放。修改 Workflow 时：

- 避免在 Workflow 中直接使用网络、文件系统、普通 Node 定时器、非确定性随机数或其他不可重放行为；外部 I/O 放到 Activity。
- 不要假设“代码更新后，运行中的旧 Workflow 会安全执行新路径”。说明改动对已有 Run 的影响；需要时采用 Temporal Patch / Worker Versioning 等兼容策略。
- 本地验证时先结束旧执行、重启 Worker，再创建新订单。不要用不同版本的 Workflow 代码继续同一 Run 来证明兼容性。
- 调整 Signal、Update、Query、Task Queue、Activity 名称、超时或重试策略时，在 PR 中明确兼容性和迁移边界。

### 保留学习题的 TODO

`exercises/01-transfer/01.01-document-review/problem/` 是供学习者独立完成的题目。除非变更本身就是重新设计练习，否则不要替学习者完成 `problem/workflow.ts` 中的 TODO，也不要移除 `DocumentReviewNotImplemented` 占位失败。修改共享契约时，应同步核对题目说明、参考实现和行为测试。

### 不扩大证据能证明的范围

项目刻意区分 Query、Describe、History、Pending Activity 和本地 SQLite 账本。贡献文档、测试或界面时，请遵守[源码与运行证据导读](docs/source-evidence-guide.md)中的边界：

- Describe → Query → History 不是原子快照；过期 Query 或旧页面数据不能冒充当前状态。
- Signal 收件、Update outcome、Activity attempt、账本扣款和 Workflow 完成分别证明不同事实，不能相互替代。
- 本地 SQLite、模拟支付和学习用补偿不是生产级支付、Saga 或“精确一次”保证。
- 自动化断言应来自真实字段或可控测试夹具，不要解析展示文案，也不要补造运行证据。

## 验证改动

先运行与改动范围相称的最小验证，并在 PR 中记录命令和结果：

```bash
npm test
npm run build
```

- `npm test` 使用隔离的 Temporal 测试环境，并覆盖 Workflow、组件、恢复证据、账本和配置等回归。
- `npm run build` 包含 TypeScript 类型检查和前端构建。
- 涉及 API、Worker、前端协作或真实端到端路径时，优先运行 `npm run test:e2e:isolated`，让测试自行使用隔离服务和数据。
- `npm run test:e2e` 会连接当前已经运行的本地 Temporal、API 和 Worker，并创建带测试标记的演示订单；只有在你明确准备并愿意复用该环境时使用。
- 修改练习行为时，运行 `npm run test:exercise`；验证题目实现时再按题目说明设置 `DOCUMENT_REVIEW_TEST_VARIANT=problem`。
- 仅修改文档、Issue 模板或元数据时，不要求为了形式运行完整集成测试；检查受影响链接、示例命令和格式即可，并在 PR 中如实写明未运行的项目及原因。

涉及取消、心跳、幂等或 Worker 恢复的行为变化时，还应按[可靠性实验](docs/reliability-experiments.md)或[Worker 恢复实验向导](docs/worker-recovery-guide.md)手工核对相应路径。

## 提交 Pull Request

- 保持一个 PR 聚焦一个问题，避免混入无关格式化或依赖升级。
- 说明用户或学习者遇到的问题、采用的方案、验证证据，以及已知限制。
- 界面变化可附截图；运行语义变化优先附命令结果、Workflow / Run 范围和相关 History 字段说明。提交前删除令牌、Cookie、`.env` 内容和个人数据。
- 若改动影响 Workflow 重放、练习 TODO 或证据解释，请在 PR 模板的对应位置明确说明。
- 接受维护者为保持教学范围、可维护性或兼容性提出的调整。提交贡献不代表一定合并。
