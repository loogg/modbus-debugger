# HistoryStore 容量基准（2026-09-25）

## 目的与复现

验证当前 `sql.js` 记录库随样本数增加的写入、全库导出、重开、会话读取、回放和 CSV 导出成本。当前产品目标容量为 **100 万样本**。脚本为 `tools/bench-history.mjs`，每次在 Git 忽略的 `out/test-temp/history-capacity-*` 下新建独立数据库，不触碰日常用户数据。

```powershell
node --expose-gc node_modules/vite-node/vite-node.mjs tools/bench-history.mjs -- '--rows=100000,500000,1000000' --batch=1000
```

环境：Windows x64，Node.js v24.13.1，`sql.js` v1.14.2；单会话、单信号、每秒一个 Float32 工程值，按 1,000 行提交。`flushMs` 是 `HistoryStore.flush()` 在 Main 线程同步执行的实测时长。RSS 为整个基准进程占用，包含 Vite Node 和 sql.js，不是数据库的独立内存用量。时间会受到机器负载和缓存影响。

| 累计样本 | 数据库文件 | 本段插入 | 同步 flush | flush 后 RSS |
| ---: | ---: | ---: | ---: | ---: |
| 100,000 | 7,606,272 B（7.25 MiB） | 454.5 ms | 6.3 ms | 149 MB |
| 500,000 | 38,141,952 B（36.38 MiB） | 1,643.4 ms | 54.6 ms | 242 MB |
| 1,000,000 | 76,316,672 B（72.78 MiB） | 3,046.2 ms | 99.6 ms | 356 MB |

在 100 万行时，关闭并最终写盘花费 107.2 ms；重开花费 40.3 ms，数据库中 `sample_count` 和读取行数均为 100 万。单次完整读取在优化前为 2,276.4 ms、读取后 RSS 494 MB；优化 `readSamples` 后为 846.5 ms、读取后 RSS 443 MB。两次是独立进程运行，不应将其差值解释为稳定的跨机器性能保证。原始 JSON 留在 `out/test-temp/history-capacity-PA2F0X/result.json`（修改前）和 `out/test-temp/history-capacity-urRNeo/result.json`（修改后）。

## 对扩展的影响

1. 约 73 MiB 文件就使单次全库导出阻塞 Main 线程约 0.1 秒。`HistoryStore` 在脏数据产生后约一秒同步导出整个 SQLite 数据库。现有“超过 10 GB 提醒”只是归档提示，**不是 10 GB 可用容量的验证**；本基准没有测试 GB 级数据库，也不能直接线性外推极限。
2. `history.sessionData` 一次性将会话的全部样本、事件和原始通信数据经 IPC 返回。服务层的全量读取已优化；图表只消费保留每个连续样本段极值的最多约 5,000 个点，游标仍查完整原始样本。IPC 仍会搬运 100 万行；不能把图表降采样误作持久化数据减少。
3. 目标容量下，单次同步 `flush()` 仍阻塞 Main 约 0.1 秒。如果设备轮询周期为 100 ms，这可能造成调度抖动；本轮没有测量真实设备长时间记录时的轮询截止时间。是否改为增量落盘应依据这一实际抖动测量决定，不以 10 GB 提醒阈值推断。

## 本次处理与验证

`readSamples` 改为从 sql.js prepared statement 逐行构造返回数组，保持原有查询顺序和按信号筛选语义，减少了一份中间对象数组。集成测试覆盖持久化重开、时间排序、按信号筛选；本轮完整 Vitest 为 42 文件、340 项通过。此项没有改变样本格式或 IPC 契约；总任务的应用版本已按 SemVer 同步递增。

## 100 万样本的读取、回放与导出（2026-09-25 增补）

使用相同的单信号、1 Hz、100 万行数据，数据库约 76.32 MB。以下主结果来自 `out/test-temp/history-capacity-6huoag/result.json`。`history.sessionData` 是真实的 `RuntimeManager.handleCommand` 路径；`structuredClone` 是同进程 V8 克隆，**只是 Electron IPC 载荷的代理**，不含跨进程传送时间。Renderer 算法调用与产品相同的纯函数，但不含 React 布局或 ECharts 绘制。RSS 包含同一基准进程内的 sql.js、Main 响应、克隆载荷及 Renderer 模拟数据，因此不是某个单独进程的内存。

