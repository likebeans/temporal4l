# 获取帮助

本项目以中文维护，同时欢迎英文提问。它是本地 Temporal 教学示例，不提供生产运维、架构认证或响应 SLA；维护者和社区会在可用时间内尽力回复。

## 选择合适的入口

- 使用方法、概念理解、学习实验和开放式想法：[GitHub Discussions](https://github.com/likebeans/temporal4l/discussions)
- 可稳定复现的缺陷、文档错误或范围明确的功能建议：[GitHub Issues](https://github.com/likebeans/temporal4l/issues)
- 可能影响安全的漏洞：[私密漏洞报告](https://github.com/likebeans/temporal4l/security/advisories/new)

请勿在公开 Issue 或 Discussion 中披露未修复漏洞、访问令牌、Cookie、私钥、`.env` 内容、真实个人数据或完整的敏感日志。

## 推荐学习路线

1. 按[项目 README](README.md)选择原生或 Docker 启动方式。
2. 从[五阶段学习路径](docs/learning-path.md)依次完成正常订单、Worker 恢复、重试与幂等、取消与心跳、Signal / Update 对照。
3. 对照[源码与运行证据导读](docs/source-evidence-guide.md)，区分 Query、Describe、History、Pending Activity 和模拟支付账本能证明的事实。
4. 使用[实验记录模板](docs/experiment-record-template.md)记录预测、Workflow ID / Run ID、事件 ID、实际结果和结论边界。
5. 完成基础路径后，再进入[资料审核迁移练习](exercises/01-transfer/01.01-document-review/problem/readme.md)。

## 提问前排查

1. 确认 Node.js 为 `22.13+`，推荐 Node.js 24 LTS，并从仓库根目录运行 `npm ci`。
2. 原生模式运行 `npm run temporal:local`；Docker 模式运行 `npm run temporal:up`。两种模式只选一种，并确认 `7233`、`8233` 未被另一实例占用。
3. 运行 `npm run dev` 时，确认 API、Worker 和前端都已启动；恢复实验需按[Worker 恢复实验向导](docs/worker-recovery-guide.md)拆成独立进程，并确保任务队列上只有一个 Worker。
4. 检查学习页面、API 健康端点和 Temporal UI；查看浏览器控制台、API、Worker 与 Temporal 终端中的首个相关错误。
5. 修改 Workflow 代码后重启 Worker，并创建新的订单验证。不要用不同版本的 Workflow 代码恢复同一个 Run 来判断新代码是否正确。
6. 对代码改动运行 `npm test` 和 `npm run build`；涉及完整交互路径时运行 `npm run test:e2e:isolated`。若有意复用已经启动的本地服务，才运行 `npm run test:e2e`。

## 提交问题时提供什么

请尽量提供最小、可复现且已脱敏的信息：

- Node.js 版本、操作系统和启动模式（原生 Temporal、Docker、隔离测试或其他）；
- 使用的命令、最小复现步骤、预期结果和实际结果；
- 相关分支或提交，以及是否修改过 Workflow、环境变量或默认端口；
- 必要的错误栈、首个失败日志和相关 History 事件；
- 若问题涉及一次执行，提供 Workflow ID / Run ID 的测试值和证据来源，但不要上传包含敏感 Payload 的完整导出。

Describe、Query、History 和 SQLite 账本不是原子快照。请说明观察来自哪里、何时取得、数据是否已标记过期，不要仅凭页面文案推断执行事实。

## 支持范围

可以讨论本仓库的本地启动、教学流程、测试、文档和代码行为。生产架构评审、互联网暴露、真实支付接入、托管 Temporal 运维、合规设计和第三方系统故障不属于本项目的支持承诺；相关场景请参考 [Temporal 官方文档](https://docs.temporal.io/)并咨询具备相应责任边界的团队或服务商。
