// Reads cadence from the Bkool-specific notification (characteristic f03ee006-…).
// Observed format: 5 bytes, raw cadence as u16 little-endian at offset 2, in 1/36 rpm.

const SCALE = 36;
const MAX_RPM = 255;

/** @returns {number|null} rpm, 0 when stopped, null when the bytes are not a cadence reading. */
export function parseCadence(view) {
  if (view.byteLength !== 5) return null;
  const raw = view.getUint16(2, true);
  if (raw === 0) return 0;
  const rpm = raw / SCALE;
  return rpm < MAX_RPM ? Math.round(rpm) : null;
}
