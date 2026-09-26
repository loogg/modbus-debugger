# 开发说明

面向修改源码、定位问题和维护发布流程的开发者。日常使用和源码启动入口见 [README](../README.md)。

## 工程结构

技术栈为 Electron + Forge Vite + React + TypeScript strict + Tailwind，UI 使用 Radix UI、Fluent Icons、TanStack Table/Virtual 和 ECharts。

| 目录 | 职责 |
| --- | --- |
| `src/domain/` | 协议编解码、流式分帧、映射、缩放、重叠校验 |
| `src/main/` | 通信 Runtime、Scheduler、Block Cache、Recorder、持久化、工作区 I/O、IPC |
| `src/preload/` | 最小 typed API |
| `src/renderer/` | 页面、公共组件、UI 状态与本地化 |
| `src/shared/` | Snapshot / delta / Command 契约 |
| `tests/unit/`、`tests/integration/`、`tests/e2e/` | 单元/组件、集成、打包版 E2E |
| `tools/simulator/` | 独立 PyModbus 模拟器 |
| `build/`、`tools/release.ts` | 图标、NSIS 脚本、交付产物整理 |

进程边界、通信调度和缓存关系见 [架构](architecture.md)；任务级硬约束见 [AGENTS.md](../AGENTS.md)。

## 验证命令

按改动影响范围选择检查，普通修复不默认执行所有命令。

```powershell
npm run lint
npm run typecheck
npm test -- tests/unit/scan-options.test.ts
npm test -- tests/integration/runtime-tcp.test.ts
```

`npm test` 执行所有 Vitest 用例；也可传入 `tests/unit` / `tests/integration` 目录。监听修改使用 `npx vitest`。

历史库增长测量使用 `node --expose-gc node_modules/vite-node/vite-node.mjs tools/bench-history.mjs -- '--rows=100000,500000,1000000' --batch=1000`；脚本只在 `out/test-temp/` 建库，现有结果与局限见[容量基准](history-capacity-benchmark.md)。

E2E 通过 WebdriverIO + Electron Service 运行打包版，并自动启动 PyModbus：

```powershell
python -m pip install -r tools/simulator/requirements.txt
npm run package
npm run test:e2e -- --spec tests/e2e/app.e2e.ts --mochaOpts.grep "launches with"
```

需要全部 E2E 时运行 `npm run test:e2e`。固定 fixture 为 `tools/e2e/demo.workspace.json`，测试会复制后使用；测试隔离规则见下文。历史测试截图路径见[验证与审计历史](full-audit.md)，文档截图独立维护于 `docs/images/`。

## Vite 构建与运行边界

| 配置 | target | 输出 |
| --- | --- | --- |
| `vite.main.config.ts` | Main，CJS | `.vite/build/index.js` |
| `vite.preload.config.ts` | Preload，CJS | `.vite/build/preload.js` |
| `vite.renderer.config.ts` | Renderer | `.vite/renderer/main_window/` |

- `package.json.main` 指向 `.vite/build/index.js`，Renderer 入口为根目录 `index.html`。
- 生产模式通过特权 `app://` scheme 加载页面；保持 `webSecurity`、`contextIsolation` 和 Renderer sandbox，关闭 `nodeIntegration`。
- 开发模式使用 Forge 注入的 Vite dev server URL。
- `sql.js`、`serialport` 等需要运行时加载的模块声明为 external，由 Forge `packageAfterCopy` 复制；原生 `.node` 文件由 AutoUnpackNativesPlugin 处理。
- 被 bundle 的依赖使用 ESM import，避免留下运行时无法解析的裸 `require()`。
- sql.js 为 SQLite WASM 构建，数据库落盘仍是标准 SQLite 文件；串口使用 serialport 的 N-API prebuilds。WASM 与原生模块必须在打包版中验证，不能只看开发环境成功。

## 打包与分发验证

```powershell
npm run make -- --platform=win32 --arch=x64
npm run smoke:release
```

`make` 已包含 package。Forge 生成程序目录和 ZIP，postMake 使用同一 prepackaged 目录生成 NSIS Setup 和 Portable；四种产物成功后才整理到 `release/`。

Setup 使用安装向导和程序文件清单，支持自选目录，保留用户数据；Portable 使用项目自己的无插件 NSIS 启动脚本。不要修改 `node_modules` 模板来完成定制。

`smoke:release` 检查目录版、ZIP、Portable、Setup 的真实启动、版本、IPC、serialport 和历史库，同时验证路径、Portable 重启/清理、自定义数据目录，以及 Setup 重装/卸载后保留数据。单独检查安装器可运行 `node tools/smoke-installer.mjs`。

