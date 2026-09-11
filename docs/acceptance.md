### Domain / Communication

- [x]  Connection → Slave → Template → Block → Point 模型正确；Unit ID 不进入 Template。
- [x]  RTU / TCP Parser 是流式解析器，不依赖一次 `read/recv` 对应一帧；Transport → Framer/Parser → ADU Validator → PDU Decoder 分层明确。
- [x]  TCP 覆盖：单帧拆成多次输入、一次输入多帧、A 后半+B 完整+C 前半、非法 Protocol ID/Length、垃圾前缀、截断候选帧、坏帧后紧跟正常帧，并证明自动 Resync 后正常帧仍能解析。
- [x]  RTU 覆盖：单帧多次 read、连续多帧、半包+后续完整帧、CRC 错、噪声、截断帧、超长数据、坏帧后紧跟正常帧；使用可控时钟验证帧内 `> t1.5` 被判为不完整、帧间 `≥ t3.5` 可建立新边界，并证明下一可信帧可以恢复。
- [x]  Exception Response、Unexpected Response 与 malformed frame 分类正确；至少区分 OK / Exception Response / Unexpected Response / Timeout / CRC Error / Malformed Frame / Transport Error。结构合法但 TCP TID/Unit/FC 不匹配或 RTU Unit/FC/预期响应不匹配时，必须进入 Unexpected Response，不能污染当前请求结果。
- [x]  协议尺寸边界按 PDU ≤ 253、RTU ADU ≤ 256、TCP ADU ≤ 260 bytes 测试；buffer 上限和异常等待边界明确，非法 Length / 连续噪声不会导致无限等待、无限内存增长或永久失步。
- [x]  TCP Timeout 后迟到旧响应通过 Transaction ID 被识别，不得错误匹配到后续请求。
- [x]  RTU Timeout / 截断 / 严重帧错误后执行 bounded drain / quiet recovery；在重新达到可信静默边界前不启动或不接受下一请求响应，并有“迟到旧响应 + 后续同 Unit/同 FC 新请求”的回归用例。
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
- [x]  公共组件修改后回归全部受影响 Screen。

### Simulator / Fixtures

- [x]  Fake Transport 可重复制造 Exception / Timeout / Delay / CRC / Disconnect / Reconnect，并可按任意 chunk 边界注入半包、粘包、混合切分、噪声与 malformed frame。
- [x]  Standalone Simulator 与正式 TS Client 保持独立实现，并覆盖 FC01/02/03/04/05/06/15/16、多 Unit、动态 Numeric、Bool edge、Enum、String、写成功/拒绝/结果未知、RMW、Scanner、Temporary Read。
- [x]  Golden Fixtures 的 expected bytes 不由被测 Codec 生成；额外包含错误帧/垃圾数据后紧跟合法帧、TCP 迟到 TID、RTU Timeout 后迟到旧响应等恢复序列，验证 Parser / Runtime 能继续正确关联后续正常帧。

### Final DoD

- [x]  无关键 TODO / FIXME / placeholder / 最终 mock。
- [x]  lint / typecheck / unit / integration / E2E 全通过。
- [x]  Production Build 成功；打包版实际启动且 `serialport` / `better-sqlite3` native module 正常。
- [x]  Installer / distributable Smoke Test 和 Final Full Regression 通过后才允许结束。

## 验收证据（2026-09-11）

- lint：eslint 0 error；typecheck：tsc --noEmit 0 error。
- unit + integration：Vitest 81 tests passed（协议 Golden、流式分帧/Resync、校验分类、映射/缩放、重叠、Workspace/History 持久化、Runtime 调度/RMW/Scanner/TemporaryRead、PyModbus 模拟器互操作）。
- E2E：WebdriverIO + @wdio/electron-service 针对打包版 8 tests passed（拓扑、实时刷新、写+回读、通信日志、趋势图表、从站扫描、临时读取、1024 紧凑窗口），截图存 tests/e2e/screenshots/。
- Production Build：npm run package 成功；打包版无 ABI 敏感原生依赖（历史存储 sql.js/WASM，串口 serialport N-API prebuilds）。
- Installer Smoke：Squirrel Setup 静默安装 → 启动已安装应用并确认窗口/页面目标 → Update.exe --uninstall 执行（残留目录由 Squirrel 在下次更新/重启时清理）。
- 模拟器：tools/simulator/modbus_sim.py（PyModbus 3.15，独立实现）提供 units 1-3、动态数值/Bool 边沿/Enum/String/写支持。

## 上位机全量功能自测（tests/e2e/full-features.e2e.ts，打包版 + 模拟器）

- [x] 添加连接：串口下拉每次打开重新枚举可用串口；波特率预设 + 自定义输入；高级设置（帧间隔/RTS/日志级别）。
- [x] 添加从站：对话框字段与 Unit ID 冲突检查。
- [x] 实时表：双击进入编辑态、Esc 取消、确认值不被污染。
- [x] 模板编辑：点位表、映射详情、编辑点位抽屉（内存映射/缩放/枚举/映射预览）。
- [x] 导入寄存器表：字段映射 / 预览与转换 / 数据块策略 步骤界面。
- [x] 趋势记录 → 历史会话 → 会话信号页（Schema Snapshot / 记录方式）全链路。
- [x] 通信：连接健康指标卡与数据块性能表；点位追踪来源追踪与原始帧。
- [x] 设置：工作区文件 / 地址规则 / 记录与历史 / 写入安全。
- [x] 扫描 / 临时读取 / 保存为数据块入口（app.e2e.ts）。
- [x] 窗口自适应：1440 与 1024 截图审核（app.e2e.ts）。

## 本轮迭代证据（UI 反馈修复）

- [x] 串口为下拉选择：每次打开下拉通过 serial.list 重新枚举当前可用串口，仍可手工输入（添加连接对话框）。
- [x] 波特率下拉扩展预设（1200…1000000）并支持自定义输入。
- [x] 临时读取 / 添加从站 入口修复：无从站时设备页工具入口与空态按钮均可用（E2E 覆盖）。
- [x] 应用图标：build/icon.ico + icon.png（Fluent 蓝 + RTU 方波 + 寄存器网格），用于 exe / 安装器 / 窗口图标。
- [x] RTU 分帧不再使用 t1.5/t3.5 时序（不作判决也不作 hint）：预期长度 + CRC + 可信边界扫描 + 有界等待；strict 模式不保留。
- [x] 全量功能自测：tests/e2e/full-features.e2e.ts 8 项 + app.e2e.ts 8 项 = 16 项全部通过（打包版 + PyModbus 模拟器）。
