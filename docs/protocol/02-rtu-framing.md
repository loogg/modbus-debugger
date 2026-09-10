# RTU 串行链路与流式分帧

## ADU 结构

`[Unit ID 1][PDU n][CRC lo][CRC hi]`

## 时序边界

- 字符时间 t_char = 11 bit / baud（start + 8 data + parity/stop 合计 11 bit）。
- 帧内字符间隔 > t1.5 → 视为不完整帧（协议语义）。
- 帧间静默 ≥ t3.5 → 建立新帧边界。
- baud > 19200 时使用固定值：t1.5 = 750 µs，t3.5 = 1750 µs。

## 流式解析要求

Transport 只交付任意长度 byte chunk。Framer 跨 chunk 保存状态：
1. 以静默边界（≥ t3.5）切分候选帧；
2. 结合当前请求的预期响应长度做“长度到达即完整”的快速判定；
3. 帧内出现 > t1.5 间隔时把当前候选标记为不完整，等待 t3.5 边界后按错误处理；
4. CRC 校验 + PDU 长度/功能码组合校验；
5. 错误后不得清空整个接收缓冲区：保留后续字节，并在丢弃段内做可信边界扫描（CRC 窗口扫描）恢复被粘连的合法帧；
6. 缓冲区上限与异常等待时间有界，防止无限等待/内存增长。

## Timeout / 截断后的恢复（bounded drain / quiet recovery）

RTU 无 Transaction ID。Timeout、截断或严重帧错误后，Connection Runtime 进入有界 drain：
在串口接收重新达到可信静默边界（≥ t3.5 且无新字节）之前，不把迟到字节关联到下一请求；
迟到旧响应即使 Unit/FC 相同也只记录为 Unexpected / Late，不影响新请求结果。