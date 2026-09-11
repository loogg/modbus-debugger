const fs = require('fs');
let p = fs.readFileSync('tools/smoke-installer.mjs', 'utf8');
p = p.split("const exe = path.join(installRoot, 'modbus-debugger.exe');\nconst alt = path.join(installRoot, 'modbus-debugger.exe');").join(`const found = findExe(installRoot);
const exe = found ?? path.join(installRoot, 'modbus-debugger.exe');
const alt = exe;`);
p = p.split("const setup = path.resolve(")[0] + `function findExe(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === 'modbus-debugger.exe') return full;
    }
  }
  return null;
}

` + p.split("function findExe(installRoot) {").slice(1).join("function findExe(installRoot) {");
fs.writeFileSync('tools/smoke-installer.mjs', p);
console.log('smoke script improved');