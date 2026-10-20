# v0.11.4 发布验收记录

- 日期：2026-10-20（Asia/Shanghai）。
- 范围：用户明确要求提交、推送并发布；版本唯一来源为 `package.json` 的 0.11.4。
- 起点：`ba8df36` 之后的本轮修复；细化标准、故障复现与已完成的增量验证见[审核修复记录](../acceptance/audit-fixes-2026-10-20.md)。
- 应用功能源码提交：[`2525ebc`](https://github.com/loogg/modbus-debugger/commit/2525ebc9c4782619964ded9c343753ed76c80c36)，已正常推送到 `master`；发布标签包含后续测试清理等待修正及验收资料。
- 正式条件：[当前验收清单](../acceptance.md)。本文件持续更新，尚未执行的发布项不记为通过。
- 平台：Windows x64；Node.js 24.13.1；Python 3.11.7 / PyModbus 3.15.0。当前串口枚举为空，未配置 RTU 端口，不冒充真实串口验证。
- 全部运行数据、模拟器、数据库与临时产物隔离在 `out/test-temp/`。原有 `.agents/`、`skills-lock.json` 属于先前本地资料，不纳入本轮应用提交。

## 发布方案与基本标准

1. 对照现行清单运行全部适用 Unit / Integration、打包版 E2E、首次使用和百万样本容量场景；已有真实界面证据按代码影响复用，新增结果注明实际候选。
2. `npm run make -- --platform=win32 --arch=x64` 生成同版本目录、ZIP、Portable、Setup 及更新 manifest；四种形式 Smoke 均通过后才能发布。
3. 验证真实目录/ZIP、Portable、Setup 自升级与回滚；隔离测试中的未来版本不得发布或修改正式版本唯一来源。
4. 提交本轮应用修复、测试及验收资料；不提交运行数据或发布二进制。核对远端未前移、标签不存在后正常推送，不强制覆盖既有分支、标签或资产。
5. 使用现有标签工作流发布；等待 CI 构建、四产物 Smoke 与发布步骤完成，再检查 Release 版本、资产和下载有效性。

## 执行状态

| 范围 | 状态与结果 |
| --- | --- |
| 本轮缓存、写入、Bridge、隔离修复 | 增量闭环及正式源码候选复核通过，应用 `app.asar` SHA-256 仍为 `b31a09d6b071e49aca5c93b5387b4b318506aa39b4a9a2a854083c084736aa41` |
| 静态检查、Unit / Integration | lint、typecheck、差异与文档链接检查通过；发布阶段完整 Vitest 为 49 文件、392 通过、7 RTU 硬件用例跳过 |
| 完整打包版 E2E | 12 个 spec 的 59 项适用场景通过：首轮 10 个 spec 通过，另两个修正动态采样时机与无串口前置条件后完整复验通过。1 项真实 RTU UI 用例明确跳过 |
| 首次使用与百万样本 | 独立首次使用 1 项通过；100 万真实数值样本 1 项通过：会话打开 5,160 ms、回放 101 ms、游标及曲线重绘 244 ms、完整 CSV 导出 765 ms。剪贴板读回 28,888,904 字符，首末行及游标值正确 |
| 四种本地产物与 Smoke | `make` 成功生成目录、ZIP、Portable、Setup 及 manifest，均为 0.11.4 / x64；`smoke:release` 对四种形式的真实启动、Renderer / IPC / serialport / 历史库、Portable 中文/空格目录及重启持久化、显式数据目录、Setup 自选目录重装/卸载及数据保留全部通过 |
| 真实自升级与回滚 | 目录/ZIP、改名 Portable、Setup 从 0.11.4 到隔离测试版 0.11.5 的下载、SHA-256 校验、helper 安装、重启与数据保留通过。Setup 故障安装退出 23 后恢复至 0.11.4，通过旧 ASAR 哈希、安装登记版本及工作区/偏好/历史库/未知用户文件断言。0.11.5 仅是隔离夹具，未发布 |
| 真实 UI / 原生交互 | 本轮受影响实时页与鉴权入口已完成 Browser Review Mode + 内置浏览器真实操作；本地正式包与增量候选具有相同的应用 ASAR。另查看最终包 1440、1280、1279、1024 四档实时页截图；最窄窗口使用表格内部横向滚动。Native 设置、文件、剪贴板与安装操作均由真实打包版验证 |
| Git 提交、推送、标签 | 应用修复提交并推送完成；本地适用检查已收敛，验收资料提交与发布标签待执行 |
| GitHub CI 与公开 Release | 功能源码推送触发的 [Windows 构建](https://github.com/loogg/modbus-debugger/actions/runs/39402853215)已成功，包含四产物构建、Smoke 与资产上传；标签构建与公开 Release 待执行 |

当前结论：本地全部适用发布检查通过；RTU 硬件覆盖明确跳过。公开发布进行中，标签构建与线上资产核验完成前不记为已发布。

发布 E2E 补充说明：Raw Inspector 校验等待 Main 快照与 Renderer 当前样本一致，保留两寄存器、Float32 与完整字节断言；串口枚举为空时验证空白默认值、手动输入及取消，有可用端口时仍执行原自动预填与选项关闭断言。没有将测试条件修正计为真实串口验证，也没有降低设备确认值标准。

连续自升级验收补充：正常 Setup 升级成功后，卸载清理短暂晚于启动进程退出，紧接的回滚测试被既有安装隔离保护拦截。测试工具现有界等待安装登记与程序文件清理完成，保留未知用户文件断言；按正常升级 → 完整卸载 → 故障回滚 → 完整卸载连续复验通过。`node --check tools/smoke-self-update.mjs` 通过；该工具不进入应用 bundle，没有改动已验收的程序代码。

## 证据与覆盖边界

- 本地命令日志：`out/test-temp/release-0.11.4/` 下的 `make.log`、`vitest.log`、`e2e-full.log`、`e2e-retest.log`、`e2e-empty.log`、`e2e-capacity.log`、`smoke-release.log`。发布 E2E 使用仓库既有、与 Electron Chromium 130 匹配的本地 ChromeDriver，临时配置与数据均位于隔离目录。
- 百万样本指标与截图：`out/audit/capacity-1m-smoke.json`、`capacity-1m-history.png`、`capacity-1m-replay.png`；四档页面与弹层截图：`out/audit/screenshots/`、`out/audit/figma-current/`。这些为可重建的本地证据，不提交运行数据。
- 自升级命令日志：同一发布日志目录中的 `self-update-zip-portable.log`、`self-update-setup-final.log`、`self-update-rollback-final.log`；结果 JSON 为 `out/audit/self-update-{zip,portable,setup,setup-rollback}-result.json`，截图在 `out/audit/self-update-shots/`。仅 GitHub 元数据与包下载 HTTP 响应定向到隔离夹具，实际下载文件、校验、安装器、helper、备份、重启、数据库和注册表验证均为真实运行。
- [v0.11.1 的 30 屏 Figma 记录](figma-visual-audit-v0.11.1.md)仅保留为设计历史。本版受影响界面已重新真实审查，全 E2E 覆盖当前业务入口；不将历史图片冒充本版重新逐屏审查。
- 当前没有可用串口。纯协议与 Fake Transport 的 RTU 解析/恢复覆盖通过，7 项串口硬件测试与 1 项 Native RTU UI 测试明确跳过；未验证本版 Windows RTU 字节链路、物理 RS485 或现场设备。TCP 独立 PyModbus 互操作已通过。
