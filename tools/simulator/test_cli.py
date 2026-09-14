"""CLI validation only; real Modbus wire checks live in tests/integration/simulator-wire.test.ts."""
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('modbus_sim.py')
class SimulatorCli(unittest.TestCase):
    def test_help_documents_ports_and_functions(self):
        result = subprocess.run([sys.executable, str(SCRIPT), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        for flag in ['--serial-port', '--transport', '--host', '--port', '--units', '--fault', '--static']:
            self.assertIn(flag, result.stdout)
    def test_invalid_configuration_never_starts(self):
        cases = [(['--transport','rtu'], '--serial-port is required'),
                 (['--serial-port','COM1'], 'only valid for RTU'),
                 (['--port','0'], '1..65535'),
                 (['--units','1,1'], 'unique'),
                 (['--units','0'], '1'),
                 (['--units','248'], '247'),
                 (['--fault','bad-crc'], 'requires RTU'),
                 (['--transport','rtu','--serial-port','PORT_FROM_CLI','--fault','malformed'], 'TCP'),
                 (['--bytesize','7'], 'invalid choice')]
        for args, expected in cases:
            with self.subTest(args=args):
                result = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 2)
                self.assertIn(expected, result.stderr)
                self.assertNotIn('"event": "ready"', result.stdout)
if __name__ == '__main__': unittest.main()
