# 正式发布验收清单

本文件只定义现行验收条件，不记录通过状态。正式发布验收时逐项核对，并在独立记录中注明版本、提交、日期、结果、跳过项和证据。历史结果见[验证与审计历史](full-audit.md)，不能作为当前版本自动通过的证明。

日常增量任务按 [AGENTS.md](../AGENTS.md) 的影响范围策略验证；普通版本递增或重新打包不自动触发本清单的全量验收。

## Domain / Communication

- Connection → Slave → Template → Block → Point 模型正确；Unit ID 不进入 Template。
- RTU / TCP Parser 是流式解析器，不依赖一次 `read/recv` 对应一帧；Transport → Framer/Parser → ADU Validator → PDU Decoder 分层明确。
- TCP 覆盖：单帧拆成多次输入、一次输入多帧、A 后半+B 完整+C 前半、非法 Protocol ID/Length、垃圾前缀、截断候选帧、坏帧后紧跟正常帧，并证明自动 Resync 后正常帧仍能解析。
- RTU 覆盖：单帧多次 read、连续多帧、半包+后续完整帧、CRC 错、噪声、截断帧、超长数据、坏帧后紧跟正常帧，并证明自动 Resync 后下一可信帧可以恢复。分帧**不使用 t1.5 / t3.5 字符间隔**（既不作判决也不作诊断 hint，且不保留 strict 时序模式开关）：判决依据为「预期响应长度 + CRC + 可信边界扫描 + 有界等待」，见 [RTU 分帧说明](protocol/02-rtu-framing.md)。
- Exception Response、Unexpected Response 与 malformed frame 分类正确；至少区分 OK / Exception Response / Unexpected Response / Timeout / CRC Error / Malformed Frame / Transport Error。结构合法但 TCP TID/Unit/FC 不匹配或 RTU Unit/FC/预期响应不匹配时，必须进入 Unexpected Response，不能污染当前请求结果。
- 协议尺寸边界按 PDU ≤ 253、RTU ADU ≤ 256、TCP ADU ≤ 260 bytes 测试；buffer 上限和异常等待边界明确，非法 Length / 连续噪声不会导致无限等待、无限内存增长或永久失步。
- TCP Timeout 后迟到旧响应通过 Transaction ID 被识别，不得错误匹配到后续请求。
- RTU Timeout / 截断 / 严重帧错误后执行 bounded drain / quiet recovery；在有界 drain 窗口结束前不启动也不接受下一请求的响应，并有“迟到旧响应 + 后续同 Unit/同 FC 新请求”的回归用例。
- Parser 错误恢复不得依赖无条件清空整个接收缓冲区；错误帧后合法帧不得被一起丢弃。
- Malformed / Unexpected / Resync 都产生可诊断记录，至少包含错误类型、原因、相关 Raw Bytes、Resync 丢弃字节数/范围和 request/connection context；不得静默吞掉异常数据。
- Block overlap 被拒绝，Point overlap 被允许；四类地址区与 0-based 行为正确。
- Realtime / Trend / Recorder 复用同一 Block Cache，没有重复 Poll。
- Renderer 通过共享 DTO 和细粒度 Main 命令编辑工作区；连续编辑不丢失已提交的其他字段，非法引用与重复 ID 不改变当前状态，配置重建不与旧传输关闭重叠。
- Editing / Pending / Confirmed / Exception / Timeout / Read Back 状态完整。
- Point Mapping 的 Int/UInt/Float/Bool/Enum/String、Endian、UInt8 高低字节、BitField、String encoding/length 有 Golden Test；数值点位显示精度 0–12、旧工作区默认值、趋势 Tooltip/历史显示及原始样本不舍入有相关测试。
- Scale/Offset、量化、raw range、bit width、Scale=0、NaN/±∞ 写前校验有测试。
- RTU / TCP 正式 Transport 已实现；Scheduler 优先级、Scanner 独占、Write→Read Back、RMW 原子序列有 Integration Test。
- 每个事务的 `traceId`、source metadata、Raw ADU/PDU、duration、result 完整；TCP MBAP ID 与 `traceId` 分离。

## Trend / History / Diagnosis / Import

- 从站扫描页提供默认折叠的高级配置；FC01/02/03/04、起始地址、超时、重试经 IPC 校验并作用于实际请求。折叠不重置参数，扫描中禁止修改，不改变连接默认值；FC01/02 读取 1 位的短响应正常识别。
- 临时读取默认 10 个寄存器；从站扫描支持停止、保留部分结果、恢复排队请求与轮询。扫描等待当前写确认原子组结束，不并发占用连接；重复扫描/非法范围拒绝，切换页面后进度和停止操作仍可用，合法异常响应显示实际异常码。
- Numeric / Bool / Enum / String 四类 Trend Renderer 与记录语义完整。
- Record Session Schema Snapshot 能抵抗后续 Template 修改。
- Scanner、Temporary Read、Raw Inspector、Connection Health、Point Trace、Offline Replay 全部真实接线。
- 扫描常用范围预填按钮只修改输入，不自动发包；通信帧详情复制请求/响应 Hex 的内容与原始报文一致。
- Import 支持 XLSX / CSV / JSON / Clipboard 的 Mapping + Preview + overlap 阻止。

## Persistence

