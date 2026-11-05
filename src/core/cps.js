// Reads the standard Bluetooth "Cycling Power Measurement" (0x2A63) sent by the bike.
// Layout: flags u16, power s16, then optional fields present according to the flags.

const STALE_MS = 3000;

/**
 * @param {DataView} view  the notification bytes
 * @param {{revs:number,time:number,changedAtMs:number,cadence:number|null}|null} prev  crank state
 * @param {number} nowMs  current time, used to detect that pedalling stopped
 * @returns {{watts:number, cadence:number|null, crank:object|null}}
 *   cadence: rpm; 0 when crank data stopped changing for more than 3 s; null when unknown.
 */
export function parse(view, prev, nowMs) {
  const flags = view.getUint16(0, true);
  const watts = view.getInt16(2, true);
  let offset = 4;
  if (flags & 0x01) offset += 1; // pedal power balance
  if (flags & 0x04) offset += 2; // accumulated torque
  if (flags & 0x10) offset += 6; // wheel revolutions u32 + event time u16
  if (!(flags & 0x20) || view.byteLength < offset + 4) {
    return { watts, cadence: null, crank: null };
  }
  const revs = view.getUint16(offset, true);
  const time = view.getUint16(offset + 2, true);

  if (!prev) {
    return { watts, cadence: null, crank: { revs, time, changedAtMs: nowMs, cadence: null } };
  }
  const dRevs = (revs - prev.revs) & 0xffff;
  const dTime = (time - prev.time) & 0xffff;
  if (dTime === 0 || dRevs === 0) {
    const cadence = nowMs - prev.changedAtMs > STALE_MS ? 0 : prev.cadence;
    return { watts, cadence, crank: { ...prev, cadence } };
  }
  const cadence = Math.round((dRevs * 60 * 1024) / dTime);
  return { watts, cadence, crank: { revs, time, changedAtMs: nowMs, cadence } };
}
