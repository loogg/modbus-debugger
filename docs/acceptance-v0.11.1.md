# 0.11.1 本地验收逐项记录

日期：2026-09-25（Asia/Shanghai）。范围为本机 Windows x64 工作区与本机生成的交付包；未推送提交、标签或 GitHub Release。本记录逐条对应 [现行验收清单](acceptance.md)，不是对未验证条件的自动放行。

**源码身份**：基底 HEAD `21603daae69f5f5c4608c8886d0f51885334f019` 叠加**未提交工作树**，不能把 HEAD 单独当作构建源码。[可复算清单](../out/audit/v0.11.1-source-identity.json)列出 111 个应用/打包输入，内容树 SHA-256 为 `7f890e271a565e9927700d6b746819d009cf9c7d18471d8098c6a91cb6b40db7`；`app.asar` 为 `040238cf36452e0437b537ba9847aa28334dba6d05362d9f1029738d13866c46`，其写入时间比最新输入晚 174 秒。ASAR 内 6 个 Vite 输出与打包前字节哈希一致；manifest 的 85 项文件哈希和四产物摘要亦在清单中。未提交状态仍限制了从 Git 提交直接复现该包。

**证据入口**：[最终 Vitest](../out/audit/v0.11.1-vitest-final.log)为 43 文件、344/344；[最终打包版 E2E](../out/audit/v0.11.1-e2e-final.log)为 9 spec、54/54，无 skip；[make](../out/audit/v0.11.1-make-final.log)与[四产物 Smoke](../out/audit/v0.11.1-smoke-release-final.log)通过；[100 万样本容量 Smoke](../out/audit/v0.11.1-capacity-e2e-visual.log)与[空工作区首次使用](../out/audit/v0.11.1-empty-first-use.log)通过；[30 屏 Figma 逐项审查](figma-visual-audit-v0.11.1.md)为 30/30。[最终包自升级](../out/audit/v0.11.1-self-update-final.log)验证 ZIP/Portable/Setup，[故障回滚](../out/audit/v0.11.1-self-update-rollback-final.log)验证 Setup。早期失败、修复及重跑过程见 [full-audit.md](full-audit.md)。`out/` 为 Git 忽略的本地证据，搬到别的机器时需同时保存。

**逐项结论：83/83 PASS，0 PARTIAL，0 PENDING，0 UNVERIFIED。** 下文同时列出测试能力的实际边界，不将提醒阈值或虚拟设备扩写为未做过的性能/硬件验证。

状态：**PASS**＝此条件有直接代码/测试与当前源码的运行证据；**PARTIAL**＝可证实其中一部分；**PENDING**＝最后一项外部或运行门槛尚未完成。表内的 `V`、`E`、`S`、`U/R` 分别指最终 Vitest、打包版 E2E、四产物 Smoke 和自升级/回滚。完整 E2E 门槛只按完整套件判定，不用定向通过替代。

## Domain / Communication

