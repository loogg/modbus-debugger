# v0.12.1 正式发布验收

验收日期：2026-10-21 起。目标：Windows x64，目录、ZIP、Portable、Setup；源码版本由 `package.json` 与 lockfile 同步定义。发布源码以 Git 标签 `v0.12.1` 为准，发布前状态与后续线上核验分别记录。

当前状态：全部本地正式验收已通过，线上发布核验进行中。物理 RS485 电气与厂商设备没有对应环境，不计通过。

## 功能与修复范围

同一软件支持 TCP Client/Server、RTU 主站/从站，多连接与多 Unit 共享模板、独立设备内存。新增四区本地设值、保存启动初始值、八功能码响应、RTU 广播与正确异常；实时、趋势、Recorder、历史与通信诊断复用 Main Cache。从站不创建 Poll，旧工作区缺省为主站。

闭环发现的问题已修复：String 静默截断/编码失配、Float32 有限输入溢出、从站 Raw 方向、多 Unit 健康统计混算、同名信号来源、String 原始检查器截断、非法 Unit 与零长度 String、历史 500 条截断、非预设周期回填、位区单位、记录负计时、健康行身份与模板跳转。

需求、实现边界、完整逐屏交互/视觉记录与问题复验见[从站任务验收](../acceptance/slave-mode.md)；正式条件见[现行验收清单](../acceptance.md)。没有用截图或测试总数替代具体能力覆盖。

## 检查矩阵

| 现行清单范围 | 证据与结果 |
| --- | --- |
| Domain / Communication | 最终 Vitest 56 文件、536 项全部通过，零跳过；正式 TCP/RTU、独立 PyModbus、分片/粘包/坏帧恢复、晚到响应、尺寸、Unit 隔离、RMW 与写后回读/未知终态均包含 |
| 本机从站 | `slave-protocol`、`slave-runtime` 与 88 项本软件真实主从闭环；八 FC、独立内存、初值、被动缓存、广播、TCP 多客户端/端口冲突/资源释放、串口坏 CRC 和立即重启通过 |
| Trend / History / Diagnosis / Import | 最终新构建打包版常规 12 文件及新增闭环 6 场景通过，包含扫描、临时读取、所有类型、四类趋势、Schema、全量 CSV 与导入；RTU UI 的独立环境门控项显式补跑通过 |
| Persistence / 设置 | Unit/Integration 完整通过；工作区原子保存/恢复、初值、元数据/Raw、旧文件、偏好、10 GB 提醒、数据根目录与不可写错误有断言；Native 中文另存为实际落盘 |
| Figma Screen / State | 设备、连接/从站弹层、实时全部/块/原始检查器、模板/点位/内存/导入、趋势及弹窗、历史四页签/备注/回放、通信三视图、扫描/临时读取、设置、关于均有实际操作与视觉记录 |
| Responsive / Visual | 内置浏览器实际核对 1440×960、1280、1279、1024×680；工程列保留并内部滚动、长文本/标签受控、弹窗/抽屉底部操作可达；发布前补验错误日志为空 |
| Simulator / Fixtures | 黄金字节来自 Node IEEE 写入器与显式字序排列；PyModbus 独立实现；本软件双方不共享设备 Cache、不直接复制值；COM1↔COM2 实跑 |
| 百万样本容量 | 最终打包版通过：打开 4752 ms、回放打开 72 ms、游标/重绘 283 ms、完整 CSV 713 ms；预算为打开/CSV 各 <30 s、游标 <5 s，不把 10 GB 提醒当作容量性能保证 |
| 更新与自升级 | Unit/Integration、真实目录/ZIP、Portable、Setup 下载/校验/备份/升级/重启通过；Setup 受控失败返回 23，实际回滚程序及安装登记，数据与未知文件保持 |
| Windows 四产物 | `npm run make -- --platform=win32 --arch=x64` 成功；四种启动、v0.12.1、IPC、serialport、WASM/历史、manifest 文件哈希、Portable 中文独立目录和重启数据、自选数据目录、Setup 自选安装/重装/卸载均通过 |
| 工程/隔离 | lint/typecheck、文档链接和差异检查通过；全部测试数据在 `out/test-temp/`；产物/运行数据不纳入 Git，原有 `.gitignore` 修改保留；正常卸载测试安装，关闭模拟器和应用 |

## 数据类型与功能码闭环

下表全部在 TCP 与 RTU 分别执行。输入寄存器按同一黄金数据建立只读映射；主站写后回读和从站实际原始内存分别核对，失败输入不改变确认值。

