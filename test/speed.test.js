import assert from "node:assert/strict";
import { test } from "node:test";
import { fromPower, RIDER_KG } from "../src/core/speed.js";

test("rider weight is 75 kg in one place", () => {
  assert.equal(RIDER_KG, 75);
});

test("0 W (or less) means standing still", () => {
  assert.equal(fromPower(0), 0);
  assert.equal(fromPower(-5), 0);
});

test("200 W on the flat is a plausible road speed (32-36 km/h)", () => {
  const v = fromPower(200);
  assert.ok(v > 32 && v < 36, `got ${v}`);
});

test("more power always means more speed", () => {
  let last = 0;
  for (let w = 10; w <= 600; w += 10) {
    const v = fromPower(w);
    assert.ok(v > last, `${w} W gave ${v}, not more than ${last}`);
    last = v;
  }
});

test("a heavier rider is slower at the same power", () => {
  assert.ok(fromPower(150, 100) < fromPower(150, 60));
});
