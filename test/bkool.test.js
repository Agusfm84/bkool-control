// Bkool notification f03ee006: 5 bytes, cadence raw u16 little-endian at offset 2, divided by 36.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCadence } from "../src/core/bkool.js";
import { view } from "./helpers.js";

test("raw 3240 / 36 = 90 rpm", () => {
  assert.equal(parseCadence(view(0, 0, 0xa8, 0x0c, 0)), 90); // 0x0CA8 = 3240
});

test("raw 0 = stopped", () => {
  assert.equal(parseCadence(view(0, 0, 0, 0, 0)), 0);
});

test("wrong length or absurd value = unknown", () => {
  assert.equal(parseCadence(view(0, 0, 0xa8, 0x0c)), null);
  assert.equal(parseCadence(view(0, 0, 0xff, 0xff, 0)), null); // 65535/36 ≈ 1820 rpm
});