- `.workspace.json` 自动保存、另存为、导入/导出、schema migration、原子写入、重启恢复有测试。
- Workspace 中共享 Template 不按 Slave 复制；Template 独立导入/导出后绑定关系正确。
- `history.db` 路径配置、Session 持久化、10 GB 提醒和可选 Raw Communication 正确。
- 历史库增长基准有可重复结果；当前目标为单会话 100 万数值样本，打包版打开会话与完整 CSV 导出各应在 30 秒内完成，回放游标操作应在 5 秒内完成。容量提醒不得被表述成同等容量的性能验收；目标变化时须重测。
- 更新包、临时文件和备份均落在选定的数据根目录；启动路径不可写时明确报错退出，不静默回退到 AppData。自动化测试不修改日常用户偏好、工作区或历史库。

## Figma Screen / State

- 01 — 设备 / 拓扑
- 02 — 添加连接
- 03 — 添加从站
- 04A — 实时数据 / 设备全部数据
- 04B — 实时数据 / 数据块
- 05 — 模板库
- 06 — 模板编辑
- 07 — 编辑数据块
- 08 — 编辑点位
- 09 — 趋势 / 信号
- 10 — 趋势 / 添加信号
- 11 — 趋势 / 图表
- 11B — 趋势 / 记录中
- 12 — 历史 / 记录会话
- 12B — 历史 / 信号
- 13 — 通信 / 诊断
- 14 — 设置
- 15 — 空工作区 / 首次使用
- 16 — 趋势 / 新建趋势组
- 17 — 扫描 / 从站
- 18 — 设备 / 临时读取
- 18B — 临时读取 / 保存为数据块
- 18C — 保存为数据块 / 模板下拉
- 18D — 保存为数据块 / 新建模板
- 19 — 实时 / 原始数据检查器
- 20 — 通信 / 连接健康
- 21 — 历史 / 离线回放
- 22 — 模板 / 导入寄存器表
- 23 — 通信 / 点位追踪
- 24 — 编辑点位 / 数值缩放
- 关于与更新：版本、架构、运行形式、正式 Release 查询、下载状态和安装确认可用。
- 模板管理：模板/数据块两级导航、离线点位内存布局、点位属性检查器、保存、改名与删除确认可用。
- 实时页无从站选择但工作区已有从站时默认选中首个；用户后续显式选择不被覆盖。

## Responsive / Visual

- 1440×960、1280、1279、1024×680 完成实际截图审核。
- Sidebar resize/persistence 正确；Table 达到最小列宽后内部横向滚动，Header Sticky，Point 列在横向滚动时保持左侧可见；Drawer Overlay、Dialog internal scroll 正确。
- 公共组件修改后按影响范围验证相关 Screen / 状态；不默认检查所有页面。

## Simulator / Fixtures

- Fake Transport 可重复制造 Exception / Timeout / Delay / CRC / Disconnect / Reconnect，并可按任意 chunk 边界注入半包、粘包、混合切分、噪声与 malformed frame。
- Standalone Simulator 与正式 TS Client 保持独立实现，并覆盖 FC01/02/03/04/05/06/15/16、多 Unit、动态 Numeric、Bool edge、Enum、String、写成功/拒绝/结果未知、RMW、Scanner、Temporary Read。
- Golden Fixtures 的 expected bytes 不由被测 Codec 生成；额外包含错误帧/垃圾数据后紧跟合法帧、TCP 迟到 TID、RTU Timeout 后迟到旧响应等恢复序列，验证 Parser / Runtime 能继续正确关联后续正常帧。

## 更新与自升级

- 当前版本由 Main 提供；只查询本项目 GitHub Releases 的正式版本，按 SemVer 比较并匹配同架构、同运行形式的附件，不自动降级。
- Main 完成流式下载、进度、取消、大小与 SHA-256 校验；校验失败不可安装或打开下载位置，切换页面不丢失状态且不干扰通信轮询。
- 用户确认后保存工作区、结束记录与通信，再安装并重启；目录/ZIP、Portable、Setup 均完成真实版本切换。保留原工作区、偏好、历史库、自选数据目录及未知用户文件。
- 文件清单校验拒绝路径越界、链接和用户文件冲突；新程序启动失败或安装中断时恢复旧程序及必要的安装登记。覆盖中文/空格路径和 Portable 外层 EXE 改名。

## 模板与数据块

- 模板/数据块两级导航、返回概览及跨模块进入时，不残留旧块编辑状态。
- 离线内存布局依据模板定义，正确显示多寄存器、字节/位、重叠和分页；新增点位后立即更新。
- 数据块保存通过 Main 持久化，不弹文件选择器；模板改名、删除确认和关联引用清理有实际断言，历史 Schema Snapshot 不受影响。
- 点位属性检查器可直接保存修改；删除点位须确认，并清理绑定从站趋势组中的引用，不影响其他模板或历史 Schema Snapshot。

## Final DoD（正式发布验收）

- Windows 正式打包同时生成目录版、ZIP 解压版、单文件 Portable 和 NSIS Setup，按 `modbus-debugger-<version>-win-<arch>` 命名，四项直接平铺在 `release/`，不套版本/平台目录；Setup 支持自选安装目录，重装/卸载保留用户数据。
- 四种交付产物分别通过真实启动、版本、Renderer / IPC / serialport 检查；Portable 仅复制单个 EXE 到含空格与中文的独立目录也能运行，退出重启后默认历史库仍保留；Setup 安装与卸载通过。
- 无关键 TODO / FIXME / placeholder / 最终 mock。
- lint / typecheck / unit / integration / E2E 全通过。
- Production Build（Vite）成功；打包版实际启动，`serialport`（N-API prebuilds）与 `sql.js`（WASM，Main external + 随包 node_modules）加载正常；项目不含 ABI 敏感原生模块。
- Installer / distributable Smoke Test 和适用的完整业务回归通过；验收记录列出真实通过、失败、跳过及未覆盖项，不能用定向测试结果宣称全量通过。
