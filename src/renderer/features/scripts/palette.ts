import * as Blockly from 'blockly/core';

export interface PaletteState { category: number; open: boolean }

/** The flyout participates in Blockly's workspace, scrollbar and drag metrics. */
class DockedFlyout extends Blockly.VerticalFlyout {
  override readonly CORNER_RADIUS = 2;
  override getFlyoutScale() { return 0.95; }
  override createBlock(original: Blockly.BlockSvg): Blockly.BlockSvg {
    const copy = super.createBlock(original);
    // Hit testing uses the connector positions recorded before the drag starts.
    Blockly.renderManagement.triggerQueuedRenders(copy.workspace);
    return copy;
  }
  override getWidth(): number {
    const natural = super.getWidth();
    if (!natural || !this.isVisible()) return 0;
    return Math.max(natural, 244);
  }
}

export class ScriptToolbox extends Blockly.Toolbox {
  private preference: PaletteState = { category: 0, open: true };
  private toggle: HTMLButtonElement | null = null;

  protected override createFlyout_() {
    const options = this.workspace_.copyOptionsForFlyout();
    options.toolboxPosition = this.workspace_.options.toolboxPosition;
    return new DockedFlyout(options);
  }

  start(preference: PaletteState | undefined, colours: string[]) {
    if (preference) this.preference = preference;
    const flyout = this.getFlyout();
    if (flyout instanceof DockedFlyout) flyout.setAutoClose(false);
    this.getToolboxItems().forEach((item, index) => {
      const row = item.getDiv() as HTMLElement | null;
      if (row && colours[index]) row.style.setProperty('--category-colour', colours[index]);
    });
    const rail = this.HtmlDiv!;
    const toggle = rail.ownerDocument.createElement('button');
    toggle.type = 'button';
    toggle.className = 'script-palette-toggle';
    const pane = rail.parentElement?.querySelector('.blocklyToolboxFlyout');
    if (pane) {
      pane.id = rail.id + '-palette';
      toggle.setAttribute('aria-controls', pane.id);
    }
    toggle.addEventListener('pointerdown', event => event.stopPropagation());
    toggle.addEventListener('click', () => {
      if (this.getSelectedItem()) this.clearSelection();
      else this.selectItemByPosition(this.preference.category);
    });
    rail.appendChild(toggle);
    this.toggle = toggle;
    if (this.preference.open) this.selectItemByPosition(this.preference.category);
    this.updateToggle();
  }

  override setSelectedItem(item: Parameters<Blockly.Toolbox['setSelectedItem']>[0]): void {
    if (item === this.getSelectedItem()) return;
    super.setSelectedItem(item);
    this.preference.open = !!this.getSelectedItem();
    if (item) this.preference.category = this.getToolboxItems().indexOf(item);
    this.updateToggle();
    this.workspace_.resize();
    this.workspace_.scroll(this.workspace_.scrollX, this.workspace_.scrollY);
  }

  private updateToggle() {
    if (!this.toggle) return;
    const open = this.preference.open;
    this.toggle.textContent = open ? '收起' : '展开';
    this.toggle.title = open ? '收起积木托盘' : '展开积木托盘';
    this.toggle.setAttribute('aria-label', this.toggle.title);
    this.toggle.setAttribute('aria-expanded', String(open));
  }
}
