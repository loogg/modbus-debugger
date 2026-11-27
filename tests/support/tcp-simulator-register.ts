import { execFileSync } from 'node:child_process';

export function simulatorRegister(restore?: number): number {
  // A separate client reads the disposable simulator's holding register over TCP.
  const source = [
    'import sys',
    'from pymodbus.client import ModbusTcpClient',
    'with ModbusTcpClient("127.0.0.1", port=50520, timeout=2) as client:',
    '    if len(sys.argv) > 1:',
    '        result = client.write_register(6, int(sys.argv[1]), device_id=1)',
    '        assert not result.isError(), result',
    '    result = client.read_holding_registers(6, count=1, device_id=1)',
    '    assert not result.isError(), result',
    '    print(result.registers[0])',
  ].join('\n');
  return Number(execFileSync('python', ['-c', source, ...(restore === undefined ? [] : [String(restore)])], { encoding: 'utf8', timeout: 6000 }).trim());
}
