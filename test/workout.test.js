import assert from "node:assert/strict";
import { test } from "node:test";
import {
  create,
  elapsedMs,
  finish,
  pause,
  resume,
  start,
  summary,
  tick,
} from "../src/core/workout.js";

const reading = (watts, cadence, hr = null) => ({ watts, cadence, hr, speedKmh: 30 });

test("a new workout is idle with zero time", () => {
  const w = create();
  assert.equal(w.status, "idle");
  assert.equal(elapsedMs(w, 5000), 0);
});

test("paused time is not counted: 60 s + pause 30 s + 60 s = 120 s", () => {
  let w = start(create(), 0);
  w = pause(w, 60_000);
  assert.equal(w.status, "paused");
  assert.equal(elapsedMs(w, 75_000), 60_000); // frozen while paused
  w = resume(w, 90_000);
  assert.equal(elapsedMs(w, 150_000), 120_000);
  w = finish(w, 150_000);
  assert.equal(w.status, "finished");
  assert.equal(elapsedMs(w, 999_999), 120_000);
});

test("finishing while paused does not count the pause", () => {
  let w = start(create(), 0);
  w = pause(w, 10_000);
  w = finish(w, 40_000);
  assert.equal(elapsedMs(w, 40_000), 10_000);
});

test("illegal transitions leave the workout unchanged", () => {
  const idle = create();
  assert.equal(pause(idle, 1), idle);
  assert.equal(resume(idle, 1), idle);
  const running = start(idle, 0);
  assert.equal(start(running, 5), running);
  assert.equal(resume(running, 5), running);
});

test("one sample per whole second, only while running", () => {
  let w = start(create(), 0);
  w = tick(w, 400, reading(100, 80)); // second 0
  w = tick(w, 900, reading(110, 80)); // still second 0: ignored
  w = tick(w, 1000, reading(120, 82)); // second 1
  w = pause(w, 1500);
  w = tick(w, 2500, reading(999, 99)); // paused: ignored
  w = resume(w, 3000);
  w = tick(w, 3600, reading(130, 84)); // elapsed 2.1 s → second 2
  assert.deepEqual(
    w.samples.map((s) => [s.t, s.watts]),
    [
      [0, 100],
      [1, 120],
      [2, 130],
    ],
  );
});

test("a missing reading is recorded as a gap", () => {
  let w = start(create(), 0);
  w = tick(w, 0, reading(100, 80));
  w = tick(w, 1000, null);
  assert.deepEqual(w.samples[1], { t: 1, gap: true });
});

test("summary averages over data samples; heart rate null without a strap", () => {
  let w = start(create(), 0);
  w = tick(w, 0, reading(100, 80));
  w = tick(w, 1000, reading(200, 90));
  w = tick(w, 2000, null);
  w = tick(w, 3000, reading(301, 91));
  w = finish(w, 4000);
  assert.deepEqual(summary(w), {
    durationS: 4,
    avgW: 200, // (100 + 200 + 301) / 3 = 200.33
    maxW: 301,
    avgCad: 87, // (80 + 90 + 91) / 3 = 87
    avgHr: null,
    maxHr: null,
  });
});

test("summary includes heart rate when present", () => {
  let w = start(create(), 0);
  w = tick(w, 0, reading(100, 80, 120));
  w = tick(w, 1000, reading(100, 80, 141));
  w = tick(w, 2000, reading(100, null, null)); // strap dropped for a second
  w = finish(w, 3000);
  const s = summary(w);
  assert.equal(s.avgHr, 131); // (120 + 141) / 2 = 130.5 → 131
  assert.equal(s.maxHr, 141);
  assert.equal(s.avgCad, 80);
});

test("finishing with under a minute still gives a summary", () => {
  let w = start(create(), 0);
  w = tick(w, 0, reading(150, 85));
  w = finish(w, 20_000);
  assert.equal(summary(w).durationS, 20);
  assert.equal(summary(w).avgW, 150);
});

test("finishing with no samples gives zeros, not errors", () => {
  const w = finish(start(create(), 0), 5000);
  assert.deepEqual(summary(w), {
    durationS: 5,
    avgW: 0,
    maxW: 0,
    avgCad: 0,
    avgHr: null,
    maxHr: null,
  });
});

test("summary of a workout that was never finished does not give a negative time", () => {
  let w = start(create(), 1_000_000);
  w = tick(w, 1_000_000, reading(100, 80));
  assert.ok(summary(w).durationS >= 0);
});
