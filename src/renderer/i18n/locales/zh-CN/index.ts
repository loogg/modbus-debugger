import { about } from './about';
import { shell } from './shell';
import { devices } from './devices';
import { overlays } from './overlays';
import { realtime } from './realtime';
import { trend } from './trend';
import { comm } from './comm';
import { history } from './history';
import { templates } from './templates';
import { settings } from './settings';
import { ui } from './ui';

/**
 * zh-CN is the only locale wired today. Adding a language = adding a sibling dictionary
 * with the same shape and registering it in src/renderer/i18n/index.ts; the TypeScript
 * resource typing makes missing keys a compile error.
 */
export const zhCN = { shell, devices, overlays, realtime, trend, comm, history, templates, settings, ui, about };
