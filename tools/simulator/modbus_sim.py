"""Standalone Modbus TCP simulator (independent of the TypeScript client).

Built on PyModbus. Provides multiple unit ids, dynamic numeric values, bool edges,
enum/status word cycling, string changes, write support (FC05/06/15/16) and
exception injection for illegal addresses.

Usage:
  python tools/simulator/modbus_sim.py [--port 5020] [--units 1,2,3]
"""
from __future__ import annotations

import argparse
import asyncio
import math
import random
import struct
import time

from pymodbus.datastore import (
    ModbusDeviceContext,
    ModbusSequentialDataBlock,
    ModbusServerContext,
)
from pymodbus.server import ModbusTcpServer

HOLDING_SIZE = 128
INPUT_SIZE = 64
COIL_SIZE = 64
DISCRETE_SIZE = 64


def float_to_words(value: float) -> tuple[int, int]:
    b = struct.pack(">f", value)
    return (b[0] << 8) | b[1], (b[2] << 8) | b[3]


def build_context(units: list[int]) -> ModbusServerContext:
    devices = {}
    for unit in units:
        devices[unit] = ModbusDeviceContext(
            di=ModbusSequentialDataBlock(1, [False] * DISCRETE_SIZE),
            co=ModbusSequentialDataBlock(1, [False] * COIL_SIZE),
            hr=ModbusSequentialDataBlock(1, [0] * HOLDING_SIZE),
            ir=ModbusSequentialDataBlock(1, [0] * INPUT_SIZE),
        )
    return ModbusServerContext(devices=devices, single=False)


async def dynamics(server: ModbusTcpServer, units: list[int]) -> None:
    t0 = time.monotonic()
    while True:
        t = time.monotonic() - t0
        for unit in units:
            hi, lo = float_to_words(48.2 + math.sin(t / 3.0) * 0.4 + random.uniform(-0.02, 0.02))
            await server.async_setValues(unit, 3, 0, [hi, lo])
            hi, lo = float_to_words(1.2 + math.sin(t / 1.7) * 0.25)
            await server.async_setValues(unit, 3, 2, [hi, lo])
            word = 0x0037
            if int(t) % 4 < 2:
                word |= 0x0010
            await server.async_setValues(unit, 3, 4, [word])
            current = await server.async_getValues(unit, 3, 6, 1)
            if isinstance(current, list) and current and current[0] in (0, 1):
                await server.async_setValues(unit, 3, 6, [1500])
            text = f"V2.4.{int(t) % 3}"
            padded = text.ljust(8, "\x00")
            words = [(ord(padded[i]) << 8) | ord(padded[i + 1]) for i in range(0, 8, 2)]
            await server.async_setValues(unit, 3, 8, words[:4])
            hi, lo = float_to_words(42.0 + math.sin(t / 5.0) * 1.5)
            await server.async_setValues(unit, 4, 0, [hi, lo])
            hi, lo = float_to_words(48.1 + math.cos(t / 4.0) * 0.3)
            await server.async_setValues(unit, 4, 2, [hi, lo])
            await server.async_setValues(unit, 1, 4, [(int(t) % 5) < 3])
            await server.async_setValues(unit, 2, 0, [(int(t) % 2) == 0])
        await asyncio.sleep(0.2)


async def serve(port: int, host: str, units: list[int]) -> None:
    context = build_context(units)
    server = ModbusTcpServer(context=context, address=(host, port))
    print(f"modbus simulator listening on {host}:{port} units={units}", flush=True)
    task = asyncio.create_task(server.serve_forever())
    dyn = asyncio.create_task(dynamics(server, units))
    try:
        await task
    except asyncio.CancelledError:
        pass
    finally:
        dyn.cancel()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5020)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--units", default="1,2,3")
    args = parser.parse_args()
    units = [int(u) for u in args.units.split(",") if u.strip()]
    try:
        asyncio.run(serve(args.port, args.host, units))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()