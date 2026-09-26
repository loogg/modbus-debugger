# 验证与审计历史

以下记录保留各版本当时的验证结果、失败和边界；不代表当前源码或当前版本已通过同样的检查。现行验收条件见 [验收清单](acceptance.md)。

## 验收证据（2026-09-11）

- lint：eslint 0 error；typecheck：tsc --noEmit 0 error。
- unit + integration + UI 组件：Vitest 140 tests passed（协议 Golden、流式分帧/Resync、校验分类、映射/缩放、重叠、Workspace/History 持久化、Runtime 调度/RMW/Scanner/TemporaryRead、诊断游标/健康序列、Manager snapshot-delta 管线、PyModbus 模拟器互操作、ComboInput 下拉生命周期、DataTable 行 memo）。
- E2E：WebdriverIO + @wdio/electron-service 针对打包版 21 tests passed（app.e2e.ts 9：拓扑、实时刷新、写+回读、通信日志+帧详情+健康曲线、趋势图表、从站扫描、临时读取、连接设置锁定态、1024 紧凑窗口；full-features.e2e.ts 13：添加连接/下拉自动关闭、串口默认首口与选中即关闭、添加从站与 Unit ID 冲突、无模板添加从站、实时表编辑态、模板编辑、导入寄存器表、趋势→历史全链路、连接健康与点位追踪、连接设置 断开→改→保存→连接→再锁定、下拉生命周期四路径、设置页），截图存 tests/e2e/screenshots/。
- Production Build：npm run package 成功；打包版无 ABI 敏感原生依赖（历史存储 sql.js/WASM，串口 serialport N-API prebuilds）。
- Installer Smoke（tools/smoke-installer.mjs，任一步失败即 exit 1）：Squirrel Setup 静默安装 → 校验 `%LocalAppData%\modbus-debugger\app-<version>` → 启动已安装 exe 并断言窗口标题 → 结束进程 → `Update.exe --uninstall -s` → 断言安装树已删除。
- 模拟器：tools/simulator/modbus_sim.py（PyModbus 3.15，独立实现）提供 units 1-3、动态数值/Bool 边沿/Enum/String/写支持。

## 上位机全量功能自测（tests/e2e/full-features.e2e.ts，打包版 + 模拟器）

- [x] 添加连接：串口下拉每次打开重新枚举可用串口；波特率预设 + 自定义输入；高级设置（帧间隔/RTS/日志级别）。
- [x] 添加从站：对话框字段与 Unit ID 冲突检查。
- [x] 实时表：双击进入编辑态、Esc 取消、确认值不被污染。
- [x] 模板编辑：点位表、映射详情、编辑点位抽屉（内存映射/缩放/枚举/映射预览）。
- [x] 导入寄存器表：字段映射 / 预览与转换 / 数据块策略 步骤界面。
- [x] 趋势记录 → 历史会话 → 会话信号页（Schema Snapshot / 记录方式）全链路。
- [x] 通信：连接健康指标卡、真实 1 Hz 采样的 5 分钟曲线与数据块性能表；报文行点击驱动帧详情；点位追踪来源追踪与原始帧。
- [x] 设置：工作区文件 / 地址规则 / 记录与历史 / 写入安全。
- [x] 连接设置：点击侧栏连接后主区显示该连接的状态、连接/断开按钮、参数表单、从站列表 + 添加从站 + 扫描/临时读取。
- [x] 连接在线时参数锁定（输入/下拉禁用，保存禁用并提示），断开后可编辑保存；保存不自动重连，需显式「连接」；扫描/临时读取要求连接状态（E2E 覆盖 断开→改→保存→连接→再锁定 全链路）。
- [x] 串口在添加连接与连接设置中均为下拉（每次打开重新枚举）+ 可手工输入；新建连接默认填入本机第一个可用串口；选中选项后下拉自动关闭。
- [x] 下拉视觉统一：Radix Select 与 ComboInput 共用面板/行样式（触发器等宽面板、圆角、投影、hover/选中态、选中标记），锁定态输入有禁用样式。
- [x] 从站状态诚实显示：enabled 且连接 online 才显示「在线」，否则 离线/连接中/连接异常/停用。
- [x] 时间显示统一：侧栏会话时间与详情页表头为同一时区的同一时刻；设置页可切换时区（跟随系统 / IANA 名称），切换后侧栏、表头、报文、图表轴整体偏移；存储与日志仍为 UTC（time 单元 6 项 + E2E 断言 UTC 与本机 +8 偏移）。
- [x] 多语言接口：i18next + react-i18next，类型化分片词典（缺失 key 编译期报错），设置页语言选择并持久化；当前仅接入简体中文，渲染层文案全部经 t() 输出。
- [x]  prefs / dirty / warnings 由 Main 经 delta 下发（独立变更追踪，快照对齐游标）；Renderer 在事务分支 early return 之前应用 prefs，轮询期间的 prefs.set 不再被静默丢弃（store 单元 5 项 + Manager 集成 3 项回归）。
- [x]  历史回放时间轴为会话内偏移（xMode="duration"），与事件表/回放游标一致；实时趋势轴为显示时区墙钟；不再出现 epoch 0 刻度。
- [x] 下拉框自动关闭：选择选项 / 失焦 / Esc（分层：先关列表再关 Dialog）/ 点击外部 四条路径均有 E2E 与组件测试；**选择选项一律真实鼠标点击**；根因为 `Field` 误用 `<label>`（label 把选项文本 span 的点击转发给 input 触发重开，且仅当点击点落在长文本上时发生），现改为 labelled group，并断言选中后列表保持关闭、聚焦时真实 chevron 点击展开后保持展开。
- [x] 无模板添加从站：模板下拉含「（暂不绑定模板）」，Unit ID 冲突是唯一的禁用条件；未绑定从站不参与轮询。
- [x] 扫描 / 临时读取 / 保存为数据块入口（app.e2e.ts）。
- [x] 窗口自适应：1440 与 1024 截图审核（app.e2e.ts）。

