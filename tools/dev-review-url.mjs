import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Legacy review drivers share the same authenticated entry; never print its credential. */
export function readReviewUrl(env = process.env) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = env.MODBUS_DEV_BRIDGE_SESSION_FILE ?? path.join(env.MODBUS_DATA_DIR || projectRoot, 'temp', 'dev-bridge-session.json');
  if (!path.isAbsolute(file) || !fs.existsSync(file)) throw new Error('请将 MODBUS_DEV_BRIDGE_SESSION_FILE 指向本机审查会话文件的绝对路径');
  const session = JSON.parse(fs.readFileSync(file, 'utf8'));
  const url = new URL(session.reviewUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.searchParams.get('transport') !== 'bridge' || !new URLSearchParams(url.hash.slice(1)).get('bridgeToken')) {
    throw new Error('审查会话文件无效：必须为含会话凭据的回环 Bridge 页面');
  }
  return url.toString();
}
