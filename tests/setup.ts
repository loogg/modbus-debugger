// Vitest global setup: keep console noise minimal and provide DOM matchers for UI tests.
import '@testing-library/jest-dom/vitest';
import { afterAll } from 'vitest';
import { cleanupScratch, setupTestEnvironment } from '../tools/test-paths.mjs';

setupTestEnvironment();

// jsdom has no layout/scroll engine; actual tab scrolling is covered in Browser Review.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: () => {} });
}

// jsdom has no native top layer. nwsapi's native-state fallback otherwise calls
// jsdom.matches again for these selectors, recursing while Radix/aria-hidden update.
if (typeof Element !== 'undefined' && navigator.userAgent.includes('jsdom')) {
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    if (selector === ':modal' || selector === ':fullscreen') return false;
    return matches.call(this, selector);
  };
}
afterAll(cleanupScratch);
