### 使用范围

本文件是完整产品验收清单及历史验收证据，不是每次增量任务的必跑清单。日常文档修改、局部功能修复、UI 调整和打包任务，按 `AGENTS.md` 的“测试与回归策略”选择相关检查；相关项通过即可完成本次任务，无需重跑全部勾选项。

只有正式发布验收、用户明确要求全量回归，或有具体证据表明影响范围无法可靠限定时，才执行全量回归。普通版本递增或重新打包不等于正式发布验收；已有未受本次改动影响的验证结果可以复用。下方历史记录中的“全通过”仅表示对应轮次的结果，不对后续每次任务追加全量要求。

### Domain / Communication

- [x]  Connection → Slave → Template → Block → Point 模型正确；Unit ID 不进入 Template。
- [x]  RTU / TCP Parser 是流式解析器，不依赖一次 `read/recv` 对应一帧；Transport → Framer/Parser → ADU Validator → PDU Decoder 分层明确。
- [x]  TCP 覆盖：单帧拆成多次输入、一次输入多帧、A 后半+B 完整+C 前半、非法 Protocol ID/Length、垃圾前缀、截断候选帧、坏帧后紧跟正常帧，并证明自动 Resync 后正常帧仍能解析。
- [x]  RTU 覆盖：单帧多次 read、连续多帧、半包+后续完整帧、CRC 错、噪声、截断帧、超长数据、坏帧后紧跟正常帧，并证明自动 Resync 后下一可信帧可以恢复。分帧**不使用 t1.5 / t3.5 字符间隔**（既不作判决也不作诊断 hint，且不保留 strict 时序模式开关）：判决依据为「预期响应长度 + CRC + 可信边界扫描 + 有界等待」，见 `docs/protocol/02-rtu-framing.md`。
- [x]  Exception Response、Unexpected Response 与 malformed frame 分类正确；至少区分 OK / Exception Response / Unexpected Response / Timeout / CRC Error / Malformed Frame / Transport Error。结构合法但 TCP TID/Unit/FC 不匹配或 RTU Unit/FC/预期响应不匹配时，必须进入 Unexpected Response，不能污染当前请求结果。
- [x]  协议尺寸边界按 PDU ≤ 253、RTU ADU ≤ 256、TCP ADU ≤ 260 bytes 测试；buffer 上限和异常等待边界明确，非法 Length / 连续噪声不会导致无限等待、无限内存增长或永久失步。
- [x]  TCP Timeout 后迟到旧响应通过 Transaction ID 被识别，不得错误匹配到后续请求。
- [x]  RTU Timeout / 截断 / 严重帧错误后执行 bounded drain / quiet recovery；在有界 drain 窗口结束前不启动也不接受下一请求的响应，并有“迟到旧响应 + 后续同 Unit/同 FC 新请求”的回归用例。
- [x]  Parser 错误恢复不得依赖无条件清空整个接收缓冲区；错误帧后合法帧不得被一起丢弃。
- [x]  Malformed / Unexpected / Resync 都产生可诊断记录，至少包含错误类型、原因、相关 Raw Bytes、Resync 丢弃字节数/范围和 request/connection context；不得静默吞掉异常数据。
- [x]  Block overlap 被拒绝，Point overlap 被允许；四类地址区与 0-based 行为正确。
- [x]  Realtime / Trend / Recorder 复用同一 Block Cache，没有重复 Poll。
- [x]  Editing / Pending / Confirmed / Exception / Timeout / Read Back 状态完整。
- [x]  Point Mapping 的 Int/UInt/Float/Bool/Enum/String、Endian、UInt8 高低字节、BitField、String encoding/length 有 Golden Test。
- [x]  Scale/Offset、量化、raw range、bit width、Scale=0、NaN/±∞ 写前校验有测试。
- [x]  RTU / TCP 正式 Transport 已实现；Scheduler 优先级、Scanner 独占、Write→Read Back、RMW 原子序列有 Integration Test。
- [x]  每个事务的 `traceId`、source metadata、Raw ADU/PDU、duration、result 完整；TCP MBAP ID 与 `traceId` 分离。

### Trend / History / Diagnosis / Import

- [x] 从站扫描页提供默认折叠的高级配置；FC01/02/03/04、起始地址、超时、重试经 IPC 校验并作用于实际请求。折叠不重置参数，扫描中禁止修改，不改变连接默认值；FC01/02 读取 1 位的短响应正常识别。
- [x] 临时读取默认 10 个寄存器；从站扫描支持停止、保留部分结果、恢复排队请求与轮询。扫描等待当前写确认原子组结束，不并发占用连接；重复扫描/非法范围拒绝，切换页面后进度和停止操作仍可用，合法异常响应显示实际异常码。
- [x]  Numeric / Bool / Enum / String 四类 Trend Renderer 与记录语义完整。
- [x]  Record Session Schema Snapshot 能抵抗后续 Template 修改。
- [x]  Scanner、Temporary Read、Raw Inspector、Connection Health、Point Trace、Offline Replay 全部真实接线。
- [x]  Import 支持 XLSX / CSV / JSON / Clipboard 的 Mapping + Preview + overlap 阻止。

