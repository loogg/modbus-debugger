const fs = require('fs');
const p = 'tests/integration/simulator-tcp.test.ts';
let c = fs.readFileSync(p, 'utf8');
const old = `      const key = blockKey('s1', 'hb');
      const start = Date.now();
      while (cache.get(key)?.status !== 'ok' && Date.now() - start < 8000) await new Promise((r) => setTimeout(r, 50));
      expect(cache.get(key)?.status).toBe('ok');

      const memory = cache.get(key)?.memory;
      expect(memory?.kind).toBe('registers');
      if (memory?.kind === 'registers') {
        const volts = decodeRaw(memory, { rawType: 'Float32', offset: 0, registerCount: 2, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' });
        expect(Number(volts)).toBeGreaterThan(40);
        expect(Number(volts)).toBeLessThan(56);
      }`;
const neu = `      const key = blockKey('s1', 'hb');
      const floatMapping = { rawType: 'Float32', offset: 0, registerCount: 2, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' } as const;
      const start = Date.now();
      let volts = 0;
      while (Date.now() - start < 10000) {
        const memory = cache.get(key)?.memory;
        if (memory?.kind === 'registers') volts = Number(decodeRaw(memory, floatMapping));
        if (cache.get(key)?.status === 'ok' && volts > 40 && volts < 56) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(cache.get(key)?.status).toBe('ok');
      expect(volts).toBeGreaterThan(40);
      expect(volts).toBeLessThan(56);`;
if (!c.includes(old)) { console.log('MISS'); process.exit(1); }
fs.writeFileSync(p, c.split(old).join(neu));
console.log('ok');