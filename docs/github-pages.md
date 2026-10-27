# GitHub Pages 在线学习

访问 **https://likebeans.github.io/temporal4l/**，可直接学习，无需安装 Node、Docker 或 Temporal。

## 在线版提供什么

- 正常订单、Worker 停止与恢复、响应丢失与幂等的逐步教学推演。
- 九个主题的真实源码摘录、文件、符号和行号，以及机制解释与证据边界。
- 10 个开放自测题、手工笔记和 Markdown 导出。
- 学习文档、独立迁移练习与本地实验的入口。

教学步骤由项目手工编写，明确标为“教学示意 · 非真实运行”。它们不使用 Temporal SDK 执行 Workflow，不生成伪造的 History、Run ID 或成功证据。线上没有 API 轮询，也没有需要凭据的后端。

真实订单、故障注入、支付账本、心跳与停机恢复需要 [本地实验环境](../README.md#快速启动)。在线自测草稿与本地版一样，仅存在当前页面内存，刷新或关闭会清空；离开前导出。站点不记录个人学习进度。

## 本地预览线上构建

```bash
npm ci
npm run build:pages
npm run preview:pages
```

按终端显示的地址访问 `/temporal4l/`，例如 `http://127.0.0.1:4173/temporal4l/`。构建输出到 `dist-pages/`，与本地应用的 `dist/` 分开。

Vite 的 `pages` 模式选择 `OnlineLearning` 入口，并使用 `/temporal4l/` 资源前缀。普通 `npm run dev` / `npm run build` 保留真实实验应用和根路径。入口按构建模式选择，不能通过 URL 参数把线上页面变成连接本地 API 的页面。

## 自动部署

[Pages 工作流](../.github/workflows/pages.yml)在 PR 中验证静态构建；合并到 `main` 后构建、上传并部署到 `github-pages` 环境。PR 不执行发布。Actions 固定官方提交 SHA；只有发布 job 获得 `pages: write` 和 `id-token: write`。

仓库 Settings → Pages 的来源为 **GitHub Actions**。`github-pages` 环境只接受受保护分支。主分支仍通过 PR、完整 CI 与 CodeQL 维护，不为发布绕过既有检查。

源码摘录来自部署时的代码。文档入口指向仓库 `main`；合并与发布之间可能存在短暂更新延迟。若修改仓库名或部署到自定义域名，需要同步 Vite 的 `base`、文档链接和部署地址，并验证资源和页内导航。

## 发布后核对

1. 检查 Pages 工作流成功，打开实际 HTTPS 地址。
2. 核对三组推演、源码主题切换、自测输入和导出。
3. 在手机宽度检查无整页横向滚动，键盘可操作控件。
4. 浏览器网络面板中不应有 `/api/` 请求，静态资源与图标应成功加载。
5. 若需要验证真实 Temporal 行为，使用本地应用和独立 E2E；静态站点通过不替代这些测试。
