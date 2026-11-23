# README 截图来源

所有图片均来自实际运行的本项目。设备数据来自示例设备、本地 PyModbus 模拟器或本工具的主从闭环；编辑态预览截图还包含界面明确标记的本地模拟值和示例波形。

历史兼容截图使用独立构造的旧格式 SQLite 夹具，通过真实 Backend 和历史读取界面展示。

这些图片是不同版本的操作示例，不能单凭旧截图判定当前界面的控件或状态。更新受影响的 README 画面时，重新在真实界面采集并在下表记录版本与场景。

| 图片 | 来源与场景 |
| --- | --- |
| pressure-bench-cycle.png | 0.30.0 泵站联调工作区，连接真实 Main 和本机软件从站。独立压力模型驱动橙色反馈曲线，蓝线为确认的给定值。 |
| realtime.png | 0.8.0 程序，Computer Use 采集；隔离的“Modbus 调试示例”工作区，127.0.0.1:50535 |
| connection.png | 已有 E2E 截图 `tests/e2e/screenshots/25-combo-open-1440.png`；添加连接的串口选项 |
| temporary-read.png | 已有 E2E 截图 `tests/e2e/screenshots/18-temp-read-1440.png`；一次读取结果示例 |
| template.png | 已有 E2E 截图 `tests/e2e/screenshots/12-templates-1440.png`；模板库概览 |
| template-memory.png | 进入仓库时为 0.10.2；点位内存布局，原采集命令未记录 |
| trend.png | 已有 E2E 截图 `tests/e2e/screenshots/11-trend-1440.png`；实时趋势 |
| string-track.png | 进入仓库时为 0.9.1；String 趋势轨道，原采集命令未记录 |
| history.png | 已有 E2E 截图 `tests/e2e/screenshots/14-history-1440.png`；记录会话历史 |
| [history-legacy.png](history-legacy.png) | 0.20.0，2026-11-13，Browser Review 1440×960。读取旧格式 SQLite，展示 9 个信号的保存定义及已完成、未结束会话。 |
| [settings-sampling.png](settings-sampling.png) | 0.20.0，2026-11-13，Browser Review 1440×960。采样缓冲、旧历史库路径和当前设置导航。 |
| communication.png | 已有 E2E 截图 `tests/e2e/screenshots/13-comm-1440.png`；通信事务与报文 |
| about.png | 进入仓库时为 0.10.1；关于与更新页，原采集命令未记录 |
| slave-memory.png | 0.12.0，2026-10-21；内置浏览器 1440×960，通过真实 Bridge 连接隔离 Electron Main，1234 / 4660 / 43981 为独立 PyModbus 主站实际写入，见[从站任务验收](../acceptance/slave-mode.md) |
| master-slave-loopback.png | 0.12.1，2026-10-21；内置浏览器 1440×960，真实 Native Main 的 TCP + COM1↔COM2 四连接在线；RTU 主从各记录 Bool、Enum、UTF-8 中文/emoji，展示同一会话的双端状态与文本轨迹 |
| [canvas-workbench.jpg](canvas-workbench.jpg) | 0.13.0，2026-11-11，Windows 目录版原生窗口。图标控件库、浅蓝背景、文字标签、容器、真实 PyModbus TCP 确认值 2400 与 V/A 双轴曲线。见[画布与工作台任务](../acceptance/canvas-workbench.md) |
| [canvas-variants.jpg](canvas-variants.jpg) | 0.14.0，2026-11-11，Windows 原生窗口。五种仪表和输入，真实确认值 1729、文本 WIN-A、枚举下拉，16 px 字号与 10 px 圆角，弹层位于控件下方。 |
| [canvas-lamp.jpg](canvas-lamp.jpg) | 0.15.0，2026-11-11，Windows 原生窗口。亮灭双色、线性/径向渐变、枚举和区间状态、紫色未匹配默认状态，TCP 回读 2500 后显示“高速”。 |
| [canvas-preview.jpg](canvas-preview.jpg) | 0.16.0，2026-11-11，Windows 原生窗口。设备确认值仍为 1500，独立预览转矩状态、仪表 3000、输入 2500 的失败态及中心值 48 的模拟曲线。预览未进入确认缓存或历史记录。 |
| [host-buffer-cursor.jpg](host-buffer-cursor.jpg) | 0.17.0，2026-11-12，Browser Review、真实 Backend 与 PyModbus。20 ms 控制块和 80 ms 遥测块，光标分别显示转速与温度的实际采样时间、序号和值。 |
| [host-buffer-native.jpg](host-buffer-native.jpg) | 0.17.0，2026-11-12，最终目录版原生窗口与 PyModbus TCP。500 ms Host 刷新、10 秒显示窗口，跨块光标展示各信号的毫秒时间和独立序号，系统保存对话框及弹出/拖动/回入已复验。 |

