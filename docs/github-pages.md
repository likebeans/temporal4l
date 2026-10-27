# GitHub Pages 在线学习

访问 **https://likebeans.github.io/temporal4l/**，可直接学习，无需安装 Node、Docker 或 Temporal。

## 在线版提供什么

- 七章可直接在站内阅读的课程，包含原文、图示、表格、代码复制与折叠说明。
- 课程目录、章节搜索、上一章 / 下一章、本章目录与可分享的章节 / 段落链接。
- 正常订单、Worker 停止与恢复、响应丢失与幂等的逐步教学推演。
- 九个主题的真实源码摘录、文件、符号和行号，以及机制解释与证据边界。
- 10 个开放自测题、手工笔记和 Markdown 导出；草稿尝试自动保存到当前浏览器。
- 资料审核迁移题目、实现指引与本地安装文档均可站内阅读。

教学步骤由项目手工编写，明确标为“教学示意 · 非真实运行”。它们不使用 Temporal SDK 执行 Workflow，不生成伪造的 History、Run ID 或成功证据。线上没有 API 轮询，也没有需要凭据的后端。

顶部的「真实演示」和「Temporal UI」分别在新标签打开 `http://localhost:5173/` 和 `http://localhost:8233/namespaces/temporal-learning/workflows`（默认学习命名空间）；「启动说明」提供安装步骤与直达按钮。这些地址指向访问者当前设备，需先启动本地服务；手机上的 localhost 不会连接电脑。修改过端口或使用构建后的应用时，以终端显示的地址为准。本地实验室顶部的 Temporal UI 链接使用 API 返回的 `TEMPORAL_UI_URL`。在线页只提供导航，不自动探测本地服务或显示推测的就绪状态。

真实订单、故障注入、支付账本、心跳与停机恢复需要 [本地实验环境](../README.md#快速启动)。已读标记、自测作答和手工笔记使用当前浏览器的 localStorage，刷新后可继续；不会上传，不跨设备同步。私密模式、禁用存储或清除站点数据可能使其丢失，因此重要笔记应导出备份。存储不可用时仍可编辑，并明确提示及时导出。已读标记不是测试评分或实验通过证明。本地恢复向导的临时观测记录仍保存在页面内存。

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

课程正文、图示和源码摘录均来自部署时的仓库文件；不依赖运行时向 GitHub 拉取正文。React Markdown 负责渲染，HTML 经清理后保留安全的折叠结构，文档链接按源文件目录解析。站内课程互相链接，完整源码与原始文档入口仍指向 GitHub。路由使用 `#view=read&chapter=recovery` 形式，刷新、分享与浏览器前进 / 后退无需服务器路由支持。若修改仓库名或部署到自定义域名，需要同步 Vite 的 `base`、文档链接和部署地址，并验证资源和页内导航。

## 发布后核对

1. 检查 Pages 工作流成功，打开实际 HTTPS 地址。
2. 核对章节搜索、站内链接、中文锚点、浏览器前进 / 后退和刷新直达；再验证三组推演、源码主题切换、自测输入、刷新恢复与导出。
3. 在手机宽度检查无整页横向滚动，键盘可操作控件。
4. 浏览器网络面板中不应有 `/api/` 请求，静态资源与图标应成功加载。
5. 若需要验证真实 Temporal 行为，使用本地应用和独立 E2E；静态站点通过不替代这些测试。
