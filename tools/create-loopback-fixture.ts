import fs from 'node:fs';
import path from 'node:path';
import { loopbackWorkspace } from '../tests/support/loopback-workspace';

const root = path.resolve('out/test-temp/loopback-review');
fs.mkdirSync(root, { recursive: true });
const file = path.join(root, 'loopback.workspace.json');
fs.writeFileSync(file, JSON.stringify(loopbackWorkspace({ tcpPort: 15031, transports: process.argv.includes('--tcp-only') ? ['tcp'] : ['tcp', 'rtu'] }), null, 2));
process.stdout.write(`${file}\n`);
