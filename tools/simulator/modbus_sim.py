"""Independent TCP/RTU slave simulator for FC01/02/03/04/05/06/15/16.

No COM number is implicit: --transport rtu requires --serial-port.
Use --static for deterministic register/coil write/read-back tests.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import suppress
import json
import math
import struct
import sys
import time

from pymodbus.datastore import ModbusDeviceContext, ModbusSequentialDataBlock, ModbusServerContext
from pymodbus.pdu import ExceptionResponse
from pymodbus.exceptions import NoSuchIdException
from pymodbus.server import ModbusSerialServer, ModbusTcpServer


def float_to_words(value: float) -> tuple[int, int]:
    return struct.unpack('>HH', struct.pack('>f', value))


def build_context(units: list[int], registers: int = 128, bits: int = 2048) -> ModbusServerContext:
    devices = {}
    for unit in units:
        holding = [0] * registers
        holding[0:2] = float_to_words(48.2)
        holding[2:4] = float_to_words(1.2)
        holding[4] = 0x0011  # enable=1, mode=1; writes to shared control bits remain intact
        holding[6] = 1500
        holding[8:12] = struct.unpack('>HHHH', b'V2.4.0\0\0')
        inputs = [0] * registers
        inputs[0:2] = float_to_words(42.0)
        inputs[2:4] = float_to_words(48.1)
        devices[unit] = ModbusDeviceContext(
            di=ModbusSequentialDataBlock(1, [False] * bits),
            co=ModbusSequentialDataBlock(1, [False] * bits),
            hr=ModbusSequentialDataBlock(1, holding),
            ir=ModbusSequentialDataBlock(1, inputs),
        )
    return ModbusServerContext(devices=devices, single=False)


class Faults:
    """Faults wrap individual decoded requests; the protocol codec stays PyModbus's."""

    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.used = 0
        self.outgoing = 'none'

    def trace_pdu(self, sending, pdu):
        if sending:
            self.outgoing = getattr(pdu, '_sim_fault', 'none')
            return pdu
        args = self.args
        if pdu.dev_id not in args.units and not (args.transport == 'rtu' and args.broadcast and pdu.dev_id == 0):
            async def missing_device(_context, _device_id):
                raise NoSuchIdException('unit is not configured in this simulator')
            # PyModbus 3.15 SimCore otherwise raises KeyError -> exception 04, bypassing ignore_missing_devices.
            pdu.datastore_update = missing_device
            return pdu
        matches = (args.fault_unit is None or pdu.dev_id == args.fault_unit) and (
            args.fault_fc is None or pdu.function_code == args.fault_fc
        )
        if args.fault == 'none' or not matches or (args.fault_count and self.used >= args.fault_count):
            return pdu
        self.used += 1
        if args.trace:
            print(json.dumps({'event': 'FAULT', 'fault': args.fault, 'unit': pdu.dev_id, 'fc': pdu.function_code, 'at': time.monotonic()}), flush=True)
        original = pdu.datastore_update

        async def update(context, device_id):
            if args.fault == 'exception':
                return ExceptionResponse(pdu.function_code, args.exception_code)
            if args.fault == 'delay':
                deadline = time.perf_counter() + args.delay_ms / 1000
                # Windows asyncio may wake early at its coarse monotonic clock resolution.
                while (remaining := deadline - time.perf_counter()) > 0:
                    await asyncio.sleep(max(.001, remaining))
            response = await original(context, device_id)
            response._sim_fault = args.fault
            return response

        pdu.datastore_update = update
        return pdu

    def trace_packet(self, sending: bool, packet: bytes) -> bytes:
        label = 'TX' if sending else 'RX'
        if sending:
            mode, self.outgoing = self.outgoing, 'none'
            if mode == 'timeout':
                label, packet = 'DROP_TX', b''  # command may already have executed, including writes
            elif mode == 'bad-crc' and packet:
                packet = packet[:-1] + bytes([packet[-1] ^ 1])
            elif mode == 'malformed' and len(packet) >= 4:
                packet = packet[:2] + b'\xff\xff' + packet[4:]
        if self.args.trace:
            print(json.dumps({'event': label, 'hex': packet.hex(), 'at': time.monotonic()}, ensure_ascii=False), flush=True)
        return packet


async def dynamics(server, units: list[int]) -> None:
    t0 = time.monotonic()
    while True:
        t = time.monotonic() - t0
        for unit in units:
            await server.async_setValues(unit, 3, 0, list(float_to_words(48.2 + math.sin(t / 3) * .4)))
            await server.async_setValues(unit, 3, 2, list(float_to_words(1.2 + math.sin(t / 1.7) * .25)))
            await server.async_setValues(unit, 4, 0, list(float_to_words(42 + math.sin(t / 5) * 1.5)))
            await server.async_setValues(unit, 4, 2, list(float_to_words(48.1 + math.cos(t / 4) * .3)))
            await server.async_setValues(unit, 2, 0, [(int(t) % 2) == 0])
        # Never overwrite control register 4, writable speed 6, strings or coils after a user write.
        await asyncio.sleep(.2)


