export const history = {
  // Page headers, empty state and session meta
  title: '历史',
  subtitle: '回放主动记录的会话',
  empty: '还没有记录会话。在趋势模块选择趋势组后点击“开始记录”。',
  headerSubtitle: '{{start}} – {{end}} · {{n}} 个信号',
  replayTitle: '{{name}} · 空载测试',
  replaySubtitle: '离线回放 · {{time}}',
  sessionStartedAt: '会话开始于 {{time}}',

  // Actions and toasts
  backToHistory: '返回历史',
  replay: '回放',
  addNote: '添加备注',
  noteToast: '备注功能：会话备注保存在 history.db',
  exportCsv: '导出 CSV',
  csvToast: 'CSV 已复制到剪贴板',

  // Replay controls
  pause: '暂停',
  play: '▶ 播放',
  speed: '速度',
  prevEvent: '上一事件',
  nextEvent: '下一事件',
  cursorData: '游标时刻数据',
  eventsAndComm: '事件与通信',
  rawCommCount: '原始通信 {{n}} 条已记录',
  offlineNoDevice: '离线 · 不需要设备连接',
  rawCommRecorded: '此会话已记录原始通信',
  rawCommNotRecorded: '此会话未记录原始通信',

  // Tabs
  tabTrend: '趋势',
  tabEvents: '状态与事件',
  tabData: '数据',
  tabSignals: '信号',

  // Trend tab
  axisNote: '纵轴：按单位独立',
  rangeAll: '时间范围：全部',
  sessionInfo: '会话信息与事件',
  recordedPoints: '记录点位',
  sampleCount: '采样数',
  storage: '存储',
  eventCount: '事件数',

  // Signals tab
  recordedSignals: '记录信号',
  recordedSignalsHint: '开始记录时冻结的信号与编码配置（Schema Snapshot，模板后续修改不影响本会话）',

  // Table columns
  colSignal: '信号',
  colType: '类型',
  colSource: '来源',
  colRecordMode: '记录方式',
  colTime: '时间',
  colContent: '内容',
  colResult: '结果',
  colValue: '值',
  colUnit: '单位',
  modeSamples: '连续样本',
  modeEvents: '初始值 + 变化',
  writeOk: '成功',

  // Event kinds (kindLabel map, resolved with t() at render)
  kindWrite: '写入',
  kindConnection: '连接',
} as const;