| 清单行 | 状态 | 本轮可核对证据及边界 |
| --- | --- | --- |
| 9 模型与 Unit ID | PASS | V：[domain.test.ts](../tests/unit/domain.test.ts) 的 `v0 payload ... migrates into templates`、[manager-delta.test.ts](../tests/integration/manager-delta.test.ts) 的 `...isolated by slave`；E：[app.e2e.ts](../tests/e2e/app.e2e.ts) `launches ... topology`。 |
| 10 流式解析分层 | PASS | V：[framer-streaming.test.ts](../tests/unit/framer-streaming.test.ts) 的 split/multi/half+sticky 用例；分层入口在 [connection-runtime.ts](../src/main/runtime/connection-runtime.ts) 与 [validate.ts](../src/domain/protocol/validate.ts)。 |
| 11 TCP 分片、坏帧、Resync | PASS | V：`framer-streaming.test.ts` 的 TCP split、multi、half+sticky、garbage、bad Protocol ID/Length、truncated、bad frame recovery；[runtime-tcp.test.ts](../tests/integration/runtime-tcp.test.ts) 的 `truncated candidate followed by a good frame`。 |
| 12 RTU 分片、CRC、噪声与非时序分帧 | PASS | V：`framer-streaming.test.ts` 的 RTU split、multi、half+sticky、CRC-bad+good、noise、truncated、buffer bounded、arbitrary inter-chunk gaps；[framer.ts](../src/domain/protocol/framer.ts) 与 [RTU 说明](protocol/02-rtu-framing.md)可核对无字符间隔判决。 |
| 13 Exception / Unexpected / Malformed 分类 | PASS | V：[validate.test.ts](../tests/unit/validate.test.ts) 的 RTU Unit/FC/length、TCP TID/Protocol ID、Exception/CRC；`runtime-tcp.test.ts` 的 wrong-TID 诊断与匹配响应继续完成。 |
| 14 协议尺寸与有界缓存 | PASS | V：`framer-streaming.test.ts` 的 `respects protocol size limits`、`buffer is bounded`、oversize Length 与后续恢复；[protocol-golden.test.ts](../tests/unit/protocol-golden.test.ts) 验证独立字节向量。 |
| 15 TCP 迟到 TID | PASS | V：`framer-streaming.test.ts` 的 `late transaction id ... not merged`；`runtime-tcp.test.ts` 的 `timeout ... late response ... not applied`。 |
| 16 RTU drain 与同 Unit/FC 迟到帧 | PASS | V：[scan-rtu.test.ts](../tests/integration/scan-rtu.test.ts) 的 `ordinary RTU timeout drains a late same-Unit/same-FC reply before the next read` 与停止扫描用例；迟到旧帧被记录、丢弃，新请求获得另一真实响应。边界：RTU 无事务 ID，**超出 bounded quiet window 后**才到达的同 Unit/FC/同长度旧帧无法无歧义区分。 |
| 17 错帧后合法帧保留 | PASS | V：`framer-streaming.test.ts` 的 CRC-bad+good、truncated+good 与 partial TCP prefix；`runtime-tcp.test.ts` 的 wrong TID + matching frame。 |
| 18 诊断字段完整性 | PASS | V：[runtime-tcp.test.ts](../tests/integration/runtime-tcp.test.ts) 的 wrong-TID Unexpected 与 malformed prefix 分别逐字段断言 kind/reason/rawHex/discarded/recoveredCount/traceId/unitId/FC/sourceKind；[scan-rtu.test.ts](../tests/integration/scan-rtu.test.ts) 的 RTU resync `recoveredCount=1`、无请求时 context 明确为 null，以及超时 late frame 的原请求 context。[contracts.ts](../src/shared/contracts.ts) 约束字段。 |
| 19 Block/Point overlap 与地址 | PASS | V：`domain.test.ts` 的 same-area reject、different-area allow、point share、`40001 -> Holding 0`；`audit-regressions.test.ts` 的导入重叠拒绝。 |
| 20 共享 Block Cache、无重复 Poll | PASS | V：`runtime-tcp.test.ts` 的轮询填充缓存和写回读，`manager-delta.test.ts` 的同模板多从站确认值/记录隔离；[manager.ts](../src/main/runtime/manager.ts) 持有唯一 BlockCache，Trend/Recorder 读取该缓存。 |
| 21 共享 DTO、细粒度命令、无丢编辑及重建关闭顺序 | PASS | V：[workspace-mutations.test.ts](../tests/integration/workspace-mutations.test.ts) 的 `applies successive block and trend edits...`、`rejects duplicate IDs...`、`waits for the old transport to close...`；[commands.ts](../src/shared/commands.ts)、[contracts.ts](../src/shared/contracts.ts)；E：audit 的模板/趋势操作。 |
| 22 编辑至确认及失败状态 | PASS | V：[value-cell.test.tsx](../tests/unit/ui/value-cell.test.tsx) 的 confirmed/editing/pending/rejected/unknown；`runtime-tcp.test.ts` 的 write→readback、exception、timeout；E：audit 高风险写入和 app 写后确认。 |
| 23 Mapping Golden | PASS | V：[domain.test.ts](../tests/unit/domain.test.ts) 的 Int/UInt、Float32 四序、独立 IEEE-754 Float64 π `40 09 21 FB 54 44 2D 18` 四序、Bool/BitField、UInt8 high/low、ASCII/UTF-8 `中AB` 五字节跨三寄存器；[mapping-golden.test.ts](../tests/integration/mapping-golden.test.ts) 用寄存器 `0x0030` 验证 BitField raw=3 → Enum `Alarm`，未映射 raw 保持原码。 |
| 24 Scale/量化与非法写入 | PASS | V：`domain.test.ts` 的 scale/offset、quantization、zero scale、NaN/Infinity、range；E：audit 的非法 Bool 不发包。 |
| 25 正式 Transport 与调度原子性 | PASS | V：`runtime-tcp.test.ts` 的 scanner exclusive、write/readback、latest-register RMW；`simulator-wire.test.ts` 的 TCP/RTU 八功能码实际线缆模拟互操作；E：audit 的 RTU UI 新建与读写。 |
| 26 trace/source/Raw ADU 与 MBAP 分离 | PASS | V：`runtime-tcp.test.ts` 的 trace/source/duration、请求/响应 PDU 精确向量及异常 PDU `8602`；`scan-rtu.test.ts` 的 RTU PDU `0300000001` / `03020007`；[contracts.ts](../src/shared/contracts.ts) 分别携带 ADU、真实 PDU 与 MBAP TID。通信页当前仍以完整 ADU 为主要展示，PDU 已进入共享事务契约。 |

