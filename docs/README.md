# Temporal 学习文档

先按[项目 README](../README.md)选择原生或 Docker 方式，安装依赖并启动应用；已有服务运行时直接复用。再从[五阶段学习路径](learning-path.md)开始：①正常订单与角色分工 ②等待确认时停止重启 Worker ③重试、超时与幂等 ④取消、补偿与心跳 ⑤Signal / Update 深入对照。首课选择「正常处理」，使用默认 Signal，先观察 Query 与真实 History；下一课复用已有 Worker 恢复向导。

- [在线学习与部署](github-pages.md)：GitHub Pages 学习入口、静态推演的范围、本地预览与发布步骤。
- [五阶段学习路径](learning-path.md)：统一的初学入口，各阶段提供学习目标、可照走的操作、观察证据、相关文档和源码。完成后接入自测、实验记录和独立资料审核迁移练习。
- [源码与运行证据导读](source-evidence-guide.md)：配套「深入观察 → 源码与证据」，按 API → Worker → Workflow → Activity 定位真实符号；逐题对照正常、恢复、重试、确认超时、幂等、取消与补偿、心跳、Signal、Update 的真实字段与解释边界。
- [开发路线](development-roadmap.md)：三期目标、具体交付、依赖和可验证验收。第一期“学习入口与核心模型”、第二期“源码分层与运行证据对照”和第三期“自测与小型迁移练习”均已完成并验证。
- [自测与迁移](self-check.md)：10 个开放题、折叠参考解释和人工核对标准；与页面「自测与迁移练习」配套，先作答再对照。
- [实验记录模板](experiment-record-template.md)：记录预测、真实操作、同 Run 的事件、来源与新鲜度，以及结论边界；可复制填写，页面也支持导出本次草稿。
- [资料审核迁移练习](../exercises/01-transfer/01.01-document-review/problem/readme.md)：独立实现准备、人工审核、归档与清理；专用 Task Queue、独立模拟账本和 CLI，先完成题目再查看参考实现。
- [结合订单示例理解 Temporal 的执行流程](temporal-execution-flow.md)：机制参考。第一阶段选读角色、请求链路、基础 Signal / Query、Timer 与 History；第二阶段读历史重放，其余内容按学习路径逐步展开。
- [Worker 恢复实验向导](worker-recovery-guide.md)：第二阶段“等待确认时重启”的准备条件、独立 `worker:recovery` 进程控制、停机 Signal 入库和证据判定依据；打包崩溃与检查点恢复留到第四阶段。
- [幂等、心跳与补偿实验](reliability-experiments.md)：第三、四阶段的操作依据，包括扣款后故障的幂等重试、业务与执行双状态、长 Activity 取消、心跳和检查点恢复。
- [Signal、Update 与 Query：订单确认对照](signal-update-comparison.md)：第五阶段深入阅读，包含 validator / handler、HTTP 接口、同 ID 重试、未知结果恢复与真实 History。

核心源码按 API 启动调用 → Worker 注册 → Workflow 主干 → Activity 实现阅读，具体入口见[源码导读的分层阅读顺序](source-evidence-guide.md#先找到执行链路再分层读函数)与[项目 README](../README.md#推荐阅读顺序)。暂不拆分现有 Workflow runtime，用分区符号与当前源码摘录辅助阅读，没有新增教学副本 Workflow。

「源码与证据」的真实摘录标明文件、符号和当前行号；原「核心代码概念」保留概念教学示意。源码范围固定为六个项目文件，作为文本随前端模块加载，页面展示选定摘录，没有任意本机文件读取入口。证据读取当前 detail 与新鲜度标志，History 引用可按事件 ID 跳到显示 `#ID` 的「事件历史」；跨请求的 Worker 恢复仍由原恢复向导保存基线、控制阶段并核对。Query 失败保留的旧 state 与整体详情失败保留的所有数据，都需按[新鲜度说明](source-evidence-guide.md#这次观察够新吗)解读。

文档中的图均保留可编辑的 Mermaid 源文件和可直接查看的 SVG：

| 图 | 可查看版本 | 可编辑源文件 |
| --- | --- | --- |
| 组件关系 | [SVG](diagrams/runtime-architecture.svg) | [Mermaid](diagrams/runtime-architecture.mmd) |
| 订单执行时序 | [SVG](diagrams/order-execution-sequence.svg) | [Mermaid](diagrams/order-execution-sequence.mmd) |
| Signal / Update 确认对照 | [SVG](diagrams/signal-update-comparison.svg) | [Mermaid](diagrams/signal-update-comparison.mmd) |
| Worker 重启恢复 | [SVG](diagrams/worker-recovery.svg) | [Mermaid](diagrams/worker-recovery.mmd) |
| 打包进程崩溃与检查点恢复 | [SVG](diagrams/packing-worker-recovery.svg) | [Mermaid](diagrams/packing-worker-recovery.mmd) |

本地安装了 [Mermaid CLI](https://github.com/mermaid-js/mermaid-cli) 时，可以从项目目录重新导出，例如：

```bash
mmdc \
  -i docs/diagrams/runtime-architecture.mmd \
  -o docs/diagrams/runtime-architecture.svg \
  -b transparent -t neutral
```
