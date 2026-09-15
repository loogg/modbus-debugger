# 功能审计（0.9.0）

本轮由用户明确要求全量核查。原测试命令成功只能表示当时已有用例通过，不能证明每个按钮完成。审计开始前基线为201个Vitest用例、22个E2E用例通过，但代码中仍存在未接线操作和实际通信错误。

## 原有证据的问题

- 写入E2E直接调用 `point.write`，绕过双击、输入、Enter和确认对话框。
- 扫描只要求“发现至少一个”，无法识别不存在的Unit被错误当成在线。
- 导入只打开页面，添加从站只打开并取消，未核对新增数据。
- DOM `.click()`可绕过遮挡；时区断言依赖本机UTC+8；整文件自动重试可能掩盖偶发失败。
- 单个点位ID用于多从站，单从站fixture无法发现串值和写错设备。

## 修复与对应证据

| 范围 | 修复/核查内容 | 主要证据 |
| --- | --- | --- |
| 独立模拟器 | CLI选择RTU/TCP、参数化端口、多Unit独立区、8种功能码、动态写值保留、故障注入 | `simulator-wire.test.ts`实际COM与TCP；`test_cli.py` |
| 扫描 | 未配置Unit不再响应异常04而被误发现；短RTU异常帧即时解析；停止/恢复/重扫 | wire、runtime、device-tools、audit E2E |
| RTU恢复 | CRC失败后新请求必须等待排空期，串口打开清理旧驱动缓存；TCP坏帧后部分头保留，恢复帧不重复投递 | wire corrupt-response、scan-rtu、transport回归 |
| 从站实例 | Point Cache、写入、趋势和记录以slave+point区分 | manager-delta多从站回归；RTU UI写入隔离TCP |
| 临时读取 | 默认10、失败原因、原始数据对应此次结果、保存实际地址块 | temp-read-feedback；audit E2E |
| 实时写入 | 高风险确认、非法Bool拒绝、字符串空值、写标记生命周期；刷新按钮实际读设备 | ValueCell组件、runtime、audit E2E |
| 确认缓存 | 初次超时不显示假零；地址/Unit改变清理缓存；Snapshot读取不吞后续delta | audit-regressions、manager-delta |
| 原始数据 | Inspector/内存布局不再固定零，读取真实缓存；事务保留真实响应ADU | manager-delta、audit E2E |
| 模板 | 复制重新生成点位/块ID，保存写文件，导入地址/类型/宽度校验；编辑立即发布delta，避免导出旧内容 | audit-regressions、audit E2E |
| 趋势 | 暂停冻结时间窗、恢复、窗口保存、显隐/移除；按物理单位独立纵轴，多于两类单位拆图；避免停止其他组记录；缩短块周期立即重新调度 | audit E2E与历史采样回归 |
| 历史 | 添加备注实际入库，CSV转义，日期/趋势组/从站筛选，回放控制 | manager-delta、audit E2E |
| 通信 | 暂停、搜索、从站/结果筛选、清空接线；追踪真实连接和写入来源 | audit E2E、既有诊断回归 |
| 设置/文件 | 导航锚点、另存/导入/导出、失败保留当前工作区 | workspace/persistence与audit E2E |
| 布局/提示 | 提示内容不再挡住保存按钮；主区域移除强制最小宽度；紧凑图表隐藏重叠时间刻度 | 实际点击、四窗口布局断言与截图 |
| Portable | 等待短暂文件占用后重试删除解压目录，清理失败明确非零退出 | Portable cleanup regression与最终Smoke |

## 页面操作盘点

| 页面 | 已执行的实际交互/结果验证 |
| --- | --- |
| 设备/连接 | 新建RTU连接（CLI从站+真实串口）、枚举/自填串口和波特率、创建绑定/不绑定模板的从站、连接/断开、离线改参数保存、在线锁定、拓扑与数据块导航 |
| 扫描 | 默认折叠/展开/折叠保留参数、范围及探测地址、精确发现结果、异常响应仍判定设备存在、停止后保留结果、重新扫描替换结果、不自动加入设备、结果行添加预填Unit |
| 临时读取 | 默认10、输入非法时禁用、成功读取、原始数据、设备异常及Trace ID、跳转诊断、保存非重叠数据块；组件/Runtime另覆盖断线、超时和扫描占用 |
| 实时 | 确认值刷新、双击/Enter写入并读回、Esc取消、只读、非法Bool拒绝、高风险确认/取消、手动刷新真实发包、全选加入趋势、紧凑表格内部滚动 |
| 模板 | 新建/复制、块创建、点位创建/编辑、越界保存失败仍保留表单、映射/内存/块设置页、真实内存、CSV粘贴预览与实际导入、Unsigned/Float宽度、保存文件、导出后独立导入 |
| 趋势 | 新建、添加信号、复制/删除组、显隐/移除信号、列表/图表切换、窗口保存、暂停/继续、开始/停止记录并产生样本 |
| 历史 | 选择会话、时区同步、信号/数据/趋势/事件页、添加备注入库、CSV转义、回放播放/暂停/游标及返回；从站筛选/清除实际点击，日期及趋势组组合筛选有组件回归 |
| 通信 | 报文/健康/来源追踪、帧详情、搜索、仅异常、暂停/恢复、清空、日志导出；从站/结果过滤实现逐项代码审核 |
| 设置 | 导航、另存为、导出、无效导入保持原工作区、诊断清空取消/确认、时区往返；路径/偏好持久化有集成和产物Smoke验证 |