## 本轮迭代证据（UI 反馈修复）

- [x] 串口为下拉选择：每次打开下拉通过 serial.list 重新枚举当前可用串口，仍可手工输入（添加连接对话框）。
- [x] 波特率下拉扩展预设（1200…1000000）并支持自定义输入。
- [x] 临时读取 / 添加从站 入口修复：无从站时设备页工具入口与空态按钮均可用（E2E 覆盖）。
- [x] 应用图标：build/icon.ico + icon.png（Fluent 蓝 + RTU 方波 + 寄存器网格），用于 exe / 安装器 / 窗口图标。
- [x] RTU 分帧不再使用 t1.5/t3.5 时序（不作判决也不作 hint）：预期长度 + CRC + 可信边界扫描 + 有界等待；strict 模式不保留。
- [x] 全量功能自测：tests/e2e/full-features.e2e.ts 8 项 + app.e2e.ts 8 项 = 16 项全部通过（打包版 + PyModbus 模拟器）。

- [x] 重试策略：读类 timeout/transport 按 retries 重试（50ms 退避），exception 不重试；写 timeout/CRC 不重试、仅 transport 重试（集成测试 3 项覆盖）。
- [x] 日志级别：info=应用内通信诊断；debug=额外记录 TX/RX 原始 ADU 与重试决策到 electron-log。

- [x] 日志落盘在执行目录 <exe>/logs/（不放系统盘）；history.db 默认 <exe>/data/，设置页显示真实路径。
- [x] 连接参数可编辑：设备页连接行「编辑」→ 添加连接对话框编辑模式 → 保存即更新运行时（E2E 覆盖）。
- [x] 收到合法 Exception Response 立即结算（不再等超时）；坏帧/不匹配帧仍等超时后按重试策略处理（集成测试断言结算耗时 < timeout）。
- [x] 关闭上位机优雅释放资源：before-quit await 停止全部 Runtime（串口/TCP/定时器）+ flush history/workspace（集成测试覆盖 transport 关闭）。

## 本轮迭代证据（构建迁移 Vite + 性能 + 第五轮 UI 反馈）

### 构建方式迁移：Forge Webpack → Forge Vite