## Trend / History / Diagnosis / Import

| 清单行 | 状态 | 本轮可核对证据及边界 |
| --- | --- | --- |
| 30 扫描高级配置与 FC01–04 | PASS | V：[device-tools.test.tsx](../tests/unit/ui/device-tools.test.tsx) 的折叠/重开/锁定，[scan-options.test.ts](../tests/unit/scan-options.test.ts) 的 IPC 拒绝非法参数，`runtime-tcp.test.ts` 的 FC01–04、超时/重试覆盖与默认恢复；E：audit 的扫描折叠设置。 |
| 31 临时读取与扫描生命周期 | PASS | V：`runtime-tcp.test.ts` 的停止保留结果、恢复排队读/轮询、写原子组后扫描、重复扫描拒绝、异常码；`device-tools.test.tsx` 的默认 10、页面重挂仍可停止；E：audit 临时读取与扫描。 |
| 32 四类 Trend 与记录语义 | PASS | V：[manager-delta.test.ts](../tests/integration/manager-delta.test.ts) 的 `stores numeric samples and Bool, Enum, String change events from confirmed Block Cache values` 验证初值/变化事件、Schema 与重开数据库；[state-track.test.tsx](../tests/unit/ui/state-track.test.tsx) 验证状态边沿，[chart-units.test.tsx](../tests/unit/ui/chart-units.test.tsx) 验证数值系列；E：[display-followup.e2e.ts](../tests/e2e/display-followup.e2e.ts) 的混合图表。 |
| 33 Session Schema Snapshot | PASS | V：[persistence.test.ts](../tests/integration/persistence.test.ts) 的 `schema snapshot survives later template changes`；E：full-features 的趋势→历史信号页。 |
| 34 Scanner/Temporary/Raw/Health/Trace/Replay | PASS | E：`app.e2e.ts` 的扫描、临时读；`audit.e2e.ts` 的原始数据/回放；[full-features.e2e.ts](../tests/e2e/full-features.e2e.ts) 的健康/点位追踪；V：`manager-delta.test.ts` 的真实健康序列。 |
| 35 预填按钮与帧 Hex 复制精确性 | PASS | V：[device-tools.test.tsx](../tests/unit/ui/device-tools.test.tsx) 的 `range presets only update the draft until Start sends ...` 与 [comm-hex-copy.test.tsx](../tests/unit/ui/comm-hex-copy.test.tsx)；E：[scan-presets-hex.e2e.ts](../tests/e2e/scan-presets-hex.e2e.ts) 两用例分别核实预填前无发包、启动后按选定范围/地址发包，以及剪贴板请求/响应 Hex 与事务 ADU 字节完全一致。 |
| 36 XLSX/CSV/JSON/Clipboard 导入 | PASS | V：[import-files.test.ts](../tests/integration/import-files.test.ts) 对真实 XLSX/JSON 文件解析及重叠原子拒绝；E：[acceptance-gaps.e2e.ts](../tests/e2e/acceptance-gaps.e2e.ts) 经真实文件选择/映射/预览分别提交 XLSX 与 JSON，[audit.e2e.ts](../tests/e2e/audit.e2e.ts) 经 Clipboard 粘贴 CSV 并核对类型/宽度；`full-features.e2e.ts` 检查预览步骤。 |

## Persistence

