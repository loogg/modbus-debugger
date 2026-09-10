const fs = require('fs');
const p = 'tools/simulator/modbus_sim.py';
let c = fs.readFileSync(p, 'utf8');
const oldRun = c.slice(c.indexOf('    def run(self) -> None:'), c.indexOf('def main() -> None:'));
const newRun = `    def run(self) -> None:
        import asyncio

        loop = asyncio.new_event_loop()

        async def setv(unit: int, fc: int, addr: int, values) -> None:
            await self.context.async_setValues(unit, fc, addr, values)

        async def getv(unit: int, fc: int, addr: int, count: int):
            return await self.context.async_getValues(unit, fc, addr, count)

        while not self.stop.is_set():
            self.tick += 1
            t = time.monotonic() - self.t0
            for unit in self.units:
                hi, lo = float_to_words(48.2 + math.sin(t / 3.0) * 0.4 + random.uniform(-0.02, 0.02))
                loop.run_until_complete(setv(unit, 3, 0, [hi, lo]))
                hi, lo = float_to_words(1.2 + math.sin(t / 1.7) * 0.25)
                loop.run_until_complete(setv(unit, 3, 2, [hi, lo]))
                word = 0x0037
                if int(t) % 4 < 2:
                    word |= 0x0010
                loop.run_until_complete(setv(unit, 3, 4, [word]))
                current = loop.run_until_complete(getv(unit, 3, 6, 1))
                if isinstance(current, list) and (current[0] == 0 or current[0] == 1):
                    loop.run_until_complete(setv(unit, 3, 6, [1500]))
                text = f"V2.4.{int(t) % 3}"
                padded = text.ljust(8, "\\x00")
                words = []
                for i in range(0, 8, 2):
                    words.append((ord(padded[i]) << 8) | ord(padded[i + 1]))
                loop.run_until_complete(setv(unit, 3, 8, words[:4]))
                hi, lo = float_to_words(42.0 + math.sin(t / 5.0) * 1.5)
                loop.run_until_complete(setv(unit, 4, 0, [hi, lo]))
                hi, lo = float_to_words(48.1 + math.cos(t / 4.0) * 0.3)
                loop.run_until_complete(setv(unit, 4, 2, [hi, lo]))
                loop.run_until_complete(setv(unit, 1, 4, [(int(t) % 5) < 3]))
                loop.run_until_complete(setv(unit, 2, 0, [(int(t) % 2) == 0]))
            time.sleep(0.2)
        loop.close()


`;
c = c.split(oldRun).join(newRun);
fs.writeFileSync(p, c);
console.log('ok');