## GitHub Actions

[PR checks 工作流](../.github/workflows/pr-checks.yml) 在 Windows 上执行 lint、typecheck、Unit / Integration 和独立 PyModbus 互操作；测试数据隔离在 `out/test-temp/`，无串口硬件时 RTU 硬件用例明确跳过。它不生成正式发布产物。

[Windows packages 工作流](../.github/workflows/windows-release.yml) 使用 Windows x64、Node.js 24、`npm ci` 和同一 `make` 流程。

- `master` / `main` 代码推送生成 Actions Artifacts；Markdown / `docs/` 变更不触发分支构建。
- `v<version>` 标签必须与 `package.json.version` 一致；成功后把 ZIP、Portable EXE、Setup EXE 附加到 GitHub Releases。
- 普通分支推送不自动创建版本发布；不得移动既有标签或覆盖发布资产。
- 云端执行交付产物 Smoke Test，不因为推送就重跑无关业务全量测试。

## 数据、缓存与测试隔离

- **默认存储根目录**：目录版/ZIP 为程序 EXE 所在目录，Portable 为外层 Portable EXE 所在目录，开发模式为项目目录；支持 `--data-dir="绝对路径"` 或 `MODBUS_DATA_DIR` 显式指定另一处可写根目录（命令行优先）。程序/自选目录在 C 盘时仍使用该位置，不硬编码 D 盘。
- **根目录统一规范**：根目录下统一规划 `data/`（`prefs.json`、默认 `history.db`、`workspaces/`）、`cache/`（Electron sessionData、浏览器缓存）、`logs/`（`main.log`）、`temp/`（含 crash dumps）。必须在 Electron ready、日志初始化和创建窗口之前设置对应路径，避免默认落到系统 AppData。
- **启动检查**：启动前验证目录可写；失败时明确提示移动程序或通过 `--data-dir` 选择数据目录并退出，禁止静默回退到 AppData/系统临时目录。
- **Portable 运行机制**：使用无插件 NSIS 启动脚本，每次解压到外层 EXE 的 `temp/` 下独立目录，直接启动 Electron 并传入外层目录；正常退出只清理本次解压目录，不清理 data/logs 等持久目录。
- **测试环境隔离**：自动化测试临时目录统一为 `out/test-temp/`，由 `tools/test-paths.mjs` 管理、按测试会话隔离并在结束后清理。WDIO、Smoke 与持久化测试均使用该隔离目录，严禁读写或修改日常 AppData 偏好、数据库或最近工作区。

## 模拟器与功能验收实践

- **PyModbus 从站测试**：从站 CLI 必须同时提供 RTU 与 TCP 模式。RTU 用 `--serial-port` 显式指定从站端口，禁止写死 COM 号；TCP 用 `--host` / `--port` 指定监听地址。
- **协议与场景覆盖**：覆盖支持的 FC01/02/03/04/05/06/15/16、独立 Unit 和四类地址区、写后读回、非法地址、未知 Unit 静默、动态/静态数据及故障注入。
- **UI 真实交互验证**：UI 验收通过真实鼠标/键盘触发操作，核对确认设备值、Main 状态、文件或历史库结果；IPC 仅用于搭建 fixture 与观察状态，不得替代被测按钮。Browser Review 的 Mock Transport 可检查布局和状态，通信验收须使用真实 Main 链路与模拟器或设备。
- **有效断言原则**：断言应能检验相反与边界行为（如扫描取消后不发后续请求、重新扫描替换结果、写入区分从站实例、只读/取消不发写包、写后回读确认、复制模板验证新 ID、导入验证实际地址与宽度等）。
- **审计记录**：全量验收报告需列出实际通过、失败与明确跳过的项目；无真实串口环境时须明确标注，不可把 TCP/mock 代替为 RTU 硬件通过。审计证据记录于 `docs/full-audit.md`。

## 文档与截图维护

截图使用可复现的示例数据和实际运行的程序，不使用日常工作区。新增功能截图从真实界面采集并放入 `docs/images/`；每张图说明入口、操作和结果。仅改文档时检查链接、图片、示例及命令一致性，不重新构建应用。

串口/TCP 参数、完整数据区与故障注入见 [模拟器说明](../tools/simulator/README.md)。实际 COM 对使用 `MODBUS_RTU_MASTER_PORT` / `MODBUS_RTU_SLAVE_PORT` 配置；全量审计必须检查是否发生跳过，参见 [审计记录](full-audit.md)。
