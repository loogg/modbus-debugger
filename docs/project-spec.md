### Domain Model

`Connection → Slave Instance → Device Template → Block → Point`

- Slave 只绑定 Template，不复制模板结构；Unit ID 属于 Slave，不属于 Template。
- Block 是实际轮询单元：地址区、Start、Length、默认周期；同 Template、同地址区 Block 不允许重叠。
- Point 是 Block Raw Memory 的解释视图；Point 允许重叠并共享同一 Block Cache。
- Point 类型：Int / UInt / Float / Bool / Enum / String。
- 读取地址区：Coil(01)、Discrete Input(02)、Holding Register(03)、Input Register(04)；02/04 固定只读，01/03 可按 Point 配置写权限。
- 写 Coil 使用 FC05 / FC15；写 Holding Register 使用 FC06 / FC16。
- 核心 UI 和通信日志使用 0-based PDU 地址；PLC Reference Address 只在 Import 层转换。

### Point Mapping

至少表达 register offset/count、raw type、byte/word order、byte selector、bit offset/width、String length/encoding、display format、Enum map、Scale/Offset、unit、access、high-risk write confirmation。

### Polling / Cache

- Connection 在线且 Slave 启用后，绑定 Template 中全部 Block 按各自周期持续 Poll。
- 页面选择只改变展示，不改变后台 Poll 范围。
- Realtime / Trend / Recorder 复用同一 Block Cache；断开 Connection 或禁用 Slave 后停止对应 Poll。
- 高负载只告警，不自动降频。

### Write Semantics

- Value 始终是最后一次 confirmed value；Editing 时后台 Poll 不覆盖输入，Writing 时 pending 与 confirmed 分离。
- Write 成功后立即 Read Back；Exception 保留旧值；Timeout 表示结果未知并立即 Read Back。
- Coil 单 Bool：FC05 → Read Back。
- Holding Register 小于 16 bit Point：Read latest → Mask/Merge → FC06/FC16 → Read Back；禁止旧 Cache RMW。
- Cache 更新后重新 Decode 所有共享受影响 Raw Memory 的 Point。

### Scale / Offset

- Engineering = Raw × Scale + Offset；Write Raw = (Engineering − Offset) / Scale。
- Scale=0、Raw 越界、NaN、±∞ 在发送前拒绝；整数/BitField 逆变换后量化并校验范围。
- pending engineering value 不进入 Block Cache。

### Realtime / Trend / History

- Trend Group 只消费 Block Cache，不创建独立 Poll。
- Numeric 用折线；Bool 用数字波形 + edge time；Enum 用命名状态段；String 用变化事件。
- History 只保存主动 Record Session；Session 保存 Point Schema Snapshot。

### Streaming Parser / Recovery

- Transport 只提供任意长度的 byte chunk；Parser / Framer 负责跨 chunk 保存状态并输出完整 ADU，不能假定一次 `read/recv` 对应一帧。
- 必须支持：单帧被任意次数拆分、一次输入包含多帧、`Frame A 后半 + Frame B 完整 + Frame C 前半` 等半包/粘包混合情况。
- 合法 Modbus Exception Response 与 malformed frame 必须区分。Exception Response 是合法协议响应；CRC 错、非法/不可能长度、非法 MBAP、截断帧、噪声等属于协议/帧错误。
- 异常帧只影响当前错误数据。Parser 必须能够在后续可信帧边界自动 Resync，并继续解析后续合法帧；禁止把“发现错误后清空整个接收缓冲区”作为默认恢复策略。
- Parser 必须限制最大 ADU 长度、接收缓冲区容量和异常等待时间；标准边界按 PDU ≤ 253 bytes、RTU ADU ≤ 256 bytes、TCP ADU ≤ 260 bytes 执行。非法长度或连续噪声不得造成无限等待、无限内存增长或永久失步。
- **结构合法但与当前请求不匹配**的响应不得归为 malformed，例如 TCP Transaction ID / Unit ID / Function 不匹配，或 RTU Unit ID / Function / 预期长度不匹配；统一归为 `Unexpected Response` 并进入诊断。
- 错误至少区分并进入诊断：`Exception Response`、`Unexpected Response`、`Timeout`、`CRC Error`、`Malformed Frame`、`Transport Error`。Malformed / Unexpected / Resync 不得静默丢弃，应保留足够的 Raw Bytes、原因和丢弃范围用于通信诊断。

### Diagnosis / Import

- RTU Scanner 扫描 Unit ID；Temporary Read 是单次请求，成功结果可保存为 Block。
- Temporary Read 默认数量为 10 个寄存器（覆盖 Figma 初始示例中的 16）。Scanner 支持中途停止、保留部分结果并恢复当前连接轮询；正常/合法异常响应均可发现从站，界面显示实际重试次数与响应类型。
- Scanner 的 Unit 范围下方设默认折叠的“高级扫描配置”：读取 FC01/02/03/04、0-based 起始地址、单次超时及重试次数；默认 FC03 / 地址 0 / 150 ms / 重试沿用连接，读取数量固定为 1。折叠后设置仍生效，扫描期间锁定；只影响当前扫描，不改变连接的周期读写配置。
- Raw Inspector 只解释当前 Block Cache，不额外请求设备。
- Connection Health 至少统计 bus load、request rate、P50/P95、Timeout、CRC、Exception 和实际周期。
- Point ↔ Transaction 通过稳定 `traceId` + source metadata 双向追踪。
- Import 支持 XLSX / CSV / JSON / Clipboard，先 Mapping + Preview；PLC Reference Address 仅在 Import 层转 0-based；Block overlap 必须阻止。

### Workspace / Persistence

- Workspace 使用带 `schemaVersion` 的 `.workspace.json`，自动保存并支持另存为、导入、导出。
- Workspace 保存 Connection、Slave、共享 Template 定义/绑定、Trend Group 和可移植布局；本机 Window/Sidebar 偏好放 app `userData`。
- 自动保存使用临时文件 + 原子替换；导入失败不破坏当前 Workspace。
- History 使用独立 SQLite `history.db`；10 GB 只提醒，不自动删除；Raw Communication 在 Record Session 中可选持久化，默认关闭。
