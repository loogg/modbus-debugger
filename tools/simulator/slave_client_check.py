"""Independent PyModbus master used to verify this application's real slave runtime."""
import argparse
import serial
import struct
from pymodbus.client import ModbusTcpClient, ModbusSerialClient


def check(client):
    assert client.connect(), "master connection failed"
    try:
        def ok(response):
            assert not response.isError(), str(response)
            return response
        ok(client.write_coil(0, True, device_id=1))
        assert ok(client.read_coils(0, count=1, device_id=1)).bits[0]
        assert ok(client.read_discrete_inputs(0, count=1, device_id=1)).bits[0]
        ok(client.write_register(0, 1234, device_id=1))
        assert ok(client.read_holding_registers(0, count=1, device_id=1)).registers == [1234]
        assert ok(client.read_input_registers(0, count=1, device_id=1)).registers == [456]
        coils = [True, False, True, True, False, False, True, False, True]
        ok(client.write_coils(1, coils, device_id=1))
        assert ok(client.read_coils(1, count=9, device_id=1)).bits[:9] == coils
        ok(client.write_registers(1, [0x1234, 0xABCD], device_id=1))
        assert ok(client.read_holding_registers(0, count=3, device_id=1)).registers == [1234, 0x1234, 0xABCD]
        assert ok(client.read_holding_registers(0, count=1, device_id=2)).registers == [0]
        rejected = client.read_holding_registers(65535, count=2, device_id=1)
        assert rejected.isError() and rejected.exception_code == 2, str(rejected)
        print("SLAVE_INTEROP_OK FC01/02/03/04/05/06/15/16 multi-unit exception02", flush=True)
    finally:
        client.close()


def broadcast_check(port):
    def adu(unit, pdu):
        data = bytes([unit]) + pdu
        crc = 0xFFFF
        for byte in data:
            crc ^= byte
            for _ in range(8):
                crc = ((crc >> 1) ^ 0xA001) if crc & 1 else crc >> 1
        return data + struct.pack('<H', crc)
    with serial.Serial(port, 19200, timeout=0.25) as wire:
        wire.reset_input_buffer()
        wire.write(adu(0, bytes.fromhex('060000002a')))
        assert wire.read(256) == b'', 'RTU broadcast must not receive a reply'
        for unit in [1, 2]:
            wire.write(adu(unit, bytes.fromhex('0300000001')))
            assert wire.read(7) == adu(unit, bytes.fromhex('0302002a')), 'Broadcast must update each enabled Unit'
        request = adu(1, bytes.fromhex('0300000001'))
        corrupted = request[:-1] + bytes([request[-1] ^ 0xFF])
        wire.write(corrupted + request[:3])
        wire.write(request[3:])
        assert wire.read(7) == adu(1, bytes.fromhex('0302002a')), 'Bad CRC must not lose the next fragmented request'
        wire.write(adu(0, bytes.fromhex('0300000001')))
        assert wire.read(256) == b'', 'Broadcast reads must not receive a reply'
        print('RTU_BROADCAST_OK RTU_RECOVERY_OK', flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=15020)
    parser.add_argument("--serial")
    parser.add_argument("--broadcast-check", action="store_true")
    args = parser.parse_args()
    check(ModbusSerialClient(args.serial, baudrate=19200, parity="N", stopbits=1, bytesize=8, timeout=1, retries=0)
          if args.serial else ModbusTcpClient(args.host, port=args.port, timeout=2, retries=0))
    if args.serial and args.broadcast_check:
        broadcast_check(args.serial)
