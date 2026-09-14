# 独立 Modbus 从站模拟器

上位机使用本项目自己的 TypeScript 客户端；独立 Python 进程使用 PyModbus，从实际串口或 TCP socket 收发协议报文。端口、监听地址与 Unit ID 都通过参数设置，脚本不指定任何 COM 默认值。

```powershell
python -m pip install -r tools/simulator/requirements.txt
# RTU：下面仅是本机 COM1 ↔ COM2 配对示例，可换成其他端口
python tools/simulator/modbus_sim.py --transport rtu --serial-port COM2 --baudrate 115200 --parity N --stopbits 1 --units 1,2,3 --trace
# 上位机选择配对另一端 COM1，115200 / 8N1。
# TCP：上位机连接 127.0.0.1:5020
python tools/simulator/modbus_sim.py --transport tcp --host 127.0.0.1 --port 5020 --units 1,2,3 --trace
```

RTU 两端不能打开同一个串口。`--serial-port` 在 RTU 模式必填；缺失立即退出，不会静默回退 TCP。每个连接只开一个从站进程；进程内可提供多个互相独立的 Unit ID。不把未配置地址响应成从站，也不自动创建串口对。

## 从站能力与数据

覆盖本工具全部读写功能码：FC01 Coil、FC02 Discrete Input、FC03 Holding Register、FC04 Input Register、FC05 单线圈写、FC06 单寄存器写、FC15 多线圈写、FC16 多寄存器写。四个地址区独立，每个 Unit 独立，非法地址返回异常，未配置 Unit 不响应。这里的“全部”指本工具支持的这八种功能码，并非 Modbus 标准所有扩展功能。

默认每个寄存器区 128 项（0–127），每个位区 2048 项（0–2047）。可用 `--register-count` / `--bit-count` 调整。FC01/02 最大读 2000 位，FC03/04 最大读 125 项，FC15 最大写 1968 位，FC16 最大写 123 项。

| 地址（0-based） | 初始化内容 |
| --- | --- |
| HR 0–1 / 2–3 | ABCD Float32 电压 48.2 / 电流 1.2 |
| HR 4 | 0x0011；bit0 使能、bit4–6 模式 |
| HR 6 | 转速 1500 |
| HR 8–11 | ASCII `V2.4.0`，8 字节 |
| IR 0–1 / 2–3 | ABCD Float32 温度 42.0 / 输入电压 48.1 |
| 其余 / Coil / DI | 0 / false |

默认动态更新 HR0–3、IR0–3 与 DI0；控制字、目标转速、字符串和 Coil 写入后保持，不会每200ms被初始值覆盖。`--static` 关闭动态更新，可在整片寄存器上验证 Bool/BitField/Enum/String/整数/浮点映射。重启进程会重新初始化。

## 故障与诊断

`--fault timeout|exception|delay|bad-crc|malformed` 配合 `--fault-unit`、`--fault-fc` 定向注入；`--fault-count 1` 只注入一次，0 表示持续。

- `timeout`：命令可能已执行，但丢弃响应，用于验证写入结果未知及读回。
- `exception --exception-code 2`：返回异常，写入不执行。
- `delay --delay-ms 500`：延迟处理。
- `bad-crc`：仅 RTU，损坏响应 CRC。
- `malformed`：仅 TCP，损坏 MBAP Protocol ID。
- `--broadcast`：可选 RTU 广播；本工具上位机不发送 Unit 0，未纳入本次上位机验收。
- `--trace`：stdout 输出 RX/TX 十六进制；`ready` 在监听成功后输出。端口不可用时 stderr 报原因并非零退出。

## 自动化验证

```powershell
python -m unittest discover -s tools/simulator -p test_cli.py
$env:MODBUS_RTU_MASTER_PORT = 'COM1'
$env:MODBUS_RTU_SLAVE_PORT = 'COM2'
npm test -- tests/integration/simulator-wire.test.ts
npm run package
npm run test:e2e
```

环境变量只供测试脚本使用，实际从站进程仍通过 CLI 接收端口。未提供串口环境变量时 RTU 用例明确跳过，不能把该轮称为 RTU 验收通过；TCP 测试仍执行。用例自动启动和关闭自己的从站进程，无需提前手动占用端口。虚拟串口验证操作系统串口与真实字节链路，不验证物理 RS485 接线、电气噪声、收发器方向或设备固件行为。
