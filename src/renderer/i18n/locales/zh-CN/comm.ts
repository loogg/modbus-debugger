export const comm = {
  resume: '继续显示',
  // Page headers
  title: '通信诊断',
  subtitle: '实时捕获 Modbus 请求 / 响应、超时与异常帧。',
  emptySubtitle: '实时捕获 Modbus 请求 / 响应、超时与异常帧',
  traceSubtitle: '请求 / 响应与设备点位之间可双向追踪。',
  healthTitle: '连接健康 · {{name}}',
  healthSubtitle: '根据实际请求统计总线负载、延迟、超时与异常。',

  // Empty / placeholder states
  emptyNoConnection: '还没有连接。添加连接后这里会显示报文与诊断。',
  healthEmpty: '正在统计连接健康数据，产生请求后这里会显示总线负载、延迟与错误计数。',
  chartEmpty: '还没有健康样本；连接产生请求后这里会显示总线负载与 P95 延迟曲线。',

  // Header actions, toolbar and toasts
  health: '连接健康',
  pause: '暂停',
  pausedToast: '已暂停新报文置顶',
  clear: '清空',
  exportLog: '导出日志',
  exportedToast: '日志已复制到剪贴板',
  searchPlaceholder: '搜索地址 / 功能码 / 点位',
  recent10s: '最近 200 条 ▾',
  onlyErrors: '仅异常',
  autoScroll: '新报文置顶',

  // Transaction table columns
  colTime: '时间',
  colConnection: '连接',
  colSlave: '从站',
  colDirection: '方向',
  colFunctionCode: '功能码',
  colRangeValue: '范围 / 数值',
  colResult: '结果',
  colDuration: '耗时',
  slaveUnit: '从站 {{id}}',

  // Transaction results (RESULT_LABEL map, resolved with t() at render)
  resultOk: '成功',
  sent: '已发送',
  resultException: '异常',
  resultUnexpected: '意外响应',
  resultTimeout: '超时',
  resultCrc: 'CRC 错',
  resultMalformed: '坏帧',
  resultTransport: '传输错误',

  // Frame detail
  frameDetail: '帧详情',
  traceSource: '来源追踪',
  parse: '解析',
  address: '地址',
  exceptionCode: '异常码 0x{{code}} ({{name}})',
  request: '请求',
  response: '响应',
  lastDuration: '最近耗时 {{value}} ms',
  inspectRaw: '检查原始数据',

  // Parse errors / resync (recoveredFrames keeps the leading separator space)
  frameErrors: '帧错误与 Resync',
  discardedBytes: '丢弃 {{bytes}} B',
  recoveredFrames: ' · 恢复 {{frames}} 帧',

  // Health cards
  cardBusLoad: '总线负载',
  cardRequestRate: '请求速率',
  cardAvgLatency: '平均延迟',
  cardTimeouts: '超时',
  cardCrcErrors: 'CRC 错误',
  busLoadHigh: '偏高',
  busLoadOk: '健康',
  recent1min: '最近 1 min',
  recent10min: '最近 10 min',
  p95Value: 'P95 {{value}} ms',

  // Health chart
  busLoadSeries: '总线负载 %',
  p95Series: 'P95 延迟 ms',
  recent5min: '最近 5 分钟',
  chartMeta: '{{samples}} 个采样点 · 1 Hz · 窗口 5 分钟',

  // Block performance table
  blockPerformance: '数据块性能',
  colSlaveBlock: '从站 / 数据块',
  colConfiguredPeriod: '配置周期',
  colActualPeriod: '实际周期',
  colP95: 'P95 延迟',
  colTimeoutRate: '超时率',
  colActions: '操作',
  openTemplate: '打开模板',
  openCommLog: '打开通信日志',

  // Source trace view
  requestSource: '请求来源',
  sourcePoll: '后台轮询',
  sourceWrite: '写请求',
  sourceReadback: '写后回读',
  sourceTemporaryRead: '临时读取',
  sourceScanner: '从站扫描',
  device: '设备',
  block: '数据块',
  relatedPoints: '关联点位',
  pointCount: '{{points}} 个点位',
  openRealtime: '打开实时数据',
  rawFrame: '原始帧',
  writeTrace: '写请求追踪',
  writeTraceHint: 'FC06 / FC16 写请求会记录发起点位；例如地址 6 的 FC06 可直接追踪到「目标转速」并回到实时值。',
} as const;