不是“每个参数所有组合”穷举。文件选择器的系统窗口被定向返回路径；协议核心的非法帧、边界数量与故障使用单元/集成或独立模拟器验证，未把这些称为UI点击验证。

## 执行记录

2026-09-14，Windows x64，Node/npm + Python/PyModbus 3.15.0，应用0.9.0：

| 命令/检查 | 实际结果 | 证据（本地，不入Git） |
| --- | --- | --- |
| `npm run lint` / `npm run typecheck` | 通过 | `out/audit/lint.log`、`typecheck.log` |
| `npm test`（传入实际串口对） | 25文件、228用例通过，0失败、0跳过；包含10个独立模拟器TCP/RTU互操作用例 | `out/audit/full-vitest.log` |
| `python -m unittest discover -s tools/simulator -p test_cli.py` | 2组通过，覆盖帮助信息及9种非法CLI配置 | `out/audit/simulator-cli.log` |
| `npm run test:e2e`（传入实际串口对，关闭spec重试） | 3文件、34用例通过，0失败、0跳过 | `out/audit/full-e2e.log` |

34个E2E中包括7页面×4窗口尺寸（1440×960、1280×960、1279×960、1024×680）的布局断言和截图。完整业务回归后只调整了图表时间刻度的重叠隐藏，补跑图表组件及定向布局检查；没有再次机械重跑无关业务。最终补验也已通过：

- `npm run test:e2e -- --spec tests/e2e/app.e2e.ts --mochaOpts.grep "all main pages"`：1个定向用例、7页面×4尺寸通过，见 `out/audit/viewport.log`。截图在 `out/audit/screenshots/`，复核了实时表、双轴趋势/历史、通信、设备、模板和设置的实际布局。
- `npm run make`：目录、ZIP、Portable、Setup四种0.9.0 Windows x64产物成功生成，见 `out/audit/make-final.log`。
- `npm run smoke:release`：四种产物启动、Portable二次启动和持久化、退出解压目录清理、自定义数据目录、Setup自选目录安装/重装/保留数据/卸载全部通过。日常AppData偏好未变化。见 `out/audit/smoke-release.log`。
- 发布目录与被测打包目录的 `app.asar` SHA256一致；ZIP解压代码与目录版一致。校验记录在 `out/audit/artifact-hashes.json`。
- 最终失败0项；明确启用了COM串口对，完整运行无RTU跳过。定向命令只执行指定用例，不将其余未运行项计作该轮通过。

产物位于 `release/modbus-debugger-0.9.0-win-x64/` 及同名ZIP、`-Portable.exe`、`-Setup.exe`。测试环境清理只涉及本轮创建的 `out/test-temp/` 目录，用户安装/用户数据不会被测试作为清理目标。

## 边界

真实虚拟串口使用本机COM1（上位机）↔COM2（从站），由环境变量/CLI传入；TCP使用独立PyModbus进程。虚拟链路不验证物理RS485电气层或所有厂商设备。模拟器“全部功能”限定为本工具支持的8种Modbus功能码。文件选择器自动化会选择指定fixture路径，后续I/O真实执行。测试成功不代表无Bug，也不涵盖所有参数组合。

## 0.9.1：显示问题定向补验

用户指出0.9.0历史字符串轨道叠字。此前全量记录未覆盖初始值与首条相同事件的实际文字交叠，确认属于漏项，已修复；结果侧栏复选框此前只有代码审核，不能算逐项UI验收。