| 数据类型/映射 | 实际覆盖 |
| --- | --- |
| Bool | Coil/DI、寄存器 bit 0/15；ON/OFF、本地与远端、只读区与邻位保持 |
| BitField / Enum | 3 位/16 位、普通 UInt16 枚举和位域枚举；界限/非法值及标签变化 |
| Int8 / UInt8 | 高/低字节独立映射；有符号边界、字节范围和同寄存器邻字节保持 |
| Int16 / UInt16 | 负值、极值、越界拒绝；原始字与工程值交叉核对 |
| Int32 / UInt32 | ABCD/CDAB/BADC/DCBA，负数/32 位边界、完整 2 寄存器内容 |
| Float32 / Float64 | 四种字序；IEEE 独立预期、有限写入、溢出拒绝；设备 NaN/Infinity 原始读取及恢复 |
| Scale / Offset / Precision | 正/负缩放、偏移、整数编码量化、scale=0 拒绝；显示小数位不舍入原始历史/CSV |
| String | ASCII 1/8/246 字节、UTF-8 5/12 字节、中文/emoji、奇数长度、短文本零填充、空文本清除；超长/非法 ASCII/NUL/零字节定义拒绝 |

FC01/02 读到 2000 位，FC03/04 读到 125 寄存器；FC05/06 单写，FC15 写到 1968 位，FC16 写到 123 寄存器。覆盖地址 65535、连续块跨界、缺口/未定义地址异常和失败批写原子性。RTU 广播仅写且无响应；坏 CRC 后下一合法分片恢复。两种传输各 44 项，共 88 项本软件主从闭环通过。

## 执行顺序与证据

源码完整验证显式串行开启所有串口项：`MODBUS_SELF_RTU=1`、`MODBUS_RTU_MASTER_PORT=COM2`、`MODBUS_RTU_SLAVE_PORT=COM1`、`MODBUS_SLAVE_RTU_PORT=COM1`、`MODBUS_SLAVE_MASTER_PORT=COM2`，执行 `npx vitest run --maxWorkers=1 --minWorkers=1`。最终结果 536/536，零跳过。

打包业务基线使用外部 RTU 从站 COM2、应用主站 COM1；本软件自测用 COM1 从站/COM2 主站，19200 / 8N1。两套 E2E 和其他 Electron 验证串行执行。首轮曾误将常规 E2E 与产物 Smoke 并行，窗口关闭干扰导致部分用例失败；已中止受干扰 E2E 并保留日志，从干净环境完整重跑，不将失败轮次计通过，也未为此修改产品或降低断言。

最终常规 E2E 为 59 项通过，1 项因缺少 `MODBUS_RTU_MASTER_PORT` 默认跳过；随后显式设置主站 COM1、模拟从站 COM2，单独实跑该 RTU Native UI 项通过。与新的主从 6 项合计 66 个不同业务场景均已执行通过，无未验证的串口项。复现命令已同时注明两个环境变量，不将最初的默认跳过冒充通过。

容量 CSV 从系统剪贴板读回 28,888,904 字符（Windows CRLF），首末样本正确且为完整 100 万行；回放蓝色曲线像素 99,493，游标值 65.8°C 与原始样本索引一致。瞬时 Renderer heap 约 259 MB、Main RSS 约 403 MB，不是峰值或 GB 级负载保证。

实际自升级在 `out/test-temp/self-update-app-release-0.12.1/` 生成测试用 0.12.2；仅 HTTP Release 元数据/包下载映射至本地夹具，程序下载、摘要校验、helper、NSIS、备份、重启、数据库与注册表均真实执行。目录/ZIP、改名的单文件 Portable、Setup 均成功升级；Setup 故障夹具破坏程序与安装登记后退出 23，helper 恢复 0.12.1、原 ASAR、登记版本与用户数据。两个 Setup 测试均正常卸载并等待登记/程序清理完成。测试用 0.12.2 未提交、未发布。

可重建的本机证据：`out/test-temp/release-0.12.1/` 下构建、常规 E2E、主从 E2E、容量、四产物 Smoke、自升级日志；`out/test-temp/full-e2e/`、`loopback-evidence/native/`、`capacity/`、`release-smoke-screenshots/`、`self-update-shots/` 下的截图/JSON。长期关键截图保留在 [RTU 主从轨迹](../images/master-slave-loopback.png)和[从站内存](../images/slave-memory.png)。

## 发布与适用边界

本地 `release/` 平铺四种同版本产物和更新 manifest。GitHub 标签工作流将重新构建同一源码并执行 Smoke 后发布；线上附件与 SHA-256、解压清单和启动结果待发布后核验，不把本地产物哈希当作线上哈希。

实际串口覆盖 Windows ELTIMA COM1↔COM2 虚拟驱动、Native serialport 和 RTU 字节链路；没有物理 RS485 接线、收发器方向、电气噪声与特定厂商设备，保留为未验证。测试安装位于隔离目录，并拒绝覆盖现有日常安装；未修改日常工作区/历史库。
