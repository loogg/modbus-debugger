# v0.11.3 发布验收记录

- 日期：2026-09-27（Asia/Shanghai）
- 源码提交：`2a56ac2`；发布标签 `v0.11.3` 指向包含本记录的提交。
- 环境：Windows x64，ELTIMA 虚拟串口 COM1 ↔ COM2；COM2 运行独立 PyModbus 从站，COM1 运行本项目客户端。测试数据位于 `out/test-temp/`。
- 对照条件：[现行正式验收清单](acceptance.md)。

| 范围 | 本版结果 |
| --- | --- |
| 静态检查及 Unit / Integration | `npm run lint`、`npm run typecheck`、`git diff --check` 通过；`npm test` 为 45 个文件、354 项通过，无跳过。独立 PyModbus 线级互操作 TCP 7 项、RTU 7 项均通过，涵盖八功能码、CRC 恢复、异常、延时、RMW、写入超时后的回读和动态值。 |
| 打包版完整 E2E | 在 COM1/COM2 环境运行 `npm run test:e2e`，11 个 spec 文件全部通过；RTU 审计通过 UI 新建连接及从站，实际读写、回读并验证 TCP 从站隔离。设置页另存、独立文件导出、导入失败保留原工作区、偏好持久化和诊断清空均通过。 |
| 首次使用与容量 | 独立首次使用 E2E 通过。100 万数值样本打包版 E2E 通过：会话打开 4,504 ms、回放 70 ms、游标及曲线重绘 272 ms、完整 CSV 导出 644 ms；剪贴板读回 28,888,904 字符，首末行正确。原始指标见 `out/audit/capacity-1m-smoke.json`。 |
| 正式产物与 Smoke | `npm run make -- --platform=win32 --arch=x64` 成功；目录、ZIP、Portable EXE、Setup EXE 与更新 manifest 均为 0.11.3。`npm run smoke:release` 对四种形式的真实启动、Renderer / IPC、serialport、历史库、Portable 重启、显式数据目录、Setup 自选目录重装/卸载及数据保留通过。 |
| 自升级与回滚 | 目录/ZIP、Portable、Setup 从 0.11.3 升到隔离测试版 0.11.4 的真实下载、校验、安装、重启与数据保留通过；Setup 故障安装回滚到 0.11.3 通过。0.11.4 只作本地测试包，未发布。 |
| 视觉与原生交互 | [v0.11.1 的 30 屏 Figma 基线审查](figma-visual-audit-v0.11.1.md)保留为历史证据；本版改动的设置页在 Browser Review Mode + 内置浏览器以 1440px、1024px 审查真实点击与布局，发现问题后已修改复验。打包版验证 Electron 默认菜单已移除且 Ctrl+C / Ctrl+V 可用；截图位于 `out/audit/settings-v0.11.3/`。未将历史 30 屏证据冒充本版重新逐屏截图。 |

边界：虚拟 COM1/COM2 验证了 Windows 串口驱动与 RTU 字节链路，不代表物理 RS485 接线、电气噪声、收发器方向或具体厂商设备。真实 GitHub Release 查询本轮遇到 API 限流；界面错误和重试入口通过，成功下载、校验与安装使用隔离 Release 响应及真实文件 I/O 验证。