- 字符串轨道初始状态与相同首条事件合并，密集变化的文字避让、长字符串省略，全部变化点及完整值提示保留。打包版用SVG实际文字边界验证不越出轨道，截图 `out/audit/followup-shots/string-track.png`。
- 侧栏成功/超时/Modbus异常分别通过真实TCP报文逐项点击验证；CRC、格式错误、传输错误、意外响应归入新增的“其他错误”，避免错误地混在Modbus异常中。组件测试覆盖全部类别、全部不选、搜索与从站过滤组合。
- 时区用同一traceId在UTC和Asia/Shanghai之间切换，显示相差8小时，原始UTC不变。历史/回放的 `00:00:00` 是相对时长，应当不随时区改变。
- 多信号：组件验证12条数值信号/4种单位全部保留，以及隐藏单位组后回到双轴；打包UI验证9个混合信号（6条数值曲线、5种单位）和动态显隐。按单位而不是信号数量分轴：同单位共享轴，2种单位双轴，超过2种单位分图；Bool/Enum/String使用状态轨道。
- 定向结果：5个文件20个单元/组件测试、3个打包E2E通过，相关lint/typecheck通过。日志为 `out/audit/followup-unit.log`、`followup-typecheck.log`、`followup-e2e.log`；没有运行无关全量回归。
- 该次定向补验只构建测试所需0.9.1目录版：`out/Modbus Debugger-win32-x64/modbus-debugger.exe`。当时`release/`中的0.9.0文件尚未重打；后续0.9.1正式产物验证见下文。


## 0.9.1：打包与发布验证

用户要求补齐应用测试、打包及推送发布后，再次复核：

- lint、typecheck通过；20个定向单元/组件用例和3个打包E2E通过，见 `out/audit/publish-lint.log`、`publish-typecheck.log`、`publish-unit.log`、`publish-e2e.log`。未机械重跑无关业务全量用例。
- `npm run make -- --platform=win32 --arch=x64`成功生成同一版本、同次构建的目录、ZIP、Portable、Setup，直接放在 `release/`，见 `out/audit/publish-make.log`。
- `npm run smoke:release`通过四种产物启动、Portable重启/数据保留/解压目录清理、自定义数据目录、Setup自选目录安装/重装/卸载。卸载保留用户数据，日常AppData偏好未变化，见 `out/audit/publish-smoke.log`。
- 发布标签固定为与 `package.json` 一致的 `v0.9.1`；GitHub Actions另外构建并验证云端产物，成功后自动附加ZIP、Portable和Setup到对应Release。

### GitHub 发布结果

