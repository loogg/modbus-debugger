# v0.11.2 发布验收记录

- 日期：2026-09-26（Asia/Shanghai）
- 源码提交：`e49073a`；正式发布标签 `v0.11.2` 将指向包含本记录的提交。
- 环境：Windows x64；独立 PyModbus TCP 从站；测试数据位于 `out/test-temp/`。
- 对照条件：[现行正式验收清单](acceptance.md)。本记录只报告实际执行的结果。

| 范围 | 结果与证据 |
| --- | --- |
| 静态检查与 Unit / Integration | `npm run lint`、`npm run typecheck` 通过；`npm test`：45 个文件通过，341 项通过、7 项 RTU 串口用例跳过。独立 PyModbus TCP 真线互操作 7 项通过；模拟器 CLI 2 项通过。 |
| 打包版完整 E2E | `npm run test:e2e`：10 个 spec 文件全部通过，覆盖设备、通信、扫描、趋势、历史、模板、导入、点位精度、布局和更新操作。真实 GitHub API 本次返回限流，错误状态与重试入口通过；成功下载与校验使用隔离 Release 响应及真实文件 I/O 验证。 |
| 首次使用与容量 | 独立首次使用 E2E 通过。100 万数值样本打包版 E2E 通过：会话打开 4,994 ms、回放启动 108 ms、游标及曲线重绘 229 ms、完整 CSV 导出 700 ms；剪贴板读回 28,888,904 字符，首末行正确。指标见 `out/audit/capacity-1m-smoke.json`。 |
| 正式产物与 Smoke | `npm run make -- --platform=win32 --arch=x64` 成功；`release/` 平铺目录、ZIP、Portable EXE、Setup EXE 和更新 manifest。`npm run smoke:release` 对四种形式的启动、版本、Renderer / IPC、serialport、历史库、Portable 重启、显式数据目录、Setup 自选目录重装/卸载及数据保留全部通过。截图见 `out/release-smoke-screenshots/`。 |
| 自升级与回滚 | 目录/ZIP、Portable、Setup 从 0.11.2 升到隔离测试版 0.11.3 的真实下载、校验、安装、重启与数据保留均通过；Setup 故障安装回滚到 0.11.2 通过。0.11.3 只作为隔离测试包，未发布。 |
| UI 视觉与交互 | [v0.11.1 的 30 屏 Figma 基线审查](figma-visual-audit-v0.11.1.md)已完成；本版改动涉及的点位编辑和趋势悬浮提示在 Browser Review Mode + 内置浏览器以 1440px、1024px 真实操作审查，并额外在 800px 发现及修复 Tooltip 越界。打包版点位精度 E2E 截图在 `out/audit/point-precision/`；四种发布视口截图为 1440×960、1280×960、1279×960、1024×680。未将旧版 30 屏证据冒充本版重新逐屏截图。 |

明确边界：当前机器未配置 RTU 主/从串口，7 项物理串口互操作未运行；TCP、Mock 或虚拟逻辑测试不代表实际 RS485 电气链路。真实 GitHub Release 查询成功分支未在本次限流窗口获得线上成功响应；隔离 Release fixture 验证了下载与安装流程。