本次补充采集时 Windows 锁屏，因此除实时页外复用仓库已有的模拟器截图；它们的连接名称、端口、读取数量属于各自示例。操作说明已对照当前源码核对。扫描高级配置和失败反馈以 README 文字说明为准，不使用缺少这些新控件的旧扫描图。

后续更新时应使用隔离工作区重新采集相关页面，维持清晰、可读的窗口尺寸；不要使用个人工作区、真实设备凭据或锁屏画面。

## 0.11.4 审核修复证据

对应[本轮验收记录](../acceptance/audit-fixes-2026-10-20.md)，2026-10-20 重新采集并查看：

| 图片 | 来源与场景 |
| --- | --- |
| audit-fixes-2026-10-20-native-pre-read-exception.png | 最终 0.11.4 目录版，WDIO 实际操作；独立 PyModbus 只对数量为 1 的 FC03 返回 0x02，写前读取失败后保留 ON、显示未发送及原因 |
| audit-fixes-2026-10-20-pre-read-timeout.png | 内置浏览器、真实独立 Backend、1024×680；同样数量过滤的预读超时，等待态结束、确认值保持、错误提示与表内滚动正常 |

## 0.21.0 曲线读取验证

- [画布窗口与光标](host-column-window.jpg)使用内置浏览器、真实独立 Backend 和 PyModbus TCP 50525。画布按 5 秒显示，光标逐信号展示实际采样时间、序号和值。
- [紧凑趋势窗口](host-column-compact.jpg)为 1024×680 实际画面。图表按当前容器宽度调整，双纵轴、刷新周期、时间窗口和导出入口可达。
- [原生窗口与光标](host-column-native.png)为 0.21.0 目录版的实际弹出窗口，使用 Computer Use 手动完成拖动、光标、原始 CSV 导出及回入，数据来自独立 PyModbus TCP 50525。

上述数据来自 out/test-temp/column-data-review 的隔离工作区，对应[Host 数据验收记录](../acceptance/host-data-buffers.md)。

## 0.22.0 网格与对齐

- [网格与混合控件排列](canvas-grid-layout.jpg)使用真实独立 Backend 与内置浏览器，展示 16 px 网格、独立显示/吸附开关、混合尺寸灯与开关的垂直居中和水平等间距。验证数据位于 out/test-temp/canvas-grid-review，记录见[画布验收](../acceptance/canvas-workbench.md)。
- [原生嵌套吸附](canvas-grid-native.jpg)为最终 0.22.0 目录版手动复验。弹出页保留 16 px 网格，嵌套灯的局部位置为 (33,53)、尺寸为 48×48，实际保存并回入主窗口。

## 0.23.0 写应答与只写点位

- [原生命令窗口](write-ack-native.jpg)为最终 0.23.0 目录版手动点击后的独立窗口。独立 PyModbus TCP 的正常、异常与丢失应答分别产生成功、拒绝、未知反馈，只写输入显示最近成功命令 88，FC22 只写开关显示 ON，普通数值显示采集确认转速 1733 rpm。窗口已实际拖动并回入，运行数据位于 out/test-temp/write-ack-review，记录见[Host 数据验收](../acceptance/host-data-buffers.md)。

## 0.24.0 通信诊断与曲线查询

- [原生暂停快照](curve-query-native.jpg)为 2026-11-17 的 0.24.0 目录版独立窗口。实际写入转速 1900 后暂停曲线，后台每点 400 个样本持续覆盖，窗口保留原时段并显示“所选时段已超出后台缓存范围”。弹出、拖动、复制视图、回入及恢复跟随已手动复验。
- [原生连接健康](diagnostics-health-native.jpg)为重新打包后的原生画面。通信日志的暂停、恢复及清空已手动复验。图中 TCP 展示吞吐与时延双轴，单位与图例分行可读。数据来自独立 PyModbus TCP 50525，5/20 ms 数据块的实际周期在表内显示。

上述操作使用 out/test-temp/diagnostic-024-review 的隔离工作区，对应[Host 数据验收记录](../acceptance/host-data-buffers.md)。
