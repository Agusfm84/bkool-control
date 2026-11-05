import assert from "node:assert/strict";
import { test } from "node:test";
import { chip, formatTime, ladderFill, show } from "../src/ui/screen.js";

test("time shows mm:ss under an hour and h:mm:ss over", () => {
  assert.equal(formatTime(0), "00:00");
  assert.equal(formatTime(42 * 60_000 + 15_000), "42:15");
  assert.equal(formatTime(3_725_000), "1:02:05");
  assert.equal(formatTime(-5), "00:00");
});

test("unknown values show as -- ; km/h uses a comma decimal", () => {
  assert.equal(show(null), "--");
  assert.equal(show(Number.NaN), "--");
  assert.equal(show(182.4), "182");
  assert.equal(show(31.25, 1), "31,3");
  assert.equal(show(0), "0");
});

test("the ladder lights one tick per level, and ERG by the target's place in 50-400 W", () => {
  assert.equal(ladderFill("gears", 1, 100), 1);
  assert.equal(ladderFill("gears", 20, 100), 20);
  assert.equal(ladderFill("erg", 5, 50), 1);
  assert.equal(ladderFill("erg", 5, 400), 20);
  assert.equal(ladderFill("erg", 5, 230), 11); // (180/350)*19 = 9.8 → 10, +1
});

test("a missing time shows 00:00, never NaN", () => {
  assert.equal(formatTime(undefined), "00:00");
  assert.equal(formatTime(Number.NaN), "00:00");
});

test("connection chips say the device and what a tap does", () => {
  assert.deepEqual(chip("bike", "off"), { text: "Conectar bici", action: "bike" });
  assert.deepEqual(chip("bike", "on"), { text: "Bici conectada", action: "bike-off" });
  assert.deepEqual(chip("bike", "lost"), { text: "Bici sin conexión", action: "bike-off" });
  assert.deepEqual(chip("strap", "connecting"), { text: "Buscando pulsómetro…", action: null });
  assert.deepEqual(chip("strap", "on"), { text: "Pulso conectado", action: "strap-off" });
});
