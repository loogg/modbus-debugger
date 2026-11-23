import type { CanvasWidget } from '../../../domain/canvas';

export function validateCanvasInput(widget: CanvasWidget, text: string) {
  if (!['number', 'stepper', 'slider'].includes(widget.inputMode)) return;
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value)) throw new Error('请输入有效的有限数值');
  if ((widget.inputMode === 'slider' || widget.limitInput) && (value < widget.min || value > widget.max)) throw new Error(`写入值必须在 ${widget.min}–${widget.max} 范围内`);
}