### Persistence

- [x]  `.workspace.json` 自动保存、另存为、导入/导出、schema migration、原子写入、重启恢复有测试。
- [x]  Workspace 中共享 Template 不按 Slave 复制；Template 独立导入/导出后绑定关系正确。
- [x]  `history.db` 路径配置、Session 持久化、10 GB 提醒和可选 Raw Communication 正确。

### Figma Screen / State

- [x]  01 — 设备 / 拓扑
- [x]  02 — 添加连接
- [x]  03 — 添加从站
- [x]  04A — 实时数据 / 设备全部数据
- [x]  04B — 实时数据 / 数据块
- [x]  05 — 模板库
- [x]  06 — 模板编辑
- [x]  07 — 编辑数据块
- [x]  08 — 编辑点位
- [x]  09 — 趋势 / 信号
- [x]  10 — 趋势 / 添加信号
- [x]  11 — 趋势 / 图表
- [x]  11B — 趋势 / 记录中
- [x]  12 — 历史 / 记录会话
- [x]  12B — 历史 / 信号
- [x]  13 — 通信 / 诊断
- [x]  14 — 设置
- [x]  15 — 空工作区 / 首次使用
- [x]  16 — 趋势 / 新建趋势组
- [x]  17 — 扫描 / 从站
- [x]  18 — 设备 / 临时读取
- [x]  18B — 临时读取 / 保存为数据块
- [x]  18C — 保存为数据块 / 模板下拉
- [x]  18D — 保存为数据块 / 新建模板
- [x]  19 — 实时 / 原始数据检查器
- [x]  20 — 通信 / 连接健康
- [x]  21 — 历史 / 离线回放
- [x]  22 — 模板 / 导入寄存器表
- [x]  23 — 通信 / 点位追踪
- [x]  24 — 编辑点位 / 数值缩放

### Responsive / Visual

- [x]  1440×960、1280、1279、1024×680 完成实际截图审核。
- [x]  Sidebar resize/persistence 正确；Table 达到最小列宽后内部横向滚动，Header Sticky，Point 列在横向滚动时保持左侧可见；Drawer Overlay、Dialog internal scroll 正确。
- [x]  公共组件修改后按影响范围验证相关 Screen / 状态；不默认检查所有页面。

### Simulator / Fixtures

- [x]  Fake Transport 可重复制造 Exception / Timeout / Delay / CRC / Disconnect / Reconnect，并可按任意 chunk 边界注入半包、粘包、混合切分、噪声与 malformed frame。
- [x]  Standalone Simulator 与正式 TS Client 保持独立实现，并覆盖 FC01/02/03/04/05/06/15/16、多 Unit、动态 Numeric、Bool edge、Enum、String、写成功/拒绝/结果未知、RMW、Scanner、Temporary Read。
- [x]  Golden Fixtures 的 expected bytes 不由被测 Codec 生成；额外包含错误帧/垃圾数据后紧跟合法帧、TCP 迟到 TID、RTU Timeout 后迟到旧响应等恢复序列，验证 Parser / Runtime 能继续正确关联后续正常帧。

### Final DoD（正式发布验收）

- [x] Windows 正式打包同时生成目录版、ZIP 解压版、单文件 Portable 和 Squirrel Setup，按 `modbus-debugger-<version>-win-<arch>` 命名，四项直接平铺在 `release/`，不套版本/平台目录。
- [x] 四种交付产物分别通过真实启动、版本、Renderer / IPC / serialport 检查；Portable 仅复制单个 EXE 到含空格与中文的独立目录也能运行，退出重启后默认历史库仍保留；Setup 安装与卸载通过。
- [x]  无关键 TODO / FIXME / placeholder / 最终 mock。
- [x]  lint / typecheck / unit / integration / E2E 全通过。
- [x]  Production Build（Vite）成功；打包版实际启动，`serialport`（N-API prebuilds）与 `sql.js`（WASM，Main external + 随包 node_modules）加载正常；项目不含 ABI 敏感原生模块。
- [x]  正式发布验收须通过 Installer / distributable Smoke Test 和 Final Full Regression；日常增量任务按顶部使用范围及 AGENTS.md 完成相关验证即可结束。

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