- [x] `@electron-forge/plugin-vite` + `vite@5` + `@vitejs/plugin-react`；删除 `webpack.main.config.ts` / `webpack.renderer.config.ts` / `webpack.rules.ts` 与 `src/renderer/index.html`，入口改为仓库根 `index.html`。
- [x] Main / Preload 打包为 CJS（`.vite/build/index.js` / `preload.js`）；Renderer 单文件 IIFE bundle，经特权 `app://` scheme 提供（`registerSchemesAsPrivileged` + `protocol.handle` + `net.fetch(pathToFileURL)`），webSecurity / sandbox 保持开启。
- [x] `sql.js` 声明为 external（UMD 被 Vite 打包会抛 `Cannot set properties of undefined (setting 'exports')`），`sql-wasm.wasm` 用 `createRequire(...).resolve('sql.js')` 同目录解析；`packageAfterCopy` 钩子复制 external 依赖进 asar。
- [x] 修复打包版启动崩溃：`electron-squirrel-startup` 的裸 `require()` 被 rollup 原样保留为运行时 require（包内无 node_modules）→ 改为 ESM import 进 bundle；并在 `vite-env.d.ts` 补类型声明。
- [x] 清理随迁移失效的 ABI 工作流：删除 `natives:electron` / `natives:node` 脚本、`tools/stash-native.cjs`、钩子中的 better-sqlite3 stash 分支；项目已无 ABI 敏感原生模块。
- [x] 文档同步：AGENTS.md 基线、architecture.md 新增「构建与打包（Vite）」、README 重写构建/存储章节、acceptance 本清单。

### 性能（“整个上位机卡顿”）

- [x] Main 侧每 tick 成本改为 O(变化量)：诊断环形缓冲改用绝对游标（此前每 tick 复制最多 5000 条记录，且满环后按长度比较会彻底停止推送）；`lastOkUtcFor` 增量维护；`pointIndex()` 按 `WorkspaceService.revision` 缓存；健康 1 Hz 缓存 + 告警 5 s 一次。
- [x] `buildSnapshot()` 对齐 delta 游标，快照已含的事务不再被后续 delta 重复推送；`diagnostics.clear` 通过 `diagRev` 通知 Renderer 清空本地副本。
- [x] Renderer 订阅规则重写：根组件只订阅 `useSnapshotReady()`（此前订阅整个 snapshot，每次 delta 全树重渲染并使下层窄选择器失效）；新增切片 hook（useWorkspace/usePoints/useBlocks/useConnectionStates/useTransactions/useHealth/useSessions/useRecording/usePrefs/useConnectionState）并迁移全部 33 处 `s.snapshot` 订阅。
- [x] 表格行 memo：`DataTable` 行按 row + columns 身份比较，调用方 columns 用 useMemo 稳定；实时表行按实际绘制的原始值比较，虚拟列表定位外移；趋势缓冲改为就地 push + 前端裁剪（此前每个 delta 对每个点位复制 5000 元素数组）。
- [x] ECharts `setOption` 合并到 ≤4 Hz。
- [x] ESLint 启用 `react-hooks/rules-of-hooks` = error：迁移过程中该规则直接拦下 3 处「Hook 在 early return 之后调用」（运行时会卸载整棵树 → 窗口白屏），已全部修复。
- [x] 回归测试：`tests/unit/ui/data-table.test.tsx`（行 memo 契约）、`tests/integration/manager-delta.test.ts`（游标/健康采样/diagRev/1 Hz 健康推送）。

### 第五轮 UI 反馈

- [x] 侧栏连接行的「编辑」入口移除：点击连接即在右侧主区显示「连接设置 + 从站列表 + 添加从站 + 扫描/临时读取」，设置可编辑并保存（`ConnectionSettingsView`，按 connectionId 重挂载）。
- [x] 添加连接对话框编辑既有连接时，所有字段（含数据位/校验/停止位/名称）从既有连接初始化，保存不再静默重置。
- [x] 下拉框自动关闭：选择/失焦/Esc/点击外部；Esc 分层（列表打开时先关列表并 stopPropagation，第二次才关 Dialog）；已聚焦的输入再次点击会重新展开。
- [x] 无模板可添加从站：模板下拉含「（暂不绑定模板）」，默认 Unit ID 取该连接首个空闲值；未绑定从站不进入轮询目标。
- [x] 连接健康 5 分钟曲线改为真实数据：Main 每次健康重算记录 1 Hz `HealthSample`（环形 600 点），页面经 `diagnostics.healthSeries` 命令每 5 s 拉取；删除原硬编码空 series 占位。
- [x] 修复配置超时不生效：`attemptRequest` 使用 `opts.timeoutMs ?? connection.timeoutMs`（此前所有请求路径回落到硬编码 500 ms）；Scanner 保留显式短探测超时；集成测试断言 60/80 ms 配置真实生效。
- [x] 修复报文行点击不生效：旧实现依赖不存在的 `data-idx` 属性；改为 `DataTable.onRowClick`。
- [x] E2E fixture 防污染：`wdio.conf.ts` 的 `onPrepare` 把 `tools/e2e/demo.workspace.json` 复制到临时目录再注入 `MODBUS_E2E_WORKSPACE`（此前一次失败运行会把 fixture 的连接名改写，导致后续所有运行从不同世界开始）。

