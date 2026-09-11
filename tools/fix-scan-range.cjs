const fs = require('fs');
const p = 'tests/e2e/app.e2e.ts';
let s = fs.readFileSync(p, 'utf8');
const q = String.fromCharCode(39);
const dq = String.fromCharCode(34);
const oldSel = '//div[text()=' + dq + '结束 Unit' + dq + ']/following-sibling::input';
s = s.split(oldSel + ').setValue(' + q + '3' + q + ');').join(oldSel + ').setValue(' + q + '20' + q + ');');
fs.writeFileSync(p, s);
console.log('bounded:', s.includes(oldSel + ').setValue(' + q + '20' + q + ');'));