| 清单行 | 状态 | 本轮可核对证据及边界 |
| --- | --- | --- |
| 40 Workspace 自动/原子保存、迁移和恢复 | PASS | V：`persistence.test.ts` 的 atomic/reload/no temp/import failure/autosave、`domain.test.ts` 的 v0 migration；E：audit 的另存为与失败导入保留工作区；S：Portable 重启保留。 |
| 41 Template 共享及独立导入/导出 | PASS | V：`manager-delta.test.ts` 的同模板多从站隔离；E：`audit.e2e.ts` 的复制隔离 ID、导出模板、清空后单独导入；`template-edit.e2e.ts` 的保存与引用清理。 |
| 42 history.db 路径/持久化/10GB/Raw | PASS | V：`persistence.test.ts` 的 session 重开；[manager-delta.test.ts](../tests/integration/manager-delta.test.ts) 的 `captures Tx and Rx only while Raw Communication is enabled ... reopening` 与注入 >10 GiB 文件大小后的告警；[settings.tsx](../src/renderer/screens/settings.tsx) 的路径/开关；S：Portable 历史跨重启。测试只证明**提醒阈值**，未创建 10 GiB 数据库或证明该容量可用。 |
| 43 增长基准与目标容量回放/导出 | PASS | [容量报告](history-capacity-benchmark.md)、[可重复脚本](../tools/bench-history.mjs) 与[最终打包版容量 Smoke](../out/audit/v0.11.1-capacity-e2e-visual.log)：真实 100 万数值样本会话打开 **4,698 ms**、回放启动 **98 ms**、滑块游标连同曲线稳定 **300 ms**、完整 CSV 写入剪贴板 **753 ms**；[结果 JSON](../out/audit/capacity-1m-smoke.json) 核验 100 万行、首末行与 Canvas 曲线像素，均低于现行 30 s / 5 s 预算。GB/10GB 不是当前目标；持续增长期间 Main 同步 flush 对高频轮询的抖动仍未测。 |
| 44 更新路径与测试隔离 | PASS | V：[storage-paths.test.ts](../tests/unit/storage-paths.test.ts) 的绝对优先级、可写验证与不回退；`release.test.ts` 的 Portable 外层路径；U/R 的选定根目录与未知文件保留；`out/test-temp/` 隔离、遗留目录见文末。 |

## Figma Screen / State