def ranged_int(low: int, high: int):
    def parse(text: str) -> int:
        try:
            value = int(text, 0)
        except ValueError as error:
            raise argparse.ArgumentTypeError('expected an integer') from error
        if not low <= value <= high:
            raise argparse.ArgumentTypeError(f'expected {low}..{high}')
        return value
    return parse


def parse_units(text: str) -> list[int]:
    try:
        values = [int(item.strip()) for item in text.split(',')]
    except ValueError as error:
        raise argparse.ArgumentTypeError('units must be comma-separated integers') from error
    if not values or any(not 1 <= unit <= 247 for unit in values) or len(values) != len(set(values)):
        raise argparse.ArgumentTypeError('units must be unique IDs in 1..247')
    return values


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--transport', choices=['tcp', 'rtu'], default='tcp')
    cli.add_argument('--host', default='127.0.0.1')
    cli.add_argument('--port', type=ranged_int(1, 65535), default=5020, help='TCP listening port')
    cli.add_argument('--serial-port', help='RTU slave port; the master uses the other end of a virtual pair')
    cli.add_argument('--baudrate', type=ranged_int(1, 4000000), default=115200)
    cli.add_argument('--bytesize', type=int, choices=[8], default=8)
    cli.add_argument('--parity', type=str.upper, choices=['N', 'E', 'O'], default='N')
    cli.add_argument('--stopbits', type=int, choices=[1, 2], default=1)
    cli.add_argument('--units', type=parse_units, default=[1, 2, 3])
    cli.add_argument('--register-count', type=ranged_int(12, 65535), default=128)
    cli.add_argument('--bit-count', type=ranged_int(1, 65535), default=2048)
    cli.add_argument('--static', action='store_true', help='disable changing telemetry for deterministic tests')
    cli.add_argument('--broadcast', action='store_true', help='allow RTU unit 0 broadcasts; no reply')
    cli.add_argument('--trace', action='store_true', help='print RX/TX frames to stdout')
    cli.add_argument('--fault', choices=['none', 'timeout', 'exception', 'delay', 'bad-crc', 'malformed'], default='none')
    cli.add_argument('--fault-unit', type=ranged_int(1, 247))
    cli.add_argument('--fault-fc', type=int, choices=[1, 2, 3, 4, 5, 6, 15, 16])
    cli.add_argument('--fault-count', type=ranged_int(0, 100000), default=0, help='0 means unlimited')
    cli.add_argument('--delay-ms', type=ranged_int(0, 60000), default=500)
    cli.add_argument('--exception-code', type=ranged_int(1, 11), default=2)
    return cli


async def serve(args) -> None:
    context = build_context(args.units, args.register_count, args.bit_count)
    faults = Faults(args)
    common = dict(context=context, ignore_missing_devices=True, trace_pdu=faults.trace_pdu, trace_packet=faults.trace_packet)
    if args.transport == 'rtu':
        # One simulated endpoint owns this serial port and serves all configured Unit IDs.
        server = ModbusSerialServer(port=args.serial_port, baudrate=args.baudrate, bytesize=args.bytesize,
                                    parity=args.parity, stopbits=args.stopbits, broadcast_enable=args.broadcast,
                                    reconnect_delay=0, **common)
    else:
        server = ModbusTcpServer(address=(args.host, args.port), **common)
    dyn = None
    try:
        await server.serve_forever(background=True)
        print(json.dumps({'event': 'ready', 'transport': args.transport, 'host': args.host, 'port': args.port,
                          'serialPort': args.serial_port, 'baudrate': args.baudrate, 'units': args.units,
                          'registerCount': args.register_count, 'bitCount': args.bit_count}, ensure_ascii=False), flush=True)
        if not args.static:
            dyn = asyncio.create_task(dynamics(server, args.units))
        await server.serving
    finally:
        if dyn:
            dyn.cancel()
            with suppress(asyncio.CancelledError):
                await dyn
        await server.shutdown()


def main() -> None:
    cli = parser()
    args = cli.parse_args()
    if args.transport == 'rtu' and not args.serial_port:
        cli.error('--serial-port is required for RTU; no COM port is assumed')
    if args.transport == 'tcp' and args.serial_port:
        cli.error('--serial-port is only valid for RTU')
    if args.fault == 'bad-crc' and args.transport != 'rtu':
        cli.error('bad-crc requires RTU')
    if args.fault == 'malformed' and args.transport != 'tcp':
        cli.error('malformed injects an invalid TCP MBAP header; use bad-crc for RTU')
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f'simulator failed: {error}', file=sys.stderr, flush=True)
        raise SystemExit(1) from error


if __name__ == '__main__':
    main()
