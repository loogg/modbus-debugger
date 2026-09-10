"""Generate golden protocol fixtures.

These expected bytes are produced by this independent script (plain Python, no project
codec involved) and committed as static JSON. The TypeScript codec under test must
never be used to (re)generate them.
"""
import json
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures", "protocol")


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc & 0xFFFF


def rtu(unit: int, pdu: bytes) -> bytes:
    body = bytes([unit]) + pdu
    c = crc16(body)
    return body + bytes([c & 0xFF, c >> 8])


def tcp(tid: int, unit: int, pdu: bytes) -> bytes:
    length = len(pdu) + 1
    return bytes([tid >> 8, tid & 0xFF, 0, 0, length >> 8, length & 0xFF, unit]) + pdu


def hx(b: bytes) -> str:
    return b.hex()


def chunks(b: bytes, sizes):
    out = []
    i = 0
    for s in sizes:
        out.append(hx(b[i:i + s]))
        i += s
    if i < len(b):
        out.append(hx(b[i:]))
    return out


def regs_words(values):
    out = bytearray()
    for v in values:
        out += bytes([v >> 8, v & 0xFF])
    return bytes(out)


def main():
    os.makedirs(OUT, exist_ok=True)

    # --- CRC anchor vectors (CRC-16/MODBUS check value for "123456789" is 0x4B37) ---
    crc_vectors = [
        {"input": "313233343536373839", "crc": "374b"},
        {"input": "010300000020", "crc": hx(bytes([crc16(bytes.fromhex("010300000020")) & 0xFF, crc16(bytes.fromhex("010300000020")) >> 8]))},
        {"input": "01034000", "crc": hx(bytes([crc16(bytes.fromhex("01034000")) & 0xFF, crc16(bytes.fromhex("01034000")) >> 8]))},
    ]

    # --- RTU request / response / exception vectors ---
    req_fc03 = rtu(1, bytes([0x03, 0x00, 0x00, 0x00, 0x20]))
    req_fc01 = rtu(2, bytes([0x01, 0x00, 0x10, 0x00, 0x08]))
    req_fc05_on = rtu(1, bytes([0x05, 0x00, 0x04, 0xFF, 0x00]))
    req_fc06 = rtu(1, bytes([0x06, 0x00, 0x06, 0x05, 0xDC]))
    req_fc16 = rtu(1, bytes([0x10, 0x00, 0x06, 0x00, 0x02, 0x04, 0x05, 0xDC, 0x00, 0x0A]))
    req_fc15 = rtu(1, bytes([0x0F, 0x00, 0x04, 0x00, 0x03, 0x01, 0x05]))

    resp_fc03_data = regs_words(list(range(32)))
    resp_fc03 = rtu(1, bytes([0x03, 0x40]) + resp_fc03_data)
    resp_fc01 = rtu(2, bytes([0x01, 0x01, 0xA5]))
    resp_fc05 = rtu(1, bytes([0x05, 0x00, 0x04, 0xFF, 0x00]))
    resp_fc06 = rtu(1, bytes([0x06, 0x00, 0x06, 0x05, 0xDC]))
    resp_fc16 = rtu(1, bytes([0x10, 0x00, 0x06, 0x00, 0x02]))
    resp_fc15 = rtu(1, bytes([0x0F, 0x00, 0x04, 0x00, 0x03]))
    exc_02 = rtu(1, bytes([0x83, 0x02]))
    exc_03 = rtu(1, bytes([0x86, 0x03]))

    rtu_vectors = {
        "requests": {
            "fc03_read_32": hx(req_fc03),
            "fc01_read_8_coils": hx(req_fc01),
            "fc05_force_on": hx(req_fc05_on),
            "fc06_write_single": hx(req_fc06),
            "fc16_write_two": hx(req_fc16),
            "fc15_write_three": hx(req_fc15),
        },
        "responses": {
            "fc03_32_registers": hx(resp_fc03),
            "fc01_8_coils": hx(resp_fc01),
            "fc05_echo": hx(resp_fc05),
            "fc06_echo": hx(resp_fc06),
            "fc16_ack": hx(resp_fc16),
            "fc15_ack": hx(resp_fc15),
        },
        "exceptions": {
            "illegal_data_address": hx(exc_02),
            "illegal_data_value": hx(exc_03),
        },
    }

    # --- TCP vectors ---
    tcp_req = tcp(0x0007, 1, bytes([0x03, 0x00, 0x00, 0x00, 0x10]))
    tcp_resp = tcp(0x0007, 1, bytes([0x03, 0x20]) + regs_words(list(range(16))))
    tcp_exc = tcp(0x0007, 1, bytes([0x83, 0x02]))
    tcp_late = tcp(0x0005, 1, bytes([0x03, 0x20]) + regs_words([0xAA] * 16))
    tcp_vectors = {
        "request_tid7": hx(tcp_req),
        "response_tid7": hx(tcp_resp),
        "exception_tid7": hx(tcp_exc),
        "late_response_tid5": hx(tcp_late),
    }

    # --- Streaming scenarios ---
    noise = bytes([0xFF, 0x00, 0x7E, 0x13])
    bad_crc = bytes(resp_fc03)
    bad_crc = bad_crc[:-2] + bytes([bad_crc[-2] ^ 0xFF, bad_crc[-1]])
    truncated = resp_fc03[: len(resp_fc03) // 2]

    streaming = {
        "rtu_single_frame_split": {
            "frame": hx(resp_fc03),
            "chunks": chunks(resp_fc03, [3, 5, 10, 7]),
        },
        "rtu_multi_frame_one_chunk": {
            "frames": [hx(resp_fc01), hx(resp_fc03)],
            "chunks": [hx(resp_fc01 + resp_fc03)],
        },
        "rtu_half_sticky_mix": {
            "frames": [hx(resp_fc01), hx(resp_fc03), hx(resp_fc06)],
            "chunks": [
                hx(resp_fc01[:3]),
                hx(resp_fc01[3:] + resp_fc03),
                hx(resp_fc06[:2]),
                hx(resp_fc06[2:]),
            ],
        },
        "rtu_noise_then_good": {
            "frames": [hx(resp_fc03)],
            "chunks": [hx(noise), hx(resp_fc03)],
            "note": "noise segment is separated by silence; must be reported and dropped without losing the good frame",
        },
        "rtu_bad_crc_glued_then_good": {
            "frames": [hx(resp_fc03)],
            "chunks": [hx(bad_crc + resp_fc03)],
            "note": "CRC-bad frame glued to a good frame in one silent segment: recover the good frame",
        },
        "rtu_truncated_then_good": {
            "frames": [hx(resp_fc06)],
            "chunks": [hx(truncated), hx(resp_fc06)],
        },
        "tcp_single_frame_split": {
            "frame": hx(tcp_resp),
            "chunks": chunks(tcp_resp, [2, 5, 4, 9]),
        },
        "tcp_multi_frame_one_chunk": {
            "frames": [hx(tcp_resp), hx(tcp_exc)],
            "chunks": [hx(tcp_resp + tcp_exc)],
        },
        "tcp_half_sticky_mix": {
            "frames": [hx(tcp_resp), hx(tcp_exc), hx(tcp_req)],
            "chunks": [
                hx(tcp_resp[4:]),
            ],
            "prefix": hx(tcp_resp[:4]),
            "tail": [hx(tcp_exc + tcp_req[:3]), hx(tcp_req[3:])],
        },
        "tcp_garbage_prefix_then_good": {
            "frames": [hx(tcp_resp)],
            "chunks": [hx(bytes([0x12, 0x34, 0x99, 0x00, 0x02]) + tcp_resp)],
        },
        "tcp_bad_protocol_id_then_good": {
            "frames": [hx(tcp_resp)],
            "chunks": [hx(bytes([0x00, 0x09, 0x00, 0x01, 0x00, 0x06, 0x01, 0x03, 0x00, 0x00, 0x00, 0x10, 0x00]) + tcp_resp)],
        },
        "tcp_oversize_length_then_good": {
            "frames": [hx(tcp_resp)],
            "chunks": [hx(bytes([0x00, 0x0A, 0x00, 0x00, 0x0F, 0xFF, 0x01]) + tcp_resp)],
        },
        "tcp_late_tid_then_new": {
            "frames": [hx(tcp_resp)],
            "late": hx(tcp_late),
            "chunks": [hx(tcp_late), hx(tcp_resp)],
        },
    }

    meta = {
        "source": "Modbus Application Protocol V1.1b3 / Serial Line V1.02",
        "generated_by": "tools/gen_protocol_fixtures.py (independent of the TypeScript codec)",
        "limits": {"max_pdu": 253, "max_rtu_adu": 256, "max_tcp_adu": 260},
    }

    with open(os.path.join(OUT, "crc-vectors.json"), "w", encoding="utf-8") as f:
        json.dump(crc_vectors, f, indent=2)
    with open(os.path.join(OUT, "rtu-vectors.json"), "w", encoding="utf-8") as f:
        json.dump(rtu_vectors, f, indent=2)
    with open(os.path.join(OUT, "tcp-vectors.json"), "w", encoding="utf-8") as f:
        json.dump(tcp_vectors, f, indent=2)
    with open(os.path.join(OUT, "streaming-scenarios.json"), "w", encoding="utf-8") as f:
        json.dump(streaming, f, indent=2)
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print("fixtures written to", os.path.abspath(OUT))


if __name__ == "__main__":
    main()