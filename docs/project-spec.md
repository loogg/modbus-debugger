# 产品与领域规范

实现机制见[架构](architecture.md)，报文格式与分帧边界见[协议说明](protocol/01-application-protocol.md)；本文件只规定产品与领域行为。

## Domain Model

`Connection → Slave Instance → Device Template → Block → Point`

- Slave 只绑定 Template，不复制模板结构；Unit ID 属于 Slave，不属于 Template。
- Block 是实际轮询单元：地址区、Start、Length、默认周期；同 Template、同地址区 Block 不允许重叠。
- Point 是 Block Raw Memory 的解释视图；Point 允许重叠并共享同一 Block Cache。
- Point 类型：Int / UInt / Float / Bool / Enum / String。
- 读取地址区：Coil(01)、Discrete Input(02)、Holding Register(03)、Input Register(04)；02/04 固定只读，01/03 可按 Point 配置写权限。
- 写 Coil 使用 FC05 / FC15；写 Holding Register 使用 FC06 / FC16。
- 核心 UI 和通信日志使用 0-based PDU 地址；PLC Reference Address 只在 Import 层转换。

## Point Mapping

至少表达 register offset/count、raw type、byte/word order、byte selector、bit offset/width、String length/encoding、display format、Enum map、Scale/Offset、unit、access、high-risk write confirmation。

数值点位可设置显示精度，即**最多小数位数 0–12，默认 3**。实时确认值、趋势 Tooltip 和历史回放按该点位精度格式化；Block Cache、工程数值、记录样本及 CSV 导出保留未舍入的原值。记录会话的 Schema Snapshot 保存当时的精度，后续模板修改不改变旧会话显示。

模板编辑支持在属性检查器中保存点位；删除点位须确认，并清理绑定从站的趋势引用，不修改既有历史 Session 的 Schema Snapshot。

## Polling / Cache

- Connection 在线且 Slave 启用后，绑定 Template 中全部 Block 按各自周期持续 Poll。
- 页面选择只改变展示，不改变后台 Poll 范围。
- Realtime / Trend / Recorder 复用同一 Block Cache；断开 Connection 或禁用 Slave 后停止对应 Poll。
- 高负载只告警，不自动降频。

## Write Semantics

- Value 始终是最后一次 confirmed value；Editing 时后台 Poll 不覆盖输入，Writing 时 pending 与 confirmed 分离。
- Write 成功后立即 Read Back；Exception 保留旧值；Timeout 表示结果未知并立即 Read Back。
- Coil 单 Bool：FC05 → Read Back。
- Holding Register 小于 16 bit Point：Read latest → Mask/Merge → FC06/FC16 → Read Back；禁止旧 Cache RMW。
- Cache 更新后重新 Decode 所有共享受影响 Raw Memory 的 Point。

## Scale / Offset

- Engineering = Raw × Scale + Offset；Write Raw = (Engineering − Offset) / Scale。
- Scale=0、Raw 越界、NaN、±∞ 在发送前拒绝；整数/BitField 逆变换后量化并校验范围。

## Realtime / Trend / History

- 实时页在尚未选中从站且工作区已有从站时默认选择首个从站，避免已配置数据却显示空白。
- Numeric 用折线；Bool 用数字波形 + edge time；Enum 用命名状态段；String 用变化事件。
- History 只保存主动 Record Session；Session 保存 Point Schema Snapshot。

## Streaming Parser / Recovery

- 接收链路支持任意分片、连续多帧及半包/粘包混合；坏帧之后的合法帧仍须恢复解析，且等待和缓冲有界。
- 合法 Exception Response、结构合法但不匹配当前请求的 Unexpected Response、坏帧及超时分别进入通信诊断，保留定位所需的原始字节和原因。通信列表按报文展示独立 TX 请求行和可选 RX 响应行，新报文置顶、同一事务共享 `traceId` 详情；超时无 RX。具体分类、尺寸与恢复策略见[架构](architecture.md#modbus-client-core)及 [RTU](protocol/02-rtu-framing.md) / [TCP](protocol/03-tcp-framing.md) 分帧说明。

## Diagnosis / Import

- RTU Scanner 扫描 Unit ID；Temporary Read 是单次请求，成功结果可保存为 Block。
- Temporary Read 默认数量为 10 个寄存器。Scanner 支持中途停止、保留部分结果并恢复当前连接轮询；正常/合法异常响应均可发现从站，界面显示实际重试次数与响应类型。
- 扫描进度明确区分已检查的从站地址数、当前探测 Unit 和已发现从站数，不把“已检查”当成发现设备。临时读取必须显示读取中和持久的失败反馈（超时、异常码/含义、传输/协议错误、IPC 错误），包含本次请求参数和通信诊断入口；失败后不残留旧成功数据。已成功结果的地址及保存为 Block 的参数绑定实际请求，不随后续表单编辑改变。
- Scanner 的 Unit 范围下方设默认折叠的“高级扫描配置”：读取 FC01/02/03/04、0-based 起始地址、单次超时及重试次数；默认 FC03 / 地址 0 / 150 ms / 重试沿用连接，读取数量固定为 1。折叠后设置仍生效，扫描期间锁定；只影响当前扫描，不改变连接的周期读写配置。
- 常用扫描范围可一键预填 1–16、1–32、1–64 或 1–247；仍由用户启动扫描，扫描期间不允许改范围。
- Raw Inspector 只解释当前 Block Cache，不额外请求设备。
- Connection Health 至少统计 bus load、request rate、P50/P95、Timeout、CRC、Exception 和实际周期。
- Point ↔ Transaction 通过稳定 `traceId` + source metadata 双向追踪。
- 通信帧详情可复制请求和响应的原始 Hex；无响应时不提供响应复制。
- Import 支持 XLSX / CSV / JSON / Clipboard，先 Mapping + Preview；PLC Reference Address 仅在 Import 层转 0-based；Block overlap 必须阻止。

## Workspace / Persistence

- 默认配置、数据库、缓存、日志和临时文件跟随选定的可写存储根目录；失败不得静默回退 AppData。具体优先级、Portable / Setup 行为与测试隔离见 [AGENTS.md](../AGENTS.md) 和[开发说明](development.md#数据缓存与测试隔离)。
- Workspace 使用带 `schemaVersion` 的 `.workspace.json`，自动保存并支持另存为、导入、导出。
- Workspace 保存 Connection、Slave、共享 Template 定义/绑定、Trend Group 和可移植布局；本机 Window/Sidebar 偏好放 app `userData`。
- 自动保存使用临时文件 + 原子替换；导入失败不破坏当前 Workspace。
- History 使用独立 SQLite `history.db`；10 GB 只提醒，不自动删除，也不代表已验证的可用容量或回放性能。当前验收目标为单会话 100 万数值样本，实测边界见[容量报告](history-capacity-benchmark.md)。**对 Figma 00“每个事务持久化 source metadata”的明确限定**：每个实时事务都携带来源元数据；仅在主动 Record Session 期间将每笔事务的轻量元数据持久化到 `history.db`，非记录期间的通信诊断保留在有界内存中。Raw ADU/PDU 在 Record Session 中仍由 Raw Communication 开关决定是否持久化，默认关闭，避免默认长期轮询无上限地增长磁盘数据。
