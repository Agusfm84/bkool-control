// Estimated speed from power, as if riding on a flat road with no wind. Informative only:
// the bike does not report speed, and the indoor distance in Strava is approximate.

/** Rider weight used by the estimate. The next cycle (user profiles) replaces this value. */
export const RIDER_KG = 75;

const BIKE_KG = 8;
const G = 9.81;
const CRR = 0.004; // rolling resistance
const CDA = 0.32; // drag area (m²), road bike on the hoods
const RHO = 1.225; // air density (kg/m³)

/** @returns {number} km/h with one decimal; 0 for no power. */
export function fromPower(watts, riderKg = RIDER_KG) {
  if (!(watts > 0)) return 0;
  const rolling = CRR * (riderKg + BIKE_KG) * G;
  const drag = 0.5 * RHO * CDA;
  // Power needed at speed v: v·(rolling + drag·v²). It grows with v, so bisection finds the root.
  let lo = 0;
  let hi = 30; // m/s ≈ 108 km/h, far above any human output
  for (let i = 0; i < 60; i++) {
    const v = (lo + hi) / 2;
    if (v * (rolling + drag * v * v) < watts) lo = v;
    else hi = v;
  }
  return Math.round(lo * 3.6 * 10) / 10;
}
