import { $, $$, browser, expect } from '@wdio/globals';
import type {} from 'webdriverio';

export const activeView = () => $('.workbench-view:not([style*="display: none"])');

/** Workbench tabs keep their DOM while hidden. Portalled controls can also live outside the active view. */
export function visibleControl(selector: string) {
  return browser.waitUntil(async () => {
    for (const element of await $$(selector)) if (await element.isDisplayed()) return element;
    return false;
  }, { timeoutMsg: 'Visible control not found: ' + selector });
}

export async function submitRealtimeValue(value: string) {
  const input = await visibleControl('input.w-24');
  await input.click();
  // Use keyboard input events so the React draft receives the replacement.
  await browser.keys(['Control', 'a']);
  await browser.keys('Backspace');
  if (value) await input.addValue(value);
  await expect(input).toHaveValue(value);
  await browser.keys('Enter');
}