## 本轮迭代证据（连接生命周期 + 下拉体验）

- [x] 连接设置页加入连接生命周期：状态徽标 + 「连接 / 断开连接」按钮；online/connecting 时参数表单与保存整体锁定并给出提示，断开后可编辑保存；保存不自动重连（RuntimeManager.userOffline 记录用户意图，配置重建 Runtime 时保留），扫描/临时读取要求连接状态。
- [x] 串口在连接设置页同样为下拉（打开时重新枚举）+ 可手工输入；新建连接打开时即枚举并把默认值设为本机第一个可用串口；选中选项后下拉自动关闭（E2E 对 port-combo 与 baud-combo 均断言）。
- [x] 下拉视觉统一：Radix Select 面板宽度对齐触发器（`--radix-select-trigger-width`），与 ComboInput 共用面板/行样式（圆角、投影、hover/选中态、Checkmark 选中标记）；锁定输入有禁用样式。
- [x] 从站状态改为诚实显示（enabled 且连接 online 才「在线」；否则 离线/连接中/连接异常/停用），设置页与侧栏一致。
- [x] ConnectionRuntime.start() 幂等（重复 start 不叠加调度定时器）。
- [x] 截图审核：01B-connection-settings-1440（锁定态）、01C-connection-settings-offline-1440（可编辑态）、25-combo-open-1440、26-select-open-1440。

## 本轮迭代（显示时区 / 多语言 / prefs delta 修复，v0.4.0）

- [x]  时间显示统一：侧栏会话时间、详情页表头、报文表、图表轴共用 `src/renderer/time.ts`（Intl + 配置时区）；消除 UTC slice 与 OS 本地 `toTimeString()` 混用造成的 8 小时偏差。
- [x]  设置页新增「时区」（跟随系统 / 12 个 IANA 选项）与「语言」下拉并持久化到 prefs；切换后侧栏、表头、报文、图表整体偏移，存储与日志仍为 UTC。E2E 断言：侧栏与表头同一时刻、切 UTC 后小时 -8、切回跟随系统后还原。
- [x]  多语言接口落地：i18next + react-i18next，12 个按界面区域分片的类型化词典（shell/devices/overlays/realtime/trend/comm/history/templates/settings/ui），渲染层 0 处中文硬编码（仅注释保留）；缺失 key 编译期报错；当前仅接入 zh-CN。
- [x]  修复 prefs / dirty / warnings 从不进 delta 的架构缺陷，以及 `applyDelta` 事务分支 early return 吞掉 prefs 的顺序缺陷；`prefs.set` 的 zod schema 显式声明 timezone / language 并不再 passthrough 未知键。
- [x]  修复历史回放把会话内偏移当 epoch 渲染的缺陷（图表轴 / tooltip / StateTrack 边沿时间），新增 `xMode="duration"`；会话开始时间改用显示时区格式化。
- [x]  新增截图：12-templates-1440、14-history-1440、21-settings-1440（含时区/语言控件断言）、22-history-utc-1440（UTC 偏移证据）。
- [x]  回归：lint 0、tsc 0、Vitest 136、E2E 22（打包版 + PyModbus）、npm run package、npm run make、tools/smoke-installer.mjs 全通过。

## 本轮迭代（下拉框真实鼠标关闭修复，v0.4.1）

- [x]  修复 ComboInput 「选中后不自动消失」：真实鼠标点击下 Chrome 在选项节点卸载后向输入框补发重定向 click，输入框的点击重开逻辑会立刻重开刚关闭的列表；选中后记 200 ms 重开抑制窗口（onFocus/onClick 遵守），窗口后点击输入框仍可重开。
- [x]  修复「输入框有焦点时点 chevron 展开」被 blur 宽限期在 120 ms 后关掉：blur 仅在 relatedTarget 位于组合框外部时排程关闭，chevron 展开分支清除未到期关闭定时器。
- [x]  E2E 两个下拉用例（添加连接串口 / 波特率）改用真实 WDIO 鼠标点击，新增「聚焦时真实 chevron 点击展开并保持展开」断言；组件测试新增 retarget click 不重开、chevron/blur 两例（Vitest 138）。
- [x]  回归：lint 0、tsc 0、Vitest 138、E2E 22（打包版 + PyModbus）、npm run package、npm run make、tools/smoke-installer.mjs（app-0.4.1）全通过。

