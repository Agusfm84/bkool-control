// Orders for the Bkool Smart Bike: 8-byte ANT+ FE-C data pages sent over Bluetooth.
// Built from the public ANT+ FE-C page layouts. On this bike byte 1 is 0x25 (observed Bkool
// quirk) and unused bytes are 0xFF.

const BKOOL_BYTE1 = 0x25;
const UNUSED = 0xff;

/** Rolling-resistance coefficient byte: 0x50 × 5e-5 = 0.004 (ANT+ unit is 5e-5). */
const CRR_BYTE = 0x50;

function checkRange(name, value, min, max) {
  if (typeof value !== "number" || Number.isNaN(value) || value < min || value > max) {
    throw new RangeError(`${name} fuera de rango: ${value} (permitido ${min}..${max})`);
  }
}

function page(number, lastBytes) {
  const bytes = new Uint8Array(8).fill(UNUSED);
  bytes[0] = number;
  bytes[1] = BKOOL_BYTE1;
  bytes.set(lastBytes, 8 - lastBytes.length);
  return bytes;
}

/** Page 0x33 "Track Resistance": simulated slope in percent (-200..200). */
export function trackResistance(slopePct) {
  checkRange("Pendiente", slopePct, -200, 200);
  const grade = Math.round((slopePct + 200) * 100);
  return page(0x33, [grade & 0xff, grade >> 8, CRR_BYTE]);
}

/** Page 0x31 "Target Power" (ERG): watts (0..4000), sent in 0.25 W units. */
export function targetPower(watts) {
  checkRange("Potencia", watts, 0, 4000);
  const quarterWatts = Math.round(watts * 4);
  return page(0x31, [quarterWatts & 0xff, quarterWatts >> 8]);
}

/** Page 0x30 "Basic Resistance": percent of maximum (0..100), sent in 0.5 % units. */
export function basicResistance(pct) {
  checkRange("Resistencia", pct, 0, 100);
  return page(0x30, [Math.round(pct * 2)]);
}