- 已推送代码及不可变更的 `v0.9.1` 标签，发布源码提交为 `ea13603c6b8dac24323d01e2a694602f004fc8b5`。
- [分支构建](https://github.com/loogg/modbus-debugger/actions/runs/34860885420)成功。
- [标签构建](https://github.com/loogg/modbus-debugger/actions/runs/34860885646)第二次执行成功，build和publish均通过。首次执行的全部产物功能检查通过，但在卸载后删除测试临时目录时出现Windows `EPERM`，因此整次流程判失败、发布未执行；保留失败记录，未修改标签或跳过检查，完整重试后成功。没有将首次失败隐去，也没有把临时清理问题说成已通过代码修复。
- [v0.9.1 Release](https://github.com/loogg/modbus-debugger/releases/tag/v0.9.1)已正式发布（非草稿、非预发布），已核对三个附件均为uploaded且大小非零：`modbus-debugger-0.9.1-win-x64.zip`、`modbus-debugger-0.9.1-win-x64-Portable.exe`、`modbus-debugger-0.9.1-win-x64-Setup.exe`。

## 0.10.0：关于与手动下载更新

- 已增加左侧底部“关于”，当前版本来自Main的app.getVersion，支持GitHub、更新日志、手动检查、下载进度、取消/重试、验证后打开下载目录。
- 只检查本项目GitHub Releases正式版本；按数值比较版本，禁止降级。Setup/Portable/目录版分别匹配Setup/Portable/ZIP同架构附件，缺少匹配附件不能下载。
- 下载和SHA-256/大小校验在Main完成，完整文件位于data/updates，临时文件位于temp/updates；切换页面和下载不影响已有Modbus轮询。取消/退出等待任务收尾，不删除其他用户文件。
- 实际GitHub附件测试发现Electron33的manual重定向模式会抛出Redirect was cancelled，已使用原生follow并校验返回地址（若提供）和文件摘要；没有仅以模拟响应通过作为实际网络可用的证据。
- 定向验证：51个相关单元/集成/组件用例通过，含版本/包型匹配、未知架构、草稿与预发布拒绝、HTTP错误/限流、元信息限制、大小与摘要错误、取消清理、缓存复用、重新校验文件、重复请求、Snapshot/delta及关于页按钮；相关lint、typecheck通过。
- 打包版5个E2E通过：真实GitHub版本查询、真实GitHub附件跳转与首段ZIP数据读取；通过受控HTTP响应验证完整下载、真实落盘与校验、打开目录目标、跨页面下载与取消、限流/校验失败、1024×680布局。下载期间继续产生真实模拟器TCP事务。受控响应的测试版本v99.0.0仅为fixture，没有发布到GitHub，也没有把fixture当作真实的新版本安装包。
- 本轮验证的是“检查→下载→校验→打开目录按提示升级”，不包含自动安装/自动重启或替换正在运行的EXE。首次使用需要手动获取带“关于”的版本，之后可由该入口检查和下载新包。
- 日志：out/audit/update-validation.log（51 passed）、update-e2e.log（5 passed）、update-lint.log、update-typecheck.log、update-package.log；截图在out/audit/update-shots/。只为E2E构建了0.10.0目录版，未在本轮运行make、安装卸载或创建GitHub Release。

## 0.10.1：自动安装更新与重启

- 下载校验后提供“安装更新并重启”及确认提示。Main 先准备更新、保存工作区、结束记录和通信，再将安装交给独立助手。目录/ZIP 自动解压，Portable 替换外层 EXE 并保留原文件名，Setup 沿用原目录静默安装。新版本完成工作区加载和 Renderer 挂载后确认启动，失败时恢复旧程序。
- 按 SHA-256 程序文件清单安装和卸载，拒绝 ZIP 越界、链接和用户文件冲突，保留未知文件及自选数据目录。Setup 同时备份/恢复安装注册表项。Release 新增 `*-manifest.json` 辅助附件，四种交付形式不变。
- Windows x64 实际自升级通过：目录、Portable、Setup 从 0.10.1 升到本机 0.10.2 测试包，通过真实按钮下载、确认安装、退出和重启；核对新进程版本、原工作区路径与内容、UTC 偏好、SQLite 自定义表数据、额外用户文件及程序备份。覆盖中文/空格目录、Portable 外层 EXE 改名、目录版 `--data-dir`。日志：`self-update-zip-verified.log`、`self-update-portable-final.log`、`self-update-setup-final.log`（均在 `out/audit/`）。
- 失败回滚通过：可执行故障注入安装器真实改坏 `app.asar` 和安装版本登记后退出 23；助手恢复原文件摘要和注册表版本，重新启动 0.10.1，工作区/数据库/用户文件仍在。见 `out/audit/self-update-rollback-complete.log` 和 `self-update-setup-rollback-result.json`。故障安装器是受控测试附件，未将其当作正常 NSIS 安装器；正常 Setup 升级另有上述实际测试。
- 47 项相关 Unit / Integration / 组件检查通过（30 更新服务、5 关于 UI、5 打包规则、7 原生助手/清单/启动令牌/中文父进程）；原生失败用例含不可启动 EXE、用户文件冲突及 ZIP 越界。相关 lint、typecheck 通过。结果分布于 `self-update-service.log`、`self-update-helper-3.log`、`self-update-parent.log`、`self-update-release-tests.log`。
- 关于页 5 项打包版 E2E 完成：真实 GitHub 查询与附件首段、完整下载/校验/打开路径、跨页面取消、失败恢复、1024×680。首次运行 4 通过/1 失败，失败源于 WDIO 在测试进程重放 mock 时没有 Main fixture；修正测试边界后只重跑该用例并通过，未自动重试掩盖失败。见 `self-update-e2e.log`、`self-update-e2e-download.log`。
- 实际应用测试发现并修复了普通子进程随 Electron 退出、detached PowerShell 空执行、Windows 控制台中文编码、NSIS 缺少 InstallLocation、打包器添加清单外 elevate.exe 等问题。单独脚本通过没有被当成跨进程更新通过。测试脚本也修正了异步按钮状态与重启后的 DevTools 端点等待。
- 自升级用例只在 GitHub HTTP 边界提供本机测试附件；应用、文件替换、安装、回滚、重启及版本快照均真实执行。测试版没有发布到 GitHub。未运行无关业务全量回归，未推送或发布此版本。
- 最终 `release/` 已生成 0.10.1 的目录、ZIP、Portable、Setup 和辅助清单。目录/ZIP 逐文件清单与摘要一致，外部清单与包内清单一致。四种产物启动、Portable 重启/数据保留、自选数据目录、Setup 安装/重装/卸载功能检查通过。初次完整 Smoke 在清理安装测试空目录时遇到 Windows `EPERM`，没有将该命令标作成功；目录随后可删除，清理改为对暂时占用进行有上限等待，再单独补跑安装器并通过（实际触发了等待分支）。见 `self-update-smoke-release.log` 和 `self-update-installer-final.log`，没有重跑无关业务回归。

### 0.10.1 GitHub 发布记录

- 已推送源码提交 `7f1ed8a1b13fdcb88b4082b08a90ffb3f7a46f9a` 及对应的 `v0.10.1` 标签，未移动已有标签或覆盖已有发布附件。
- [标签发布任务](https://github.com/loogg/modbus-debugger/actions/runs/34973709204)的 build、publish 均成功；云端四种产物启动、Portable 持久化、自选数据目录、Setup 安装/重装/卸载检查全部通过。同一提交触发的[重复分支任务](https://github.com/loogg/modbus-debugger/actions/runs/34973709482)主动取消，避免重复构建。
- [v0.10.1 Release](https://github.com/loogg/modbus-debugger/releases/tag/v0.10.1)已正式公开并设为最新版本，非草稿、非预发布。ZIP、Portable.exe、Setup.exe、manifest.json 四个附件均为 uploaded、大小非零且提供 SHA-256；已下载云端清单核对摘要、版本及 85 个程序文件条目。
- 云端日志和清单保存在本地 `out/audit/github-v0.10.1/`。本次发布复用既有功能验收，未重跑无关业务全量测试。

## 0.10.2：模板树、点位内存布局与数据块保存

- 修复模板侧栏没有子块、返回模板时残留块编辑状态的问题；模板节点进入概览，子节点打开对应块，块页提供返回入口。设备页和“查看模板”入口也清除旧的块选择状态。
- 内存布局按模板定义显示点位占用，与设备连接/缓存无关：Float32 连续两寄存器、字节/位字段、重叠映射及 String 均可显示；超过 32 个地址分页，不再截断后面的点位。点击映射跳回点位详情。
- 模板概览可保存名称、添加/打开/删除数据块。删除先说明影响范围，Main 删除块及点位并清理绑定实例的相关趋势引用，其他模板和历史数据不删除。
- 数据块保存改为 Main 的 `template.save`，不调用文件选择器。未命名工作区保存到默认 `data/workspaces/`，后续复用同一路径；已有工作区沿用原文件，导出/另存为保持独立。
- 13 项相关 Unit/Integration/组件检查通过：映射跨度、无缓存布局、分页、树导航/跨模板返回、保存命令、改名、取消/确认删除、删除边界、真实保存及重新读取，另覆盖既有 Store 偏好同步。相关 lint、typecheck 通过。日志：`out/audit/template-tests-final.log`、`template-store-tests.log`。
- 打包版两组实际按钮流程通过：离线 Ia/Ib 映射、新增点位后立即显示、布局与点位详情跳转、保存时文件选择器调用次数为 0、实际文件内容、模板改名及删除后持久化。检查 1440 标准及 1024 紧凑窗口，无文档横向溢出。首次 E2E 的新增点位选择器错误地将既有 Drawer 当作 role=dialog，修正选择器并隔离用例后通过，未用自动重试掩盖失败。日志：`template-e2e.log`、`template-e2e-final.log`；截图：`out/audit/template-shots/`。
- 参考 Figma 正式 05 模板库、06 模板编辑，按本次需求扩展树形与管理操作；README 已替换为实际界面截图。只生成 E2E 所需的 0.10.2 目录版，未运行无关全量回归、四种产物 make 或推送发布；GitHub 和 release/ 中的正式产物仍是 0.10.1。

### 0.10.2 本地审核包

- 按用户要求，对提交 `7be0cf2`（含模板编辑修复和 16px 立方体数据块图标）运行正式 make，四种产物及辅助清单均已平铺到 `release/`。旧版本目录中的运行数据按规则保留到 `release/data/backups/`。
- 四种产物启动、程序文件清单校验、Portable 重启与持久化、自选数据目录、Setup 安装/重装/卸载检查全部通过。实际运行目录版核对了新图标的 16px SVG 和模板/内存布局页面。
- 日志：`out/audit/review-0.10.2-make.log`、`review-0.10.2-smoke.log`；截图：`review-0.10.2-template.png`、`review-0.10.2-memory.png`。日常偏好未变化，复用既有业务验证，未重跑全量回归。
- 此次仅供本地审核，未推送或发布 GitHub Release。