## 本轮迭代（下拉不关闭根因修复，v0.4.2）

- [x]  根因定位并从根修复：`Field` 的 `<label>` 包裹会把非交互式后代（选项文本 span）的点击转发给关联控件（input），产生第二个 trusted click 触发重开；是否发生取决于点击点落点（长文本命中 span / 短文本命中 button 内边距），解释了「只有串口复现、波特率与数据位不复现」。`Field` 改为 `role="group" + aria-labelledby`；0.4.1 的 200 ms 抑制窗口（症状处理）已移除，刻意点击永远可重开。
- [x]  事件流证据（打包版 + 真实鼠标）：修复前串口选中为 `click -> SPAN` 后紧跟 `click -> INPUT`（trusted、同 timeStamp）；修复后仅单次 click 序列，列表保持关闭。
- [x]  回归：lint 0、tsc 0、Vitest 140（新增「点选项文本 span 关闭且不复开」「Field 不得含 label」）、E2E 22（打包版、真实鼠标点击）、npm run package / make、tools/smoke-installer.mjs（app-0.4.2）全通过。

## 本轮迭代（Windows 四种交付产物，v0.5.0，2026-09-14）

- [x] AGENTS.md 固定 release 根目录平铺规则；版本号与 lockfile 同步到 0.5.0。Forge postMake 以同次 maker 结果生成 ZIP / Setup，electron-builder 只封装 Forge 的 prepackaged 目录生成 Portable；校验包内版本后整理四项，重复构建验证通过，其他版本不清理。
- [x] 最终产物：`release/modbus-debugger-0.5.0-win-x64/`、同名 `.zip`、`-Portable.exe`、`-Setup.exe`；release 已忽略提交，临时构建目录清理成功。
- [x] Portable 日志 / 默认数据库使用外层启动器路径；新增回归覆盖临时解压路径、普通目录版、开发模式与非法相对路径。
- [x] lint、typecheck、Vitest 144 项通过（含独立 PyModbus 互操作）；打包版 WebdriverIO E2E 22 项通过（真实 TCP 读写、回读、扫描、记录、历史、完整功能回归）。
- [x] Production Build：`npm run make -- --platform=win32 --arch=x64` 完成 Forge package + ZIP + Squirrel + Portable，最终配置再次构建通过。日志：`out/release-build.log`；单元/集成日志：`out/release-tests.log`。
- [x] `npm run smoke:release` 对最终 release 产物全部通过：目录 / ZIP / Portable / Setup 的真实渲染、typed IPC、serialport、版本；Portable 独立 EXE 在含中文和空格路径运行，外层 data/history.db 写入测试记录后重启仍可读取；Setup 静默安装、实际运行和卸载成功。日志：`out/release-smoke.log`。
- [x] 16 张 E2E 页面截图已复核，副本留在 `out/release-visual-review/`；新增 1440×960、1280×960、1279×960、1024×680 实际渲染截图及页面无横向溢出断言，见 `out/release-smoke-screenshots/`。本轮不改 UI 布局，不更新既有截图基线。

## 本轮增量验证（临时读取默认值 / 停止扫描，v0.6.0，2026-09-14）

- 临时读取默认 Qty=10；扫描新增 device.stopScan，Main 权威进度/结果通过连接 delta 下发。停止不再重试或探测后续 Unit，当前请求正常收尾；已发现结果保留，扫描释放互斥槽后恢复排队请求与 Poll。
- 修正扫描直接发送请求绕过 busy 的问题：等待现有 Write/RMW→Read Back 原子组完成，并阻止扫描期间手工请求插入。RTU 停止后的迟到响应仍受 drain 隔离。
- UI 显示停止/正在停止/已停止、实际进度和连接配置的重试次数；异常响应保留异常码。组件测试覆盖默认数量、IPC 参数、切换页面后停止、部分结果、非法范围及 IPC 失败恢复。
- 本次定向验证：相关文件 ESLint、typecheck；5 个相关测试文件共 39 项通过，另新增写入→回读→扫描互斥用例单独通过（合计 40 项）。包括 TCP Runtime、RTU 停止/迟到帧、Manager delta、PyModbus 互操作和设备工具组件测试。
- 未运行无关全量测试、打包版 E2E、生产打包或安装卸载；现有 release 产物未更新。

## 本轮增量验证（高级扫描配置，v0.7.0，2026-09-14）

