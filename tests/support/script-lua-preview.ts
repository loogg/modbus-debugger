import { $, browser } from '@wdio/globals';

/** Read the rendered code without the line-number gutter, preserving indentation. */
export async function readScriptLua() {
  const view = $('.workbench-view:not([style*="display: none"])');
  if (!await view.$('[aria-label="脚本检查器"]').isDisplayed()) await view.$('button=Lua / 变量').click();
  const codeTab = view.$('[role="tablist"][aria-label="检查内容"]').$('button*=Lua');
  if (await codeTab.getAttribute('aria-selected') !== 'true') await codeTab.click();
  await view.$('[aria-label="生成的 Lua"] code').waitForDisplayed();
  return browser.execute(() => Array.from(document.querySelectorAll('.workbench-view:not([style*="display: none"]) .script-lua-line code'),
    line => line.textContent).join('\n'));
}
