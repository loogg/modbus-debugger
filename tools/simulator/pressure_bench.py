"""Generate pressure feedback for docs/examples/pressure-bench.workspace.json."""

import argparse
import json
import time

from pymodbus.client import ModbusTcpClient
from pymodbus.exceptions import ModbusException


PERIOD = 0.2
MODEL_ID = 0x5054


def checked(reply):
    if reply.isError():
        raise RuntimeError(str(reply))
    return reply


def tick(client):
    coils = checked(client.read_coils(0, count=2, device_id=1)).bits
    target = checked(client.read_holding_registers(0, count=1, device_id=1)).registers[0]
    pressure, model = checked(client.read_holding_registers(100, count=2, device_id=2)).registers
    if model != MODEL_ID:
        raise RuntimeError("Expected the pressure bench model ID 0x5054 at Unit 2 HR101")

    # One raw unit is 0.01 MPa. An enabled pump approaches the setpoint;
    # switching it off opens the discharge path, independently of the HMI.
    goal = min(target, 60) if coils[0] else 0
    next_pressure = pressure + max(-5, min(3, goal - pressure))
    if next_pressure != pressure:
        checked(client.write_register(100, next_pressure, device_id=2))
    return {"enabled": bool(coils[0]), "alarm": bool(coils[1]), "setpoint": target,
            "pressure": next_pressure}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=15032, help="Local field station TCP port")
    args = parser.parse_args()
    client = ModbusTcpClient("127.0.0.1", port=args.port, timeout=0.5, retries=0)
    last = None
    try:
        while True:
            started = time.monotonic()
            try:
                state = tick(client)
            except (ModbusException, OSError, RuntimeError) as exc:
                client.close()
                state = {"waiting": str(exc)}
            if state != last:
                print(json.dumps(state, ensure_ascii=False), flush=True)
                last = state
            time.sleep(max(0.0, PERIOD - (time.monotonic() - started)))
    except KeyboardInterrupt:
        pass
    finally:
        client.close()


if __name__ == "__main__":
    main()