- 位置：从站扫描页的起始/结束 Unit 下方，默认折叠。配置只用于当前扫描，默认 FC03 / Start=0 / Qty=1 / 150 ms / 重试沿用连接；可选 FC01/02/03/04、起始地址 0–65535、超时 10–10000 ms、重试沿用连接或 0–5 次。折叠保留输入；扫描和停止收尾期间锁定。
- 共享 scanOptionsSchema 在 Renderer / IPC / Runtime 约束只读功能码、地址及数值边界；Main Snapshot 保留实际生效 options，页面重新进入时可查看当前参数。单次覆盖 retries=0 也生效，后续扫描/临时读取仍沿用连接默认策略。
- 测试发现并修复旧校验缺陷：FC01/02 的 1–8 位响应 PDU 仅 3 bytes，原校验错误要求至少 4 bytes。新增独立 TCP / RTU 短帧向量（RTU CRC 用 PyModbus 独立核对），保留 FC03/04 的原长度要求。
- 定向测试均通过：协议/Runtime/RTU停止/PyModbus 6 个文件 67 项；扫描 IPC 参数校验 15 项；Manager delta 12 项；设备工具组件 7 项，共 101 个不同用例。组件覆盖默认折叠、展开修改下拉项、折叠后提交、非法输入、运行中参数与停止按钮锁定。真实 PyModbus 覆盖四种 FC 在非零地址的成功探测。
- 相关文件 ESLint、typecheck 和 git diff --check 通过。未跑无关全量测试、打包版 E2E、生产打包或安装卸载；release/ 未更新。协议回归日志见 out/scan-protocol-tests.log，组件结果见 out/scan-ui-tests.log。

## 本轮增量验证（GitHub 发布与旧产物清理，v0.7.1，2026-09-14）

- make 成功后清理 release/ 中符合约定命名的旧版本产物；当前版本及其他非打包文件保留，失败时使用临时备份回滚。实际构建已从 0.5.0 / 0.7.0 八项旧产物更新为 0.7.1 的四项产物。
- 本地验证：release 定向测试 5 项、相关 ESLint、typecheck、工作流 YAML 解析、make、四种产物 smoke 均通过；Portable 重启持久化、Setup 安装/运行/卸载通过，未执行无关业务全量回归。
- 按用户确认新建公开仓库 https://github.com/loogg/modbus-debugger，master 与 v0.7.1 已推送。首次使用标签手动触发发布工作流，并取消重复分支构建，避免同一提交重复消耗构建资源。
- GitHub 云端构建与 Smoke Test 成功：https://github.com/loogg/modbus-debugger/actions/runs/34837275782 。所有运行文件由云端 npm ci + Forge make 构建；没有上传本地 release 文件代替云端构建。
- GitHub Release 已发布：https://github.com/loogg/modbus-debugger/releases/tag/v0.7.1 。三个附件均为 uploaded：modbus-debugger-0.7.1-win-x64.zip、modbus-debugger-0.7.1-win-x64-Portable.exe、modbus-debugger-0.7.1-win-x64-Setup.exe。

## 本轮增量验证（临时读取失败反馈，v0.7.2，2026-09-14）

- 扫描进度明确显示“已检查从站地址 / 正在探测 Unit / 已发现从站”，例如已检查 4/247、当前 Unit 5、发现 0，并非错误提示或已发现 4 台设备。
- 临时读取显示读取中、超时、合法设备异常码及含义、传输/CRC/格式/不匹配错误及 IPC 失败；失败提示保留请求参数、Trace ID 与通信诊断入口，成功重试清除提示。读取失败后清除旧成功数据，禁用重复提交；离线和扫描占用状态有说明。
- 成功结果的地址与保存 Block 参数绑定提交时请求，后续编辑表单不会把旧数据错误绑定到新地址/Unit。Main 离线读取立即拒绝，停止/传输断开会结算尚未发送的排队操作，避免永久 pending。
- 定向验证：相关 ESLint、typecheck；临时读取反馈、TCP Runtime、RTU 停止、Manager delta 55 项通过；随后新增“传输中断结算排队读取”和“已检查/发现数量区分”两个用例分别定向通过，合计 57 项。未运行无关全量 E2E、生产打包或发布，release/ 与 GitHub Release 未更新。

## 本轮增量验证（存储路径 / NSIS 安装向导 / 测试隔离，v0.8.0，2026-09-14）

