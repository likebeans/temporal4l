# 仓库维护

本项目维护重点是让学习示例可运行、说明与真实 Temporal 行为一致，并让外部贡献能安全地进入主分支。

## 日常协作

- `main` 保存可用的学习版本；代码、配置和文档变更通过短期分支和 PR 提交。
- Issue 用于可复现缺陷和具体功能建议，Discussions 用于学习问题与开放讨论。安全问题使用 [私密漏洞报告](https://github.com/likebeans/temporal4l/security/advisories/new)。
- 审查时核对教学解释、Workflow 的确定性与兼容性、Activity 幂等和真实证据来源。不要为了让练习通过而填掉题目 TODO 或删除失败分支断言。
- 使用 squash merge，将一个 PR 汇总为一个提交；合并后自动删除远端贡献分支。标题应说明解决了什么问题。
- 当前仓库没有独立的稳定版本支持线。正式发布时先完成检查，再更新 [CHANGELOG](../CHANGELOG.md)、创建对应标签和 Release，不把 `package.json` 的初始版本号当成已经发布。

## 自动检查

GitHub Actions 执行支持的 Node 版本上的回归与构建，以及使用临时服务的真实 API E2E。CodeQL 检查 JavaScript / TypeScript；Dependabot 维护 npm 依赖和 Actions 引用。具体触发条件、权限与版本以 [工作流](../.github/workflows/) 和 [Dependabot 配置](../.github/dependabot.yml) 为准。

- Actions 引用固定到提交 SHA，并在旁边注明版本，更新时核对上游官方仓库的对应提交。
- Temporal SDK 包需要兼容的统一版本；升级后检查行为测试、幂等、恢复与教学文档，不能只看安装成功。
- 不在不可信 PR 中使用 `pull_request_target` 执行其代码，不向 fork 提供凭据。
- 失败时先读测试日志和 Actions 附件；不要为让检查变绿而跳过测试、放宽业务断言或取消主分支要求。
- 文档中的截图来自本地演示，使用模拟数据；源码摘录和实际状态仍以当前代码及运行结果为准。

## GitHub 设置

以下设置存储在 GitHub，不能只靠克隆仓库复制；迁移或新建 fork 时需核对：

| 设置 | 维护目标 |
| --- | --- |
| 默认分支 | `main` |
| 合并方式 | squash merge；自动删除已合并分支 |
| 主分支 | PR、必需状态检查、解决讨论、线性历史；禁止强推和删除 |
| 协作入口 | Issues 与 Discussions 开启；文档放在仓库，Wiki 关闭 |
| 漏洞 | Dependabot 告警与安全更新、私密漏洞报告、Secret scanning 与推送保护开启 |
| Actions token | 默认只读，禁止工作流批准 PR；特定安全任务按需申请权限 |
| 外部 PR | 外部贡献者的工作流先由维护者审批 |
| Actions 引用 | 要求完整提交 SHA |
| 日志与附件 | 仓库保留 14 天；工作流可以采用更短期限 |

小型仓库不强制第二位维护者审批，避免唯一维护者无法合并自己的 PR；仍必须通过状态检查并解决讨论，分支规则同样适用于管理员。紧急调整规则时，应记录原因、补充验证并恢复保护。

## 权限与数据

默认应用绑定本机。项目不提供公网认证、生产部署或真实支付保障。`.env`、数据库、运行日志、依赖目录和个人工具配置不进入 Git；公开配置只保留 [.env.example](../.env.example)。发布前检查 `git diff --cached`，避免将本机数据作为示例上传。

贡献者的本地开发与验收命令见 [贡献指南](../CONTRIBUTING.md)，安全报告范围见 [SECURITY](../SECURITY.md)。
