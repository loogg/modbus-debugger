# TCP 链路与流式分帧

## MBAP Header

`[Transaction ID 2][Protocol ID 2 = 0x0000][Length 2][Unit ID 1]`
Length = Unit ID + PDU 的字节数（1..254）。ADU = MBAP(6) + Length。

## 流式解析要求

1. 不足 7 字节继续缓存；
2. Protocol ID != 0 或 Length 越界（<1 或 >254）→ malformed，受控 Resync：
   向前扫描下一个 plausible MBAP 起点（proto=0 且 length 合法），只丢弃起点之前的字节；
3. 完整 ADU 逐帧 emit，并继续解析同一 buffer 中的后续帧（粘包）；
4. 截断候选帧受缓冲区上限与异常等待时间约束，超时按 malformed/truncated 处理并 Resync；
5. Transaction ID 用于线上请求关联，与应用 traceId 分离；迟到旧响应按 TID 识别后丢弃/记录，
   不得关联到后续请求；TID/Unit/FC 与 in-flight 请求不匹配 → Unexpected Response。