- 应用在 Electron ready 前配置 data（prefs/history/workspaces）、cache（sessionData）、logs、temp/crashes；默认跟随执行目录，Portable 使用外层启动器目录。支持 --data-dir / MODBUS_DATA_DIR 绝对路径覆盖；不可写明确提示退出，不回退 AppData。旧 AppData 文件保留且不自动采用旧测试路径。
- Setup 改为 NSIS 向导，首次默认在安装包旁，支持自选目录；从程序文件清单生成卸载宏，保留 data、工作区等用户文件。Portable 为无插件的 NSIS 单文件启动器，使用外层 temp 下唯一目录解压并直接启动应用，正常退出清理。移除 Squirrel maker / startup 直接依赖，不替换 Forge/Vite。
- make 仍输出四种产物；清理旧程序目录前将非程序文件保存到 release/data/backups。此次旧 0.7.1 目录里的运行数据已按此规则保留。
- 单元/集成定向验证 26 项通过：存储布局与不可写路径、release 参数、工作区/数据库持久化、Manager delta。相关 ESLint、typecheck、脚本语法检查通过。
- 打包版定向 E2E 1 项通过：只运行 launches with 用例，读取测试工作区与真实 PyModbus 连接；驱动缓存和测试 profile 均位于 out/test-temp，旧 Roaming 偏好内容未变化，截图见 out/storage-e2e-screen.png。没有运行无关业务全量 E2E。
- npm run smoke:release 对最终四种产物通过：Renderer / IPC / serialport / history、真实 userData/sessionData/temp 路径、Portable 实际解压位置与退出清理、数据库跨重启保留、--data-dir 覆盖、NSIS 安装到中文+空格路径、重装及卸载后数据保留；测试会话目录清理，日常 AppData prefs 未被修改。结果见 out/storage-smoke.log。
- 本地 release/ 已生成 0.8.0；未推送或更新 GitHub Release。安装器自身 Windows 临时机制/注册表/快捷方式和开发依赖缓存不属于应用运行数据零系统盘写入承诺；程序或显式数据根目录选在 C 盘时仍尊重所选路径。

## 0.9.0：全量功能审计

本轮由用户明确要求全量核查。原测试命令成功只能表示当时已有用例通过，不能证明每个按钮完成。审计开始前基线为201个Vitest用例、22个E2E用例通过，但代码中仍存在未接线操作和实际通信错误。

### 原有证据的问题

- 写入E2E直接调用 `point.write`，绕过双击、输入、Enter和确认对话框。
- 扫描只要求“发现至少一个”，无法识别不存在的Unit被错误当成在线。
- 导入只打开页面，添加从站只打开并取消，未核对新增数据。
- DOM `.click()`可绕过遮挡；时区断言依赖本机UTC+8；整文件自动重试可能掩盖偶发失败。
- 单个点位ID用于多从站，单从站fixture无法发现串值和写错设备。

### 修复与对应证据

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

### 页面操作盘点

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

### 执行记录

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

### 边界

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

### 0.10.2 GitHub 发布记录

