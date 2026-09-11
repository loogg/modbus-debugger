# RTU 串行链路与流式分帧

## ADU 结构

`[Unit ID 1][PDU n][CRC lo][CRC hi]`

## 分帧原则（不依赖字符间隔时序）

实现不使用 t1.5 / t3.5 字符间隔作为分帧判决或 hint（USB 串口与操作系统调度会使间隔失去协议语义）。分帧依据：

1. **预期长度优先**：结合当前 in-flight 请求的预期响应长度，缓冲达到该长度即切出一帧（可处理粘包/半包混合）；
2. **可信边界扫描**：无请求上下文时，从缓冲中扫描第一个 CRC 自洽的帧；扫描起点之前的字节作为噪声/坏帧丢弃，并记录丢弃范围（Resync 诊断）；
3. **CRC 校验**：预期长度切出的候选帧 CRC 失败记 `crc` 错误，并在候选内扫描恢复被粘连的合法帧；
4. **有界等待**：候选帧长期不完整受 `incompleteTimeoutMs` 与接收缓冲上限约束，记 `truncated` / `overflow`，不会无限等待或无限增长。

## Timeout / 截断后的恢复（bounded drain）

RTU 无 Transaction ID。Timeout、截断或严重帧错误后，Connection Runtime 进入有界 drain：
固定窗口内到达的字节不关联到下一请求（记录为 late/unexpected），窗口结束后清空残余缓冲再继续调度。