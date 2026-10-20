import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createScratch } from '../../tools/test-paths.mjs';
import { readReviewUrl } from '../../tools/dev-review-url.mjs';

it('uses the explicit session file before the data root, and can resolve a data-root session', () => {
  const root=createScratch('review-url-');fs.mkdirSync(path.join(root,'temp'));
  const reviewUrl='http://localhost:5173/?transport=bridge#bridgeToken=test-local-session';
  const file=path.join(root,'temp/dev-bridge-session.json');fs.writeFileSync(file,JSON.stringify({reviewUrl}));
  expect(readReviewUrl({MODBUS_DATA_DIR:root})).toBe(reviewUrl);
  expect(readReviewUrl({MODBUS_DATA_DIR:path.join(root,'unused'),MODBUS_DEV_BRIDGE_SESSION_FILE:file})).toBe(reviewUrl);
});
it.each(['https://outside.invalid/?transport=bridge#bridgeToken=credential','http://localhost:5173/?transport=bridge','http://localhost:5173/?transport=mock#bridgeToken=credential'])('rejects invalid session URL %s',reviewUrl=>{
  const file=path.join(createScratch('review-url-invalid-'),'session.json');fs.writeFileSync(file,JSON.stringify({reviewUrl}));
  expect(()=>readReviewUrl({MODBUS_DEV_BRIDGE_SESSION_FILE:file})).toThrow('会话文件无效');
});
it('fails clearly instead of using an unauthenticated URL when the file is missing',()=>{
  expect(()=>readReviewUrl({MODBUS_DEV_BRIDGE_SESSION_FILE:path.join(createScratch('review-url-missing-'),'missing.json')})).toThrow('MODBUS_DEV_BRIDGE_SESSION_FILE');
});
