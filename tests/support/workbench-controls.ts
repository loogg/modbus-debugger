import { $, $$, browser } from '@wdio/globals';
import type {} from 'webdriverio';

export const activeView = () => $('.workbench-view:not([style*="display: none"])');

/** Workbench tabs keep their DOM while hidden. Portalled controls can also live outside the active view. */
export function visibleControl(selector: string) {
  return browser.waitUntil(async () => {
    for (const element of await $$(selector)) if (await element.isDisplayed()) return element;
    return false;
  }, { timeoutMsg: 'Visible control not found: ' + selector });
}
