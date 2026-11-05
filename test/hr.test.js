// Heart Rate Measurement (0x2A37): flags bit 0 = 0 → u8 bpm, 1 → u16 bpm.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../src/core/hr.js";
import { view } from "./helpers.js";

test("8-bit format: 72 bpm", () => {
  assert.equal(parse(view(0x00, 72)), 72);
});

test("16-bit format: 300 bpm", () => {
  assert.equal(parse(view(0x01, 0x2c, 0x01)), 300);
});

test("other flag bits do not change the reading", () => {
  assert.equal(parse(view(0x16, 142, 0x00, 0x00)), 142);
});