- 已推送当前提交及 `v0.10.2` 标签，标签对应 `701195de199be6b29e7fcfe0ba60eec091c9b586`，包含模板编辑修复、小方块图标及本地审核记录。
- [标签发布任务](https://github.com/loogg/modbus-debugger/actions/runs/34981620809)的 build、publish 均成功，云端四种产物启动、Portable 重启/持久化、Setup 安装/重装/卸载检查全部通过。同一提交的[重复分支构建](https://github.com/loogg/modbus-debugger/actions/runs/34981620762)主动取消，未重复执行业务回归。
- [v0.10.2 Release](https://github.com/loogg/modbus-debugger/releases/tag/v0.10.2)已正式公开并设为最新版本，非草稿、非预发布。ZIP、Portable.exe、Setup.exe 及 manifest.json 均上传完成，大小非零且具有 SHA-256；下载清单核对了版本、85 个程序文件及摘要。
- 发布日志：`out/audit/github-v0.10.2-actions.log`；云端清单：`out/audit/github-v0.10.2/`。复用了既有功能测试结果，未重跑无关业务全量验收。

## 0.11.1：扩展边界与正式本地验收（2026-09-25）

本轮基于 0.11.0 工作区实施，`package.json` 与 lockfile 同步至 0.11.1。共享通信/诊断/偏好/会话 DTO 移到 `src/shared/contracts.ts`，ESLint 阻止 Renderer / Shared 反向引入 Main；生产页面使用细粒度 Main 命令，完整 `workspace.apply` 仅留给隔离测试 fixture。连接配置替换等待旧传输关闭，Renderer 忽略迟到 delta；设备对话框按功能拆分。写超时立即 Read Back、不重试写请求；通信诊断按真实 TX/RX 展示并保留 Raw ADU/PDU。Record Session 持久化每笔事务来源元数据，Raw 帧仍按开关可选。历史页在不删原始样本的前提下用极值保留图表抽样与精确游标查询；首次空态、Raw Inspector 入口和 Figma 要求的紧凑布局均按真实画面收敛。

| 验证 | 结果 | 证据（本地，`out/` 不入 Git） |
| --- | --- | --- |
| lint / typecheck / Simulator CLI | 通过；CLI 2 项通过 | 本轮命令输出 |
| Vitest Unit / Integration | **43 文件、344/344**，0 失败、0 跳过；独立 PyModbus 互操作 14 项（TCP 7、COM1↔COM2 RTU 7） | `out/audit/v0.11.1-vitest-final.log` |
| 打包版完整 E2E | **9 spec、54/54**，0 失败、0 跳过；覆盖真实 RTU/TCP UI、导入、记录回放、事务双报文、布局及更新限流处理 | `out/audit/v0.11.1-e2e-final.log` |
| 容量与首次使用 | 真实打包版 100 万样本会话打开 4,698 ms，回放游标及曲线稳定 300 ms，完整 CSV 剪贴板导出 753 ms；无偏好/工作区文件的首次使用 1/1 通过 | `out/audit/v0.11.1-capacity-e2e-visual.log`、`capacity-1m-smoke.json`、`v0.11.1-empty-first-use.log` |
| 正式 make 与四产物 Smoke | Windows x64 目录、ZIP、Portable、Setup 平铺同版；四形式启动、Portable 单 EXE 独立复制与重启、Setup 自选目录安装/重装/卸载及保留数据通过 | `out/audit/v0.11.1-make-final.log`、`v0.11.1-smoke-release-final.log` |
| 自升级与回滚 | ZIP、Portable、Setup 经真实按钮与 helper 由 0.11.1 升至隔离 0.11.2；Setup 故障安装后恢复 0.11.1，工作区与用户数据保留 | `out/audit/v0.11.1-self-update-final.log`、`v0.11.1-self-update-rollback-final.log` |
| Figma 视觉审查 | 读取 00/02 规范并逐屏对照 01 的 30 个节点；可见主结构与关键状态 **30/30 PASS**，包含最终打包版同状态截图 | [30 屏审查](figma-visual-audit-v0.11.1.md)、`out/audit/figma-current/` |

迭代中保留了失败证据，没有靠重试掩盖：早期 delta 序号、单连接 fixture、抽屉同名输入与 CDP 超时等问题见 `out/audit/v0.11.1-vitest-first.log` 和 `v0.11.1-e2e-first.log`；后续新增导入 spec 暴露测试间工作区串扰，通信 TX/RX 双行使旧导出/筛选断言失效，模板截图钩子误用按钮文案。均按根因修复并在同一最终产物上完整重跑。GitHub 公开 Release API 在最终轮次实际返回限流，E2E 验证了错误文案与重试入口；成功 Release 解析、附件下载及校验仍由隔离测试覆盖，不能把本次限流称为最新版本查询成功。

最终包的 111 个应用/打包输入、ASAR、manifest 与四产物 SHA 见[源码身份清单](../out/audit/v0.11.1-source-identity.json)；ASAR 比最新应用输入晚 174 秒，包内 Vite 文件与构建输出一致。旧 `release/data/` 内 44 个历史备份文件已在相对路径和 SHA-256 核对后原样移到忽略目录 `data/archives/release-root-legacy-2026-09-25/`，故 `release/` 仅有四产物与 manifest。容量边界见[基准报告](history-capacity-benchmark.md)：10 GB 是提醒阈值，不代表该容量性能；100 万样本目标达标，但长期高频轮询的同步 flush 抖动未定量验收。RTU quiet window 后的同 Unit/FC 旧响应无法无歧义识别；虚拟 COM 不等于物理 RS485。最终成功自升级的隔离目录 `out/test-temp/self-update-app-EJ6IIV` 因 Windows `EPERM` 未自动清理；此前同类目录的递归清理被自动审批拒绝，未绕过限制。PR 检查工作流本地等价命令通过，云端 Actions 尚未运行；本轮未提交、推送或发布 GitHub Release。
