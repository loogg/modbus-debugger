# 文档入口

本页只负责导航。功能开发按任务读取相关文档；历史验收结果不作为现行需求或本次测试通过的证明。

| 要做什么 | 阅读位置 | 维护原则 |
| --- | --- | --- |
| 了解产品行为、点位与记录语义 | [产品与领域规范](project-spec.md) | 行为改变时更新，不记录实现过程 |
| 修改 Main / Preload / Renderer 边界、调度或存储 | [当前架构](architecture.md)；通信细节见 [协议参考](protocol/01-application-protocol.md)、[RTU](protocol/02-rtu-framing.md)、[TCP](protocol/03-tcp-framing.md) | 保留当前有效的契约与例外 |
| 开发、测试或打包 | [开发说明](development.md) | 命令、测试隔离和交付步骤以此为准 |
| 核对 Figma 与规范优先级 | [设计与规范来源](design-source.md) | 只引用正式设计页 |
| 做正式发布验收 | [现行验收条件](acceptance.md) | 仅定义条件，不填写历史 PASS |
| 查容量实测与复现方法 | [历史库容量基准](benchmarks/history-capacity-2026-09-25.md) | 保留测量日期、环境与适用边界 |
| 查旧版本的执行结果 | [历史记录索引](archive/README.md) | 按版本保存，不反向覆盖现行规范 |

面向使用者的安装与操作说明在仓库根目录的 [README](../README.md)。可导入的单连接示例在 [docs/examples](examples/demo.workspace.json)；`tools/e2e/demo.workspace.json` 是自动化测试的双连接夹具，两者用途不同。

新增功能时，按实际影响更新产品行为、架构、开发命令或验收条件；发布结果写入版本记录。`out/` 是可重建的构建与测试输出；历史记录不依赖它才能阅读。若要复核旧截图或日志，需在清理前另行留存，或按测试命令重新采集。
