const fs = require('fs');
const L = fs.readFileSync('src/renderer/components/ui.tsx', 'utf8').split(/\r?\n/);
const a = L.findIndex((l) => l.includes('export function Field'));
L.slice(a, a + 12).forEach((l, i) => console.log((a + 1 + i) + ': ' + l));
