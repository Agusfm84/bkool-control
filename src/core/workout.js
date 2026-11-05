// Workout timer and recording. Pure: time is always passed in, nothing is mutated.
// States: idle → running ⇄ paused → finished. Paused time is neither counted nor recorded.

export function create() {
  return { status: "idle" };
}

export function start(w, now) {
  if (w.status !== "idle") return w;
  return {
    status: "running",
    startedAt: now,
    pausedTotalMs: 0,
    pausedAt: null,
    finishedAt: null,
    samples: [],
    lastSecond: -1,
  };
}

export function pause(w, now) {
  if (w.status !== "running") return w;
  return { ...w, status: "paused", pausedAt: now };
}

export function resume(w, now) {
  if (w.status !== "paused") return w;
  return {
    ...w,
    status: "running",
    pausedTotalMs: w.pausedTotalMs + (now - w.pausedAt),
    pausedAt: null,
  };
}

export function finish(w, now) {
  if (w.status === "running") return { ...w, status: "finished", finishedAt: now };
  if (w.status === "paused") return { ...w, status: "finished", finishedAt: w.pausedAt };
  return w;
}

/** Workout time in ms, excluding pauses. */
export function elapsedMs(w, now) {
  if (w.status === "idle") return 0;
  const end = w.status === "paused" ? w.pausedAt : w.status === "finished" ? w.finishedAt : now;
  return end - w.startedAt - w.pausedTotalMs;
}

/**
 * Records at most one sample per whole second of workout time, only while running.
 * @param {{watts:number, cadence:number|null, hr:number|null, speedKmh:number}|null} reading
 *   null = no data from the bike this second (recorded as a gap).
 */
export function tick(w, now, reading) {
  if (w.status !== "running") return w;
  const second = Math.floor(elapsedMs(w, now) / 1000);
  if (second <= w.lastSecond) return w;
  const sample = reading ? { t: second, ...reading } : { t: second, gap: true };
  return { ...w, samples: [...w.samples, sample], lastSecond: second };
}

const mean = (values) =>
  values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;

export function summary(w) {
  const data = (w.samples ?? []).filter((s) => !s.gap);
  const watts = data.map((s) => s.watts);
  const cadences = data.map((s) => s.cadence).filter((c) => c != null);
  const hrs = data.map((s) => s.hr).filter((h) => h != null);
  return {
    // Unfinished (e.g. recovered after a reload): the recorded seconds are the best measure.
    durationS:
      w.finishedAt != null
        ? Math.round(elapsedMs(w, w.finishedAt) / 1000)
        : Math.max(0, (w.lastSecond ?? -1) + 1),
    avgW: mean(watts) ?? 0,
    maxW: watts.length ? Math.max(...watts) : 0,
    avgCad: mean(cadences) ?? 0,
    avgHr: mean(hrs),
    maxHr: hrs.length ? Math.max(...hrs) : null,
  };
}