| 阶段 | 100 万样本实测 | 范围 |
| --- | ---: | --- |
| Main `history.sessionData` | 1,313 ms；结束时 RSS 542 MB | 会话详情、100 万样本、事件及 Raw 读取；本负载后两者为空 |
| V8 `structuredClone` | 888 ms；结束时 RSS 608 MB | IPC 序列化代理，不是 Electron 实际 IPC |
| 图表数据准备 | 76 ms；100 万行压为 4,990 图表点 | 保留首末点及每段最小/最大值；原始样本未删 |
| 回放游标 0/25/50/75/100% | 0.2–0.9 ms/次 | 图表裁剪和对完整原始样本的精确二分查找；不含 ECharts 绘制 |
| CSV 内容组装 | 443 ms；27,888,904 B；结束时 RSS 721 MB | 与 UI 相同的全量内容及转义，分块构造；不含系统剪贴板写入 |
| 将 CSV 字符串写入本地测试文件 | 26 ms | 只作输出端 I/O 参考，不能代替剪贴板验收 |

优化前同负载的独立运行 `out/test-temp/history-capacity-ZoyERd/result.json` 中，图表输入为 100 万点，游标算法每次 50–72 ms，CSV 后 RSS 约 981 MB。现在图表输入为 4,990 点、游标计算不足 1 ms；分块 CSV 构造后的同进程 RSS 为 721 MB。运行间系统负载不同，这些数值说明量级和内存路径，不是严格的同机性能承诺。原始 CSV 与原始样本内容保持不变，极值保留与精确游标有 [history-data.test.ts](../tests/unit/history-data.test.ts) 覆盖。

另外在 **Browser Review Mode 的真实 Chrome 界面**中，将 100 万条同样形状的样本直接注入 Mock 会话：历史图表可绘制、回放打开、鼠标拖动到中点后显示正确工程值；无 `pageerror`。该次浏览器内数据创建后到图表出现为 336 ms，回放点击到游标区出现为 48 ms；Renderer JS heap 约 142–147 MB。截图在 `out/test-temp/history-capacity-browser-1m.png` 和 `out/test-temp/history-capacity-browser-replay-1m.png`。这些时间**不含 sql.js、Main、Electron IPC 或系统剪贴板**。

为补齐正式交付路径，新增 opt-in `wdio.capacity.conf.ts` 和 `tests/capacity/history-capacity.e2e.ts`：它在独立 `out/test-temp` 根目录预置真实 100 万样本数据库，然后在打包版通过真实界面打开会话、点击回放和滑块、导出并检查 Electron 剪贴板。普通 `tests/e2e/**/*.e2e.ts` 不包含此 spec。运行前先按当前源码 `npm run package`，然后串行执行：

```powershell
npx wdio run wdio.capacity.conf.ts
```

**打包版全链路结果：PASS。** [最终日志](../out/audit/v0.11.1-capacity-e2e-visual.log)与[指标 JSON](../out/audit/capacity-1m-smoke.json)记录 100 万样本会话打开 4,698 ms、回放启动 98 ms、滑块游标及曲线重绘 300 ms、完整 CSV 写入系统剪贴板 753 ms；剪贴板读回 1,000,000 行、28,888,904 字符（Windows CRLF），首末行正确。测试检查真实 Electron IPC、图表 Canvas 中约 99,493 个蓝色曲线像素、回放确认值和 CSV；均满足 [验收预算](acceptance.md) 的 30 秒/5 秒上限。测试结束时 Renderer JS heap 约 154 MB、Main RSS 约 405 MB，属于瞬时快照，不是峰值保证。数据库持续增长时的 Main 同步写盘约 0.1 秒，长时间高频轮询抖动尚未定量验收；10 GB 仍只代表提醒阈值。
