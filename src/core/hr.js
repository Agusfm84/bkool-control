// Reads the standard Bluetooth "Heart Rate Measurement" (0x2A37).
// Flags bit 0: 0 → beats per minute as u8, 1 → as u16 little-endian.

/** @returns {number} beats per minute */
export function parse(view) {
  const flags = view.getUint8(0);
  return flags & 0x01 ? view.getUint16(1, true) : view.getUint8(1);
}
