// Cycling Power Measurement (0x2A63): flags u16, power s16, then optional fields by flag.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../src/core/cps.js";
import { view } from "./helpers.js";

test("power only: flags 0, 250 W", () => {
  const r = parse(view(0x00, 0x00, 0xfa, 0x00), null, 0);
  assert.equal(r.watts, 250);
  assert.equal(r.cadence, null);
});

test("negative power is read as signed", () => {
  assert.equal(parse(view(0x00, 0x00, 0xfe, 0xff), null, 0).watts, -2);
});

// flags 0x20 = crank data: revs u16, last event time u16 (1/1024 s)
const crank = (revs, time) =>
  view(0x20, 0x00, 0x96, 0x00, revs & 0xff, revs >> 8, time & 0xff, time >> 8);

test("cadence from two crank events: 1 rev in 0.75 s = 80 rpm", () => {
  const a = parse(crank(10, 1024), null, 0);
  assert.equal(a.watts, 150);
  assert.equal(a.cadence, null); // first event: nothing to compare with
  const b = parse(crank(11, 1792), a.crank, 750); // 768/1024 s = 0.75 s
  assert.equal(b.cadence, 80);
});

test("counters wrap at 65536", () => {
  const a = parse(crank(65535, 65000), null, 0);
  const b = parse(crank(0, 65000 + 768 - 65536), a.crank, 750);
  assert.equal(b.cadence, 80);
});

test("same event repeated keeps the last cadence for up to 3 s, then 0", () => {
  const a = parse(crank(10, 1024), null, 0);
  const b = parse(crank(11, 1792), a.crank, 750);
  const c = parse(crank(11, 1792), b.crank, 2500);
  assert.equal(c.cadence, 80);
  const d = parse(crank(11, 1792), c.crank, 3800);
  assert.equal(d.cadence, 0);
});

test("optional fields before crank data are skipped (balance, torque, wheel)", () => {
  // flags 0x35 = balance(1) + torque(2) + wheel(6) + crank(4)
  const bytes = (revs, time) =>
    view(
      0x35,
      0x00,
      0x64,
      0x00,
      0x32,
      0x10,
      0x00,
      1,
      0,
      0,
      0,
      0,
      0,
      revs,
      0,
      time & 0xff,
      time >> 8,
    );
  const a = parse(bytes(5, 0), null, 0);
  assert.equal(a.watts, 100);
  const b = parse(bytes(6, 512), a.crank, 500); // 1 rev in 0.5 s = 120 rpm
  assert.equal(b.cadence, 120);
});