设计来源已按 [Figma 00](https://www.figma.com/design/dQmLfIDT6zzIjCr4iFC7Cz?node-id=80-113)、[01](https://www.figma.com/design/dQmLfIDT6zzIjCr4iFC7Cz?node-id=62-2)、[02](https://www.figma.com/design/dQmLfIDT6zzIjCr4iFC7Cz?node-id=94-2) 核对高层语义、页面节点和组件规则。30 屏的原稿、实际截图、结构差异及各结论见[逐屏视觉审查](figma-visual-audit-v0.11.1.md)，该报告最终为 **30 PASS**。以下 `PASS` 限于截图可见的主结构与明确功能/状态，不代表逐像素一致、读屏合规或物理设备验收；Mock 截图不计正式通信。

| 清单行 / 屏 | 状态 | 当前功能或画面证据；缺口 |
| --- | --- | --- |
| 48 / 01 设备拓扑 | PASS | [原稿](../out/audit/figma-reference/62-5.png) · [实际](../out/audit/screenshots/audit-设备-1440.png)；E：`app.e2e.ts` 拓扑启动。 |
| 49 / 02 添加连接 | PASS | [原稿](../out/audit/figma-reference/62-6.png) · [实际 RTU Dialog](../out/browser-review/live_07_add_connection_dialog.png)；E：`full-features.e2e.ts` 端口选择、`audit.e2e.ts` RTU 创建。 |
| 50 / 03 添加从站 | PASS | [原稿](../out/audit/figma-reference/62-7.png) · [最终包 Dialog](../out/audit/figma-current/03-add-slave-dialog.png)；E：`full-features.e2e.ts` Unit 冲突与创建。 |
| 51 / 04A 实时全部数据 | PASS | [原稿](../out/audit/figma-reference/62-8.png) · [实际](../out/audit/screenshots/audit-实时-1440.png)；E：`app.e2e.ts` 确认值。 |
| 52 / 04B 实时数据块 | PASS | [原稿](../out/audit/figma-reference/160-2.png) · [聚焦块](../out/audit/figma-current/04B-realtime-block-focus.png)；E：`app.e2e.ts` 内部横滚。 |
| 53 / 05 模板库 | PASS | [原稿](../out/audit/figma-reference/62-9.png) · [实际](../out/audit/screenshots/audit-模板-1440.png)；E：`template-edit.e2e.ts` 树导航。 |
| 54 / 06 模板编辑 | PASS | [原稿](../out/audit/figma-reference/62-10.png) · [映射/属性](../out/browser-review/current-inspector-1440-top-badge.png)；E：`template-edit.e2e.ts` 编辑保存。 |
| 55 / 07 编辑数据块 | PASS | [原稿](../out/audit/figma-reference/62-11.png) · [最终包编辑 Dialog](../out/audit/figma-current/07-edit-existing-block-dialog.png)；E：`audit.e2e.ts` 保存与重叠校验。 |
| 56 / 08 编辑点位 | PASS | [原稿](../out/audit/figma-reference/62-12.png) · [实际 Drawer](../out/browser-review/current-point-drawer-no-badge.png)；E：`audit.e2e.ts` 新建与编辑。 |
| 57 / 09 趋势信号 | PASS | [原稿](../out/audit/figma-reference/62-13.png) · [实际](../out/browser-review/current-trend-signal-restored.png)；E：`audit.e2e.ts` 显隐/删除。 |
| 58 / 10 添加信号 | PASS | [原稿](../out/audit/figma-reference/62-14.png) · [实际 Dialog](../out/browser-review/current-trend-add-signal-dialog.png)；E：`audit.e2e.ts` 添加信号。 |
| 59 / 11 趋势图表 | PASS | [原稿](../out/audit/figma-reference/62-15.png) · [数值图](../out/audit/figma-current/11-trend-chart-enum-track.png) · [Enum 命名段](../out/audit/figma-current/11-enum-track-detail.png)；E：`display-followup.e2e.ts` 多单位。 |
| 60 / 11B 记录中 | PASS | [原稿](../out/audit/figma-reference/222-79.png) · [记录中](../out/browser-review/expert/13_trend_recording_active.png)；E：`audit.e2e.ts` 开始/停止。 |
| 61 / 12 历史会话 | PASS | [原稿](../out/audit/figma-reference/62-16.png) · [实际](../out/audit/screenshots/audit-历史-1440.png)；E：`audit.e2e.ts` 会话/备注/CSV。 |
| 62 / 12B 历史信号 | PASS | [原稿](../out/audit/figma-reference/218-32.png) · [最终包信号表](../out/audit/figma-current/12B-history-signals.png)；E：`full-features.e2e.ts` 历史信号页。 |
| 63 / 13 通信诊断 | PASS | [原稿](../out/audit/figma-reference/62-17.png) · [最终包 TX/RX 双行](../out/audit/figma-current/13-comm-tx-rx.png)；E：`scan-presets-hex.e2e.ts` 方向/字节/复制。 |
| 64 / 14 设置 | PASS | [原稿](../out/audit/figma-reference/62-18.png) · [实际](../out/audit/screenshots/audit-设置-1440.png)；E：`full-features.e2e.ts` 设置分区。 |
| 65 / 15 空工作区 | PASS | [原稿](../out/audit/figma-reference/62-19.png) · [真实首次使用](../out/audit/figma-current/15-empty-first-use.png)；[独立打包版 E2E](../tests/capacity/first-use.e2e.ts) 从无 prefs/workspace 启动并核对三入口与推荐流程。 |
| 66 / 16 新建趋势组 | PASS | [原稿](../out/audit/figma-reference/145-2.png) · [最终包 Dialog](../out/audit/figma-current/16-new-trend-group-dialog.png)；E：`audit.e2e.ts` 创建后加信号。 |
| 67 / 17 扫描从站 | PASS | [原稿](../out/audit/figma-reference/192-2.png) · [完成态](../out/audit/screenshots/17-scan-1440.png)；E：`audit.e2e.ts` 停止/重扫。 |
| 68 / 18 临时读取 | PASS | [原稿](../out/audit/figma-reference/192-163.png) · [实际成功态](../out/audit/screenshots/18-temp-read-1440.png)；E：`audit.e2e.ts` 真实 Raw/异常反馈。 |
| 69 / 18B 保存为数据块 | PASS | [原稿](../out/audit/figma-reference/214-123.png) · [最终包 Dialog](../out/audit/figma-current/18B-save-as-block-dialog.png)；E：`acceptance-gaps.e2e.ts` 保存并核对 Block。 |
| 70 / 18C 模板下拉 | PASS | [原稿](../out/audit/figma-reference/222-2.png) · [展开菜单](../out/audit/figma-current/18C-save-as-block-template-dropdown.png)；E：`acceptance-gaps.e2e.ts` 选 FlowMeter 并保存到正确模板。 |
| 71 / 18D 新建模板 | PASS | [原稿](../out/audit/figma-reference/236-24.png) · [嵌套 Dialog](../out/audit/figma-current/18D-save-as-block-new-template-dialog.png)；E：`acceptance-gaps.e2e.ts` 创建并选择后保存块。 |
| 72 / 19 原始数据检查器 | PASS | [原稿](../out/audit/figma-reference/193-2.png) · [最终包 Raw Drawer](../out/audit/figma-current/19-realtime-raw-inspector-drawer.png)；字节与寄存器一致，E：`audit.e2e.ts` 原始数据操作。 |
| 73 / 20 连接健康 | PASS | [原稿](../out/audit/figma-reference/192-388.png) · [实际](../out/audit/screenshots/20-comm-health-1440.png)；V：`manager-delta.test.ts` 的 1 Hz 健康序列。 |
| 74 / 21 离线回放 | PASS | [原稿](../out/audit/figma-reference/193-195.png) · [百万样本回放曲线](../out/audit/capacity-1m-replay.png)；[容量视觉 E2E](../tests/capacity/history-capacity.e2e.ts) 等待 Canvas 曲线像素后核对游标值。 |
| 75 / 22 导入寄存器表 | PASS | [原稿](../out/audit/figma-reference/193-367.png) · [映射/预览/固定 CTA](../out/audit/figma-current/22-register-import-mapping-preview.png)；E：`acceptance-gaps.e2e.ts` 实际 XLSX/JSON 导入及视口几何断言。 |
| 76 / 23 点位追踪 | PASS | [原稿](../out/audit/figma-reference/194-12.png) · [最终包追踪面板](../out/audit/figma-current/23-point-trace.png)；关联七个点位名称及 Raw 请求/响应可见，E：`full-features.e2e.ts`。 |
| 77 / 24 数值缩放 | PASS | [原稿](../out/audit/figma-reference/197-3.png) · [0.25/5 Drawer](../out/audit/figma-current/24-point-scale-0.25-offset-5-drawer.png)；V：`domain.test.ts` 逆变换/非法值，E：`acceptance-gaps.e2e.ts` 持久化公式与 Footer 可见。 |
| 78 关于与更新 | PASS | [关于页实图](../out/browser-review/expert/17_about_panel.png)；E：`update.e2e.ts` 的 Main 版本/架构/运行形式、正式 Release 查询、下载状态与安装确认。最终包实际自升级/回滚另由清单 98–99 独立判定，不能以本行替代。 |
| 79 模板管理 | PASS | [模板库原稿](../out/audit/figma-reference/62-9.png) · [模板库实图](../out/audit/screenshots/audit-模板-1440.png) · [编辑块](../out/audit/figma-current/07-edit-existing-block-dialog.png)；V：`template-edit.test.tsx` 保存/改名/删除确认，E：`template-edit.e2e.ts` 持久化及引用清理。 |
| 80 默认首从站与显式选择 | PASS | V：[device-selection.test.tsx](../tests/unit/ui/device-selection.test.tsx) 的 `defaults to the first slave only without a selection and preserves an explicit choice across deltas`；[app.ts](../src/renderer/store/app.ts) 是实际选择状态实现。 |

## Responsive / Visual

| 清单行 | 状态 | 本轮可核对证据及边界 |
| --- | --- | --- |
| 84 四种尺寸截图 | PASS | E：`app.e2e.ts` 的 `all main pages fit four window widths`；[7 页面 × 4 尺寸截图](../out/audit/screenshots/)（`audit-设备/实时/趋势/历史/通信/模板/设置-{1440,1280,1279,1024}.png`）。截图存在且为本轮时间；不等于每个 Dialog 都做了四尺寸原稿对照。 |
| 85 侧栏、表格、Drawer、Dialog 细节 | PASS | [Figma 00 自适应](https://www.figma.com/design/dQmLfIDT6zzIjCr4iFC7Cz?node-id=262-2)与[02 自适应组件](https://www.figma.com/design/dQmLfIDT6zzIjCr4iFC7Cz?node-id=263-2)；E：[layout-persistence.e2e.ts](../tests/e2e/layout-persistence.e2e.ts) 三用例分别验证 1024 横/纵滚动时 Header/Point 固定、Drawer/Dialog 内滚且操作按钮可见、鼠标拖动侧栏宽度跨 Electron 会话持久化；[1024 截图](../out/browser-review/current-inspector-1024-scrolled.png)。 |
| 86 公共组件按影响范围审查 | PASS | E：`template-edit.e2e.ts` 与 `full-features.e2e.ts` 的相关状态；Browser Review 的设备对话框、点位抽屉、趋势和通信截图见上。此项为验收方法，不扩展为“全页面视觉完全一致”。 |

## Simulator / Fixtures

| 清单行 | 状态 | 本轮可核对证据及边界 |
| --- | --- | --- |
| 90 Fake Transport 故障/分片能力 | PASS | [FakeTransport](../tests/support/fake.ts) 支持响应 chunks、delay、disconnect；V：`runtime-tcp.test.ts` exception/timeout/late response/transport drop，`framer-streaming.test.ts` 任意 chunks、noise、malformed。 |
| 91 独立模拟器与八功能码 | PASS | [Python PyModbus 模拟器](../tools/simulator/modbus_sim.py)独立于正式 TS Client；V：[simulator-wire.test.ts](../tests/integration/simulator-wire.test.ts) **TCP 7 + RTU 7** 用例在 COM1↔COM2 虚拟串口实际运行，无 RTU skip：八功能码、多 Unit、动态 Float32、FC02 Bool edge、种子 Enum/ASCII String、最新寄存器 RMW、FC06/FC16 写后回读、Scanner/Temporary Read、拒绝/超时结果未知。此证据不覆盖物理 RS485 电气层或所有厂商设备。 |
| 92 独立 Golden 与恢复序列 | PASS | [独立 protocol fixtures](../tests/fixtures/protocol/) + `protocol-golden.test.ts` 的静态 expected bytes；`framer-streaming.test.ts` 的坏帧+好帧、late TCP TID、RTU truncated+good；`scan-rtu.test.ts` 的扫描与普通请求超时后同 Unit/FC 旧帧迟到、后续新帧关联；适用边界同第 16 行。 |

## 更新与自升级

| 清单行 | 状态 | 本轮可核对证据及边界 |
| --- | --- | --- |
| 96 版本/正式 Release/匹配 | PASS | V：[updater.test.ts](../tests/integration/updater.test.ts) 的 draft/prerelease/URL 拒绝、SemVer 不降级、包型匹配；E：[update.e2e.ts](../tests/e2e/update.e2e.ts) 对真实 GitHub Releases API 的本次响应为公开请求限流，核对实际错误提示与重试入口；同包其余测试以可控正式 Release 元数据覆盖成功解析和附件下载。此次不能声称真实 API 查询成功返回最新版本。 |
| 97 Main 下载/校验/取消/并行轮询 | PASS | V：`updater.test.ts` 的 verified bytes、cancel、bad digest；E：`update.e2e.ts` 的下载、跨页取消、校验失败恢复，同时检查事务仍推进。 |
| 98 确认、真实替换与保留数据 | PASS | V：[self-update.test.ts](../tests/integration/self-update.test.ts) 的安装/保留用户文件；[最终包 U](../out/audit/v0.11.1-self-update-final.log)验证 ZIP/Portable/Setup 均经真实按钮、下载校验、helper 安装与重启从 0.11.1 切到隔离生成的 0.11.2，工作区、偏好、历史库和未知用户文件保留。测试新版本未发布至 GitHub。 |
| 99 清单防越界/冲突、失败回滚及特殊路径 | PASS | V：[self-update.test.ts](../tests/integration/self-update.test.ts) 的 traversal、user-file conflict、不可启动回滚；[最终 R](../out/audit/v0.11.1-self-update-rollback-final.log)验证 Setup 安装失败后恢复 0.11.1 与用户数据；[最终 U](../out/audit/v0.11.1-self-update-final.log)覆盖 Portable 外层 EXE 改名、中文/空格目录与选定存储根。 |

## 模板与数据块

| 清单行 | 状态 | 本轮可核对证据及边界 |
| --- | --- | --- |
| 103 树导航与旧编辑态清理 | PASS | V：`template-edit.test.tsx` 的跨模块/跨模板返回；E：`template-edit.e2e.ts` 树形导航。 |
| 104 离线内存布局/分页/新增更新 | PASS | V：`template-edit.test.tsx` 的无 Cache、重叠/后段、跳详情；`template-edit.test.ts` 的寄存器/字节/位/String 宽度；E：`template-edit.e2e.ts` 新增后实时显示与紧凑截图。 |
| 105 Main 保存、改名删除与快照 | PASS | V：`template-edit.test.tsx` 无文件框，`template-edit.test.ts` 的持久化/引用清理、`persistence.test.ts` 的 Schema Snapshot；E：`template-edit.e2e.ts` 保存并读盘。 |
| 106 点位检查器与删除清理 | PASS | V：`template-edit.test.tsx` 的属性直接保存、删除确认，`template-edit.test.ts` 的点位/趋势引用隔离；E：`audit.e2e.ts` 新建/编辑/导出点位。 |

## Final DoD 与未覆盖项

| 清单行 | 状态 | 本轮可核对证据及边界 |
| --- | --- | --- |
| 110 四产物平铺与 Setup | PASS | [final make](../out/audit/v0.11.1-make-final.log)、[final S](../out/audit/v0.11.1-smoke-release-final.log)：目录、ZIP、Portable、Setup 同名 `0.11.1-win-x64`，Setup 自选目录/重装/卸载且留用户数据；[release.test.ts](../tests/unit/release.test.ts) 验证旧版本产物清理只针对命名规则。旧 `release/data/` 的 44 个备份文件已按相对路径和 SHA-256 原样移动至忽略目录 `data/archives/release-root-legacy-2026-09-25/`，`release/` 现仅四产物与 manifest。 |
| 111 四形式真实启动与 Portable 独立复制 | PASS | final S：四形式 Renderer/IPC/serialport/history、Portable 单 EXE 复制到 `Portable 独立运行` 中文空格目录、重启后 history.db 保留、Setup 安装/卸载；[smoke-release.mjs](../tools/smoke-release.mjs) 为执行脚本。 |
| 112 无关键占位 | PASS | 本轮 `rg` 静态检查未发现 `TODO`/`FIXME`/`not implemented`；[transport/index.ts](../src/renderer/transport/index.ts) 的生产构建强制 Preload，Mock 仅开发 Review 可选。UI 文本 placeholder 是正常表单提示，不等于未接线功能。 |
| 113 lint/typecheck/unit/integration/E2E | PASS | 本轮 lint/typecheck 与 `git diff --check` 通过；[final V](../out/audit/v0.11.1-vitest-final.log) **43 文件、344/344**，含实际 COM1↔COM2 RTU；[final E](../out/audit/v0.11.1-e2e-final.log) **9 spec、54/54**，无 skip。首轮 fixture 串扰与双行通信后的旧断言失败均保留审计记录，修复后完整重跑通过。 |
| 114 Production Build/模块加载 | PASS | [final make](../out/audit/v0.11.1-make-final.log)、final S 的打包版启动并初始化 `serialport` 和 `sql.js` 历史库；[forge.config.ts](../forge.config.ts) 与 Vite 配置可核对外置 WASM 和随包依赖。 |
| 115 Smoke 与完整业务回归、失败/跳过记录 | PASS | [最终 S](../out/audit/v0.11.1-smoke-release-final.log)、[E 9 spec/54 项](../out/audit/v0.11.1-e2e-final.log)、[100 万样本 Smoke](../out/audit/v0.11.1-capacity-e2e-visual.log)、[首次使用 Smoke](../out/audit/v0.11.1-empty-first-use.log)、[最终 U](../out/audit/v0.11.1-self-update-final.log)与[最终 R](../out/audit/v0.11.1-self-update-rollback-final.log)均通过；失败用例与其具体修正（fixture 隔离、通信双行后的旧断言、外部 GitHub 限流）见 [审计历史](full-audit.md)，最终 V/E 0 失败、0 跳过。 |

**当前真实边界**：RTU 没有事务 ID，quiet window 之后才到达的同 Unit/FC/同长度旧帧无法无歧义识别；虚拟 COM 验证串口字节链路而非物理 RS485；10 GiB 是提醒阈值，未验证该容量的性能；100 万样本目标虽达标，持续写盘约 0.1 s 对高频轮询的长期抖动未定量验收。Figma 30 屏仅按可见主结构和关键状态判 PASS，未宣称逐像素或辅助技术合规。本次 GitHub 公开 API 返回限流，最终 E2E 证实应用显示错误与重试入口；成功 Release 响应的解析/下载由隔离测试和前一轮真实响应补证，不把此次限流写成查询成功。

最终自升级成功日志末尾有 Windows `EPERM`：仅隔离目录 `out/test-temp/self-update-app-EJ6IIV` 的清理未完成，目录保留且未污染日常配置。此前对同类目录的递归清理被自动审批拒绝，因此未绕过该限制；[审计历史](full-audit.md) 已记载。它不推翻已断言的升级/回滚结果，也不能记成“临时文件清理通过”。本轮 PR 工作流只完成本地等价检查，云端 Actions 未运行；本记录不是 GitHub 发布证明。
