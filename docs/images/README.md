# README 截图来源

所有图片均来自实际运行的本项目，使用示例设备与本地 PyModbus 模拟器；没有生成或伪造设备数值。

| 图片 | 来源与场景 |
| --- | --- |
| realtime.png | 0.8.0 程序，Computer Use 采集；隔离的“Modbus 调试示例”工作区，127.0.0.1:50535 |
| connection.png | 已有 E2E 截图 `tests/e2e/screenshots/25-combo-open-1440.png`；添加连接的串口选项 |
| temporary-read.png | 已有 E2E 截图 `tests/e2e/screenshots/18-temp-read-1440.png`；一次读取结果示例 |
| template.png | 已有 E2E 截图 `tests/e2e/screenshots/12-templates-1440.png`；模板库概览 |
| trend.png | 已有 E2E 截图 `tests/e2e/screenshots/11-trend-1440.png`；实时趋势 |
| history.png | 已有 E2E 截图 `tests/e2e/screenshots/14-history-1440.png`；记录会话历史 |
| communication.png | 已有 E2E 截图 `tests/e2e/screenshots/13-comm-1440.png`；通信事务与报文 |

本次补充采集时 Windows 锁屏，因此除实时页外复用仓库已有的模拟器截图；它们的连接名称、端口、读取数量属于各自示例。操作说明已对照当前源码核对。扫描高级配置和失败反馈以 README 文字说明为准，不使用缺少这些新控件的旧扫描图。

后续更新时应使用隔离工作区重新采集相关页面，维持清晰、可读的窗口尺寸；不要使用个人工作区、真实设备凭据或锁屏画面。
