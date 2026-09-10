# Modbus Debugger

Modbus RTU / TCP 桌面调试工具（Electron + React + TypeScript）。

## 开发

    npm install
    npm run natives:node      # better-sqlite3 切换为 Node ABI（Vitest 需要）
    npm run lint
    npm run typecheck
    npm test                  # unit + integration
    npm start                 # 开发模式

## 独立模拟器（PyModbus，与 TS 客户端实现独立）

    npm run simulator                 # 默认 127.0.0.1:5020，units 1,2,3
    python tools/simulator/modbus_sim.py --port 50520

## E2E（WebdriverIO + Electron Service，针对打包版）

    npm run package
    npm run test:e2e          # 自动启动模拟器 + 打包版应用

E2E 使用 tools/e2e/demo.workspace.json 作为演示工作区（MODBUS_E2E_WORKSPACE 环境变量注入）。

## 生产构建 / 安装包

    npm run package           # out/Modbus Debugger-win32-x64
    npm run make              # out/make/squirrel.windows/x64/*Setup.exe
    node tools/smoke-installer.mjs   # 安装 → 启动 → 校验 → 卸载 冒烟

原生模块说明：better-sqlite3 为 ABI 敏感模块；tools/natives-electron/better_sqlite3.node
保存 Electron ABI 副本，打包钩子 packageAfterCopy 会将其注入安装包；
npm run natives:node 用于把项目 node_modules 恢复为 Node ABI 以运行 Vitest。
serialport 使用 N-API prebuilds，Node / Electron 通用。

## 目录

- src/domain 纯 TypeScript 领域层：协议编解码、流式分帧、映射、缩放、重叠校验
- src/main Electron 主进程：Connection Runtime / Scheduler / Block Cache / Recorder / SQLite / Workspace I/O
- src/renderer React 界面（App Rail + Context Sidebar + Main）
- tests/unit、tests/integration、tests/e2e
- tests/fixtures/protocol Golden 向量（expected bytes 由 tools/gen_protocol_fixtures.py 独立生成）
- docs/ 设计来源、规范、验收清单；docs/protocol/ 协议实现参考