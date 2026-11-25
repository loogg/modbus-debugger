import * as Blockly from 'blockly/core';
import { scriptToolbox, searchPalette, variableCategoryKey, variablePalette } from './block-palette';

export interface PaletteState { category: number; open: boolean }

/** The flyout participates in Blockly's workspace, scrollbar and drag metrics. */
class DockedFlyout extends Blockly.VerticalFlyout {
  override readonly CORNER_RADIUS = 6;
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
  private names: readonly string[] = [];
  private query = '';
  private restoreCollapsed = false;
  private clearQuery?: () => void;

  protected override createFlyout_() {
    const options = this.workspace_.copyOptionsForFlyout();
    options.toolboxPosition = this.workspace_.options.toolboxPosition;
    return new DockedFlyout(options);
  }

  start(preference: PaletteState | undefined, clearQuery: () => void) {
    if (preference) this.preference = preference;
    this.clearQuery = clearQuery;
    this.workspace_.registerToolboxCategoryCallback(variableCategoryKey, () => variablePalette(this.names));
    const flyout = this.getFlyout();
    if (flyout instanceof DockedFlyout) flyout.setAutoClose(false);
    this.getToolboxItems().forEach((item, index) => {
      const row = item.getDiv() as HTMLElement | null;
      const category = scriptToolbox.contents[index];
      if (row && category) row.style.setProperty('--category-colour', category.colour);
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
    const wasSearching = !!this.query;
    if (wasSearching) {
      this.query = '';
      this.HtmlDiv?.classList.remove('script-searching');
      this.clearQuery?.();
    }
    if (item === this.getSelectedItem()) {
      if (wasSearching) this.refreshSelection();
      return;
    }
    super.setSelectedItem(item);
    this.preference.open = !!this.getSelectedItem();
    if (item) this.preference.category = this.getToolboxItems().indexOf(item);
    this.updateToggle();
    this.revealSelectedCategory();
    this.workspace_.resize();
    this.workspace_.scroll(this.workspace_.scrollX, this.workspace_.scrollY);
  }

  updatePalette(query: string, names: readonly string[]) {
    const namesChanged = names.length !== this.names.length || names.some((name, i) => name !== this.names[i]);
    this.names = names;
    const term = query.trim();
    if (term === this.query) {
      if (namesChanged && (term || this.getSelectedItem()?.getContents() === variableCategoryKey)) this.refreshSelection();
      return;
    }
    if (term && !this.query) {
      this.restoreCollapsed = !this.getSelectedItem();
      if (this.restoreCollapsed) this.selectItemByPosition(this.preference.category);
    }
    this.query = term;
    this.HtmlDiv?.classList.toggle('script-searching', !!term);
    if (!term && this.restoreCollapsed) this.clearSelection();
    else this.refreshSelection();
    this.getFlyout()?.scrollToStart();
    this.workspace_.resize();
  }

  override refreshSelection() {
    if (this.query) this.getFlyout()?.show(searchPalette(this.query, this.names));
    else super.refreshSelection();
  }

  revealSelectedCategory() {
    const row = this.getSelectedItem()?.getDiv();
    const group = row?.closest<HTMLElement>('.blocklyToolboxCategoryGroup');
    if (!row || !group || !group.clientHeight) return;
    const item = row.getBoundingClientRect();
    const list = group.getBoundingClientRect();
    if (item.top < list.top) group.scrollTop += item.top - list.top;
    else if (item.bottom > list.bottom) group.scrollTop += item.bottom - list.bottom;
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
