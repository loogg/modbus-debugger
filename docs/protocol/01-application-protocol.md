# Modbus 协议参考（实现依据）

来源：Modbus Application Protocol V1.1b3、Modbus over Serial Line V1.02。
本目录记录线协议格式与边界；报文合法性以官方规范为准。工程分帧策略的显式例外见 [RTU 分帧说明](02-rtu-framing.md) 与 [架构](../architecture.md)，文档职责与冲突规则见 [设计与规范来源](../design-source.md)。

## 功能码（正式范围）

| FC | 名称 | 请求 PDU | 正常响应 PDU |
|----|------|----------|--------------|
| 01 | Read Coils | fc, addr(2), qty(2) | fc, byteCount(1), data(n) |
| 02 | Read Discrete Inputs | 同 01 | 同 01 |
| 03 | Read Holding Registers | fc, addr(2), qty(2) | fc, byteCount(1), data(2*qty) |
| 04 | Read Input Registers | 同 03 | 同 03 |
| 05 | Write Single Coil | fc, addr(2), value(2: 0x0000/0xFF00) | 回显请求 |
| 06 | Write Single Register | fc, addr(2), value(2) | 回显请求 |
| 15 (0x0F) | Write Multiple Coils | fc, addr(2), qty(2), byteCount(1), data(n) | fc, addr(2), qty(2) |
| 16 (0x10) | Write Multiple Registers | fc, addr(2), qty(2), byteCount(1), data(2*qty) | fc, addr(2), qty(2) |

地址与数量均为 0-based PDU 语义；Coil/Discrete qty 1..2000，Register qty 1..125。

## 异常响应

响应 FC = 请求 FC | 0x80，PDU 长度 2（fc, exception code），整体 RTU ADU 5 字节 / TCP ADU 9 字节。
常用异常码：01 ILLEGAL FUNCTION、02 ILLEGAL DATA ADDRESS、03 ILLEGAL DATA VALUE、04 SLAVE DEVICE FAILURE、
06 SLAVE DEVICE BUSY。异常响应是**合法协议响应**，不属于 malformed frame。

## 尺寸边界（硬约束）

- PDU ≤ 253 bytes
- RTU ADU ≤ 256 bytes（unit 1 + PDU 253 + CRC 2）
- TCP ADU ≤ 260 bytes（MBAP 6 + unit 1 + PDU 253）

## CRC-16 (RTU)

多项式 0xA001（反转），初值 0xFFFF，低字节在前（little-endian）附加于 ADU 尾部。
