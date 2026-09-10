/** CRC-16/MODBUS: poly 0xA001 (reflected), init 0xFFFF, little-endian append. */
export function crc16Modbus(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= data[i] as number;
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}

export function appendCrc(frame: Uint8Array): Uint8Array {
  const crc = crc16Modbus(frame);
  const out = new Uint8Array(frame.length + 2);
  out.set(frame, 0);
  out[frame.length] = crc & 0xff;
  out[frame.length + 1] = (crc >> 8) & 0xff;
  return out;
}

export function checkCrc(adu: Uint8Array): boolean {
  if (adu.length < 4) return false;
  const crc = crc16Modbus(adu, 0, adu.length - 2);
  return adu[adu.length - 2] === (crc & 0xff) && adu[adu.length - 1] === ((crc >> 8) & 0xff);
}