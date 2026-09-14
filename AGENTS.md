### 项目定位

这是 Modbus RTU / TCP 桌面调试工具。目标是在一次 Agent 任务内完成可实际使用的版本，不接受 Demo、骨架、长期 mock 或关键交互未接线作为交付。

### 开始前必须读取

1. `docs/design-source.md`
2. `docs/project-spec.md`
3. `docs/architecture.md`
4. `docs/acceptance.md`
5. `docs/protocol/`
6. 通过 Figma 工具完整读取 `00 — 设计规范`、`01 — 产品界面`、`02 — 组件规范`；禁止以 `99 — Archive` 为实现依据。

### 固定工程基线

- Electron + Forge **Vite**（`@electron-forge/plugin-vite`）+ React + TypeScript strict + Tailwind。
- Radix UI + Fluent Icons；本项目启用 Zustand / TanStack Table+Virtual / ECharts。
- Zod、`sql.js`（历史库，WASM，见 architecture.md Override）、`serialport`、Node `net.Socket`、`electron-log`、`exceljs`。
- Unit / Integration 使用 Vitest + React Testing Library；Electron E2E 使用 WebdriverIO + Electron Service（针对**打包版** + PyModbus 模拟器）；npm + lockfile。
- ESLint 启用 `react-hooks/rules-of-hooks`（error）：条件调用 Hook 会让 React 抛错并卸载整棵树（窗口白屏），不得绕过。
- `nodeIntegration=false`、`contextIsolation=true`、Renderer sandbox 开启；Preload 只暴露最小 typed API。
- 第三方依赖优先成熟、维护活跃、社区广泛使用的开源方案；默认优先 MIT / BSD / ISC / Apache-2.0 等可免费商用许可证。
- 禁止引入闭源收费、商业授权受限或存在明显商业版权风险的依赖；GPL / AGPL / LGPL / EPL / MPL、双许可证及授权不明确的依赖必须先评审。
- 表格、图表等基础能力优先复用本项目已经确定的 TanStack Table/Virtual 与 Apache ECharts，不为同类功能重复引入新库。
- 其他实现细节可自行选择，但必须保持方案统一、依赖克制、结构简单、便于维护；已有能力能合理实现时，不为少量便利新增依赖。只有实际功能/性能证据证明默认方案不足时，才允许在 `architecture.md` 明确 Override。
- 若目录不是 Git 仓库先初始化；补齐 `.gitignore`；独立且可验证阶段完成后提交一次。
- `package.json` 的 `version` 是版本唯一来源；功能/行为修改按 SemVer 同次递增并同步 lockfile。

### 项目硬约束

- Main 是 Connection Runtime、Scheduler、Block Cache、通信诊断、Recorder、SQLite 和 Workspace I/O 的权威状态源。
- Renderer 只消费 Main Snapshot / revisioned delta，不直接访问串口、Socket、SQLite 或文件系统。
- Realtime / Trend / Recorder 必须复用同一 Block Cache，不得各自创建 Poll。
- 正式 Modbus Client Core 使用项目自己的纯 TypeScript PDU / RTU / TCP Codec；第三方 Modbus Master API 不进入 Domain / Application。
- RTU / TCP 接收链路必须按**流式解析**设计，能够处理任意分片输入、连续多帧、半包+粘包混合、异常帧识别与自动恢复；单个坏帧不得使后续合法帧永久失步或被整段丢弃。具体 Framing / Resync / Buffer 边界见 `architecture.md`，硬测试见 `acceptance.md`。
- RTU / TCP 当前每 Connection `maxInFlight = 1`；写确认、RMW、Scanner 调度见 `architecture.md`。
- Value 永远代表设备 confirmed value；输入和 pending 不进入 Block Cache。
- UI 以 Figma 正式页面和组件规范为视觉真值，并覆盖 Standard / Compact 窗口。

### 执行方式

按 Domain → Persistence → Transport / Codec → Scheduler / Block Cache → Simulator → UI Shell / Components → 功能页面 → E2E → 全页面视觉审核 → Production Build → Installer Smoke 推进。

构建：`npm start`（Vite dev server + Electron）、`npm run package`（`.vite/build` + `.vite/renderer/main_window`，目录版输出到 `out/`）、`npm run make`（正式打包，生成以下全部四种交付产物）。
Main / Preload 打包为 CJS；生产渲染层通过特权 `app://` scheme 提供（保持 webSecurity 与 sandbox 开启）。

每次正式打包必须同时生成以下四种交付产物，缺一不可：

- 打包后的目录版：包含完整运行文件，可直接启动。
- ZIP 解压版：解压后即可运行，无需安装。
- 单文件 Portable 版：以单个可执行文件交付，无需安装即可启动。
- Setup 安装版：提供 Squirrel Setup 安装程序，支持安装、启动和卸载。

`out/` 用于构建中间产物；最终交付产物必须直接平铺到 `release/` 根目录，禁止再套版本号、平台或 `unpacked` 子目录。命名如下（`<version>` 自动读取 `package.json`，`<arch>` 为实际目标架构，如 `x64`）：

```text
release/
├── modbus-debugger-<version>-win-<arch>/
├── modbus-debugger-<version>-win-<arch>.zip
├── modbus-debugger-<version>-win-<arch>-Portable.exe
└── modbus-debugger-<version>-win-<arch>-Setup.exe
```

四种产物必须来自同一版本、同一次构建；全部生成成功后才整理到 `release/`。`release/` 加入 `.gitignore`；重复构建仅替换同名产物，不清空其他版本。Portable 的持久化日志与默认数据库以外层 EXE 所在目录为基准，不得写入退出后会被清理的临时解压目录。

可自行解决的问题直接修复；公共组件、Domain、Scheduler 或 IPC 修改后回归所有受影响路径。

### 禁止

- 不得以假数据替代最终通信链路。
- 不得在 Renderer 创建后台 Poll Timer。
- 不得使用旧 Cache 做部分寄存器 RMW。
- 不得把 pending engineering value 冒充设备值。
- 不得因窄窗口隐藏关键工程列或整体缩放 UI。
- 不得留下关键 TODO / FIXME / placeholder 后宣称完成。

### 完成门槛

`docs/acceptance.md` 全部通过后才允许结束；最后必须通过 lint、typecheck、Unit、Integration、E2E、Simulator、关键尺寸截图审核、Production Build、Installer / distributable Smoke Test 和 Full Regression。

打包验收必须确认目录版、ZIP 解压版、单文件 Portable 版和 Setup 安装版全部生成，并分别完成启动 Smoke Test；Setup 安装版还必须验证安装与卸载。
