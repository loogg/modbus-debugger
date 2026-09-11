# Modbus Debugger

Modbus RTU / TCP 桌面调试工具（Electron + Forge **Vite** + React + TypeScript strict + Tailwind）。

主进程是通信运行时、调度器、Block Cache、通信诊断、记录器、历史库与工作区 I/O 的唯一权威状态源；
渲染进程只消费 Main 下发的 Snapshot / revisioned delta，不直接访问串口、Socket、数据库或文件系统。
Modbus 协议栈为自研纯 TypeScript 实现（PDU / RTU / TCP Codec + 流式 Framer + ADU Validator），
FC01 / 02 / 03 / 04 / 05 / 06 / 15 / 16。

## 开发

    npm install
    npm run lint              # eslint（含 react-hooks/rules-of-hooks = error）
    npm run typecheck         # tsc --noEmit
    npm test                  # vitest：unit + integration + UI 组件
    npm start                 # Vite dev server + Electron（热重载）

## 构建方式（Vite）

`@electron-forge/plugin-vite` 驱动三个 target，产物统一落在 `.vite/`：

| 配置文件 | target | 产物 | 说明 |
| --- | --- | --- | --- |
| `vite.main.config.ts` | main | `.vite/build/index.js` | CJS；`sql.js` / `serialport` / `@serialport/*` 为 external |
| `vite.preload.config.ts` | preload | `.vite/build/preload.js` | 固定文件名，Main 以 `path.join(__dirname, 'preload.js')` 加载 |
| `vite.renderer.config.ts` | renderer | `.vite/renderer/main_window/` | 入口为**仓库根** `index.html`，单文件 IIFE bundle |

- `package.json` 的 `main` 指向 `.vite/build/index.js`。
- 生产渲染层通过特权自定义 scheme 提供：`protocol.registerSchemesAsPrivileged('app')` + `protocol.handle('app', …)` → `net.fetch(pathToFileURL(…))`，窗口 `loadURL('app://./index.html')`。
  这样既避开 `file://` 下 ES module 的 CORS 限制，又不需要关闭 `webSecurity`；`nodeIntegration=false`、`contextIsolation=true`、renderer `sandbox=true` 全程保持。
- 开发模式使用 forge 注入的 `MAIN_WINDOW_VITE_DEV_SERVER_URL`（类型声明见 `src/main/vite-env.d.ts`）。
- plugin-vite 会让 packager 跳过 `node_modules`，因此 `forge.config.ts` 的 `packageAfterCopy` 钩子显式把 external 依赖复制进 asar；`AutoUnpackNativesPlugin` 负责 unpack `.node` 二进制。
- Main 中只有 external 依赖（`serialport` / `sql.js`）可以保留运行时 `require()`；被 bundle 的依赖必须用 ESM import（例如 `electron-squirrel-startup`），否则打包后会变成找不到模块的裸 `require`。

## 独立模拟器（PyModbus，与 TS 客户端实现独立）

    npm run simulator                 # 默认 127.0.0.1:5020，units 1,2,3
    python tools/simulator/modbus_sim.py --port 50520

## E2E（WebdriverIO + Electron Service，针对打包版）

    npm run package
    npm run test:e2e          # 自动启动模拟器 + 打包版应用

- E2E 针对**打包版**运行，并用 `MODBUS_E2E=1` 暴露固定 CDP 端口。
- `tools/e2e/demo.workspace.json` 是提交进仓库的固定 fixture。应用会自动保存工作区，
  所以 `wdio.conf.ts` 的 `onPrepare` 会把它复制到临时目录再注入 `MODBUS_E2E_WORKSPACE`，
  fixture 本身永不被运行结果污染。
- 截图输出到 `tests/e2e/screenshots/`（1440×960 与 1024×680 两种尺寸）。

## 生产构建 / 安装包

    npm run package           # out/Modbus Debugger-win32-x64
    npm run make              # out/make/squirrel.windows/x64/*Setup.exe
    node tools/smoke-installer.mjs   # 安装 → 启动 → 校验 → 卸载 冒烟

## 存储与依赖

- 历史库使用 **sql.js**（SQLite 的 WASM 构建，MIT）：零原生二进制、跨机器免编译；
  `history.db` 落盘仍是标准 SQLite 文件，外部工具可直接打开。
  `sql.js` 在 Main 中为 external（其 UMD 产物被 Vite 打包后会失败），`sql-wasm.wasm` 通过
  `createRequire(...).resolve('sql.js')` 的同目录解析定位，开发 / 打包 / Vitest 三种布局都可用。
- 串口使用 **serialport**（N-API prebuilds，Node / Electron 通用）。
- 项目**不含 ABI 敏感原生模块**，因此不需要 `electron-rebuild` 或 prebuild 切换流程。
- 日志与数据不写系统盘：运行日志 `<执行目录>/logs/main.log`，历史库默认 `<执行目录>/data/history.db`
  （可在设置页改到任意路径，设置页显示真实生效路径）。

## 目录

- `src/domain` 纯 TypeScript 领域层：协议编解码、流式分帧、映射、缩放、重叠校验
- `src/main` Electron 主进程：Connection Runtime / Scheduler / Block Cache / Recorder / 历史库 / Workspace I/O / IPC
- `src/preload` 最小 typed API（contextBridge）
- `src/renderer` React 界面（App Rail + Context Sidebar + Main）
- `src/shared` Snapshot / Delta / Command 契约（zod）
- `tests/unit`、`tests/integration`、`tests/e2e`
- `tests/fixtures/protocol` Golden 向量（expected bytes 由 `tools/gen_protocol_fixtures.py` 独立生成）
- `tools/simulator` 独立 PyModbus 模拟器；`tools/smoke-installer.mjs` 安装包冒烟
- `docs/` 设计来源、规范、架构、验收清单；`docs/protocol/` 协议实现参考
