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

Main 是通信、调度、缓存、记录与文件 I/O 的权威状态源。Renderer 消费 Main Snapshot / delta；实时、趋势、记录复用同一 Block Cache。Modbus Client Core 为项目自己的 TypeScript PDU / RTU / TCP Codec，支持 FC01/02/03/04/05/06/15/16。详细约束见 [架构](architecture.md) 与 [AGENTS.md](../AGENTS.md)。

## 验证命令

按改动影响范围选择检查，普通修复不默认执行所有命令。

```powershell
npm run lint
npm run typecheck
npm test -- tests/unit/scan-options.test.ts
npm test -- tests/integration/runtime-tcp.test.ts
```

`npm test` 执行所有 Vitest 用例；也可传入 `tests/unit` / `tests/integration` 目录。监听修改使用 `npx vitest`。

E2E 通过 WebdriverIO + Electron Service 运行打包版，并自动启动 PyModbus：

```powershell
python -m pip install -r tools/simulator/requirements.txt
npm run package
npm run test:e2e -- --spec tests/e2e/app.e2e.ts --mochaOpts.grep "launches with"
```

需要全部 E2E 时运行 `npm run test:e2e`。固定 fixture 为 `tools/e2e/demo.workspace.json`，测试会复制后使用；临时数据、偏好和缓存在 `out/test-temp/`，不得写入日常 AppData 配置。本次 E2E 截图在 `out/audit/screenshots/`，文档截图独立维护于 `docs/images/`。

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

[Windows packages 工作流](../.github/workflows/windows-release.yml) 使用 Windows x64、Node.js 24、`npm ci` 和同一 `make` 流程。

- `master` / `main` 代码推送生成 Actions Artifacts；Markdown / `docs/` 变更不触发分支构建。
- `v<version>` 标签必须与 `package.json.version` 一致；成功后把 ZIP、Portable EXE、Setup EXE 附加到 GitHub Releases。
- 普通分支推送不自动创建版本发布；不得移动既有标签或覆盖发布资产。
- 云端执行交付产物 Smoke Test，不因为推送就重跑无关业务全量测试。

## 文档与截图维护

截图使用可复现的示例数据和实际运行的程序，不使用日常工作区。新增功能截图优先通过 Computer Use 采集，文件放 `docs/images/`；每张图说明入口、操作和结果。仅改文档时检查链接、图片、示例及命令一致性，不重新构建应用。

README 的组织参考了 [LocalSend](https://github.com/localsend/localsend/blob/main/README.md)、[Serial Studio](https://github.com/Serial-Studio/Serial-Studio/blob/master/README.md) 与 [ModbusScope](https://github.com/ModbusScope/ModbusScope/blob/master/README.md)：用户入口和快速上手放在显眼位置，工程细节链接到开发文档。截图和具体操作均以本项目为准。

串口/TCP 参数、完整数据区与故障注入见 [模拟器说明](../tools/simulator/README.md)。实际 COM 对使用 `MODBUS_RTU_MASTER_PORT` / `MODBUS_RTU_SLAVE_PORT` 配置；全量审计必须检查是否发生跳过，参见 [审计记录](full-audit.md)。
