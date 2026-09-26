# Agent 工作约束

## 项目定位

这是 Modbus RTU / TCP 桌面调试工具。每次任务涉及的功能须可实际使用；关键交互不得以 Demo、骨架、长期 mock 或占位实现交付。

## 任务读取原则

文档按需读取，已有上下文复用：产品语义见 `docs/project-spec.md`，实现见 `docs/architecture.md` 和 `docs/protocol/`，设计来源见 `docs/design-source.md`，开发命令见 `docs/development.md`，正式验收见 `docs/acceptance.md`。`docs/full-audit.md` 仅为历史证据。

## 固定工程基线

- Electron + Forge **Vite**（`@electron-forge/plugin-vite`）+ React + TypeScript strict + Tailwind。
- Radix UI + Fluent Icons + Zustand + TanStack Table/Virtual + ECharts + Zod + `sql.js` (WASM) + `serialport` + Node `net.Socket`。
- Unit/Integration: Vitest + RTL；E2E: WebdriverIO + Electron Service（针对打包版 + PyModbus 模拟器）。
- ESLint 强制 `react-hooks/rules-of-hooks`（error）；窗口白屏零容忍。
- `nodeIntegration=false`、`contextIsolation=true`、Renderer sandbox 开启；Preload 仅暴露最小 typed API。
- 依赖必须为成熟、维护活跃的免费商用开源方案（MIT / BSD / Apache-2.0 等）；禁止闭源收费或 GPL/AGPL 等商业传染风险依赖。
- `package.json` 的 `version` 是版本唯一来源；功能/行为修改按 SemVer 同次递增并同步 lockfile。

## 项目硬约束

- **权威状态源**：Main 是 Connection Runtime、Scheduler、Block Cache、通信诊断、Recorder、SQLite 和 Workspace I/O 的唯一权威源；Renderer 仅消费 Main Snapshot / delta，严禁直连底层。
- **跨进程契约**：共享 DTO 由 `src/shared/` 定义，Renderer 不依赖 Main 内部类型；生产界面编辑工作区使用 Main 的细粒度命令，不发送完整 `workspace.apply` 快照。
- **缓存复用**：Realtime / Trend / Recorder 必须复用同一 Block Cache，不得各自创建 Poll。
- **自研核心编解码**：Modbus Client Core 采用自研纯 TypeScript PDU / RTU / TCP Codec（FC01/02/03/04/05/06/15/16），第三方 Modbus Master API 不进入 Domain / Application。
- **流式解析与自动恢复**：RTU / TCP 接收链路必须支持任意分片、连续多帧、半包+粘包混合及异常帧识别；坏帧不得使后续合法帧失步或被丢弃。RTU Framing 不依赖字符间隔时序，以预期长度、CRC、可信边界扫描与有界等待为准。
- **状态真实性**：Value 永远代表设备 confirmed value；输入与 pending 严禁写入 Block Cache。
- **真实 UI 审查与收敛**：以项目已有设计系统与交互规范为准。
  - 界面修改完成后使用 Browser Review Mode + 内置浏览器进行真实交互与视觉审查。
  - 检查受影响界面的视觉、交互、布局、响应式及相关状态；发现问题后修改并复验直到收敛。
  - Native 特有能力在真实桌面应用中验证。
  - 自动化测试不能替代上述审查。

## 构建与交付规范

- 构建命令：`npm start`（开发模式）、`npm run package`（打包目录版）、`npm run make`（正式打包）。
- 正式打包必须在 `release/` 根目录平铺生成四种交付产物（同架构、同版本，无多余子目录）：
  1. 目录版：`modbus-debugger-<version>-win-<arch>/`
  2. ZIP 版：`modbus-debugger-<version>-win-<arch>.zip`
  3. Portable 单文件版：`modbus-debugger-<version>-win-<arch>-Portable.exe`
  4. Setup 安装版：`modbus-debugger-<version>-win-<arch>-Setup.exe`
- 成功打包后仅清理符合命名约定的旧版本产物，构建失败保留原有产物；`release/`、`out/`、`data/`、`cache/`、`logs/`、`temp/` 严禁提交至 Git。

## 数据存储与测试隔离底线

- 运行存储根目录优先级：命令行 `--data-dir="绝对路径"` > `MODBUS_DATA_DIR` > 程序 EXE 所在目录（Portable 为外层 EXE 目录）。
- 根目录统一维护 `data/`、`cache/`、`logs/`、`temp/`；启动前必须验证目录可写，失败明确报错并退出，禁止静默回退系统盘 AppData。
- 自动化测试临时目录统一为 `out/test-temp/`，测试环境必须严格隔离，严禁修改或污染日常用户配置与历史库。

## 测试与回归策略（按影响范围最小充分验证）

日常任务默认执行能证明本次改动正确的最小充分验证，禁止机械地每轮执行全量测试、全量 E2E、全页面截图或反复打包安装。

| 改动类型 | 默认验证范围 |
| --- | --- |
| 仅文档、规则、注释 | 检查内容一致性与 `git diff --check`；不运行应用测试或构建，不递增版本 |
| 局部样式、文案、布局 | 适用时运行相关静态检查；真实界面审查受影响页面与窗口尺寸；不默认跑全量测试 |
| 局部功能、业务逻辑、Bug 修复 | 相关文件 lint，TypeScript 改动运行 typecheck；运行能覆盖改动的 Unit 或 Integration；定向复现验证 |
| 公共组件、Domain、Scheduler、IPC、持久化 | 覆盖受影响调用方及边界测试；通信修改跑对应模拟器互操作；UI 审查受影响场景 |
| 依赖、构建、打包、启动路径 | 静态检查、构建与产物 Smoke Test；覆盖受影响交付形式 |
| 正式发布验收或用户明确要求全量 | 执行 `docs/acceptance.md` 完整验收清单 |

## 禁止红线

- 不得使用旧 Cache 做部分寄存器 RMW。
- 不得因窄窗口隐藏关键工程列或整体缩放 UI。
- 不得留下关键 TODO / FIXME / placeholder 后宣称完成。

## 完成门槛

- **日常增量任务**：本次功能完成且相关检查通过；涉及界面时完成真实审查收敛。
- **正式发布验收**：必须通过 `docs/acceptance.md` 全部适用项并确认四种产物 Smoke Test 通过。
