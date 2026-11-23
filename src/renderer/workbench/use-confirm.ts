import { useCallback } from 'react';
import { useApp } from '../store/app';

/** App-owned confirmation works in both Browser Review and detached documents. */
export function useConfirm() {
  const open = useApp(s => s.openOverlay);
  return useCallback((message: string, confirmLabel = '丢弃并继续', title = '未提交的编辑') => new Promise<boolean>(resolve => {
    open({ kind: 'dialog', id: 'confirm', title, message, confirmLabel, danger: true, onConfirm: () => resolve(true), onCancel: () => resolve(false) });
  }), [open]);
}
