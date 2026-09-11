export const ui = {
  /** Rendered by the non-component helper `slaveStatus` through the i18n singleton. */
  slaveStatus: {
    disabled: '停用',
    online: '在线',
    connecting: '连接中',
    error: '连接异常',
    offline: '离线',
  },
  moreActions: '更多操作',
  expandOptions: '展开选项',
  /** ValueCell shares this fragment; the cell always shows the confirmed device value. */
  valueCell: {
    invalidEnum: '无效枚举值',
    invalidNumber: '无效数值',
    rejectedTitle: '设备拒绝（异常码 {{code}}），保留旧值',
    unknownTitle: '写结果未知，正在回读确认',
    doubleClickEdit: '双击编辑',
  },
} as const;
