// Expected bytes worked out by hand from the ANT+ FE-C data pages
// (byte 1 = 0x25 on this bike, unused bytes 0xFF). Never compare against the encoder itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import { basicResistance, targetPower, trackResistance } from "../src/core/fec.js";

const hex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

test("track resistance (page 0x33): grade = (slope + 200) * 100, little-endian, crr 0x50", () => {
  assert.equal(hex(trackResistance(0)), "33 25 FF FF FF 20 4E 50"); // 20000 = 0x4E20
  assert.equal(hex(trackResistance(5)), "33 25 FF FF FF 14 50 50"); // 20500 = 0x5014
  assert.equal(hex(trackResistance(19)), "33 25 FF FF FF 8C 55 50"); // 21900 = 0x558C
  assert.equal(hex(trackResistance(-5)), "33 25 FF FF FF 2C 4C 50"); // 19500 = 0x4C2C
  assert.equal(hex(trackResistance(2.5)), "33 25 FF FF FF 1A 4F 50"); // 20250 = 0x4F1A
});

test("target power (page 0x31): watts * 4, little-endian", () => {
  assert.equal(hex(targetPower(100)), "31 25 FF FF FF FF 90 01"); // 400 = 0x0190
  assert.equal(hex(targetPower(150)), "31 25 FF FF FF FF 58 02"); // 600 = 0x0258
  assert.equal(hex(targetPower(400)), "31 25 FF FF FF FF 40 06"); // 1600 = 0x0640
  assert.equal(hex(targetPower(0)), "31 25 FF FF FF FF 00 00");
});

test("basic resistance (page 0x30): percent * 2 in the last byte", () => {
  assert.equal(hex(basicResistance(50)), "30 25 FF FF FF FF FF 64"); // 100 = 0x64
  assert.equal(hex(basicResistance(0)), "30 25 FF FF FF FF FF 00");
  assert.equal(hex(basicResistance(100)), "30 25 FF FF FF FF FF C8"); // 200 = 0xC8
});

test("out-of-range or non-numeric values are refused", () => {
  assert.throws(() => trackResistance(201), RangeError);
  assert.throws(() => trackResistance(-201), RangeError);
  assert.throws(() => targetPower(-1), RangeError);
  assert.throws(() => targetPower(4001), RangeError);
  assert.throws(() => basicResistance(101), RangeError);
  assert.throws(() => basicResistance(-1), RangeError);
  assert.throws(() => targetPower(Number.NaN), RangeError);
  assert.throws(() => trackResistance("5"), RangeError);
});

test("accepted boundaries and rounding", () => {
  assert.equal(hex(trackResistance(200)), "33 25 FF FF FF 40 9C 50"); // 40000 = 0x9C40
  assert.equal(hex(trackResistance(-200)), "33 25 FF FF FF 00 00 50");
  assert.equal(hex(targetPower(4000)), "31 25 FF FF FF FF 80 3E"); // 16000 = 0x3E80
  assert.equal(hex(targetPower(100.1)), "31 25 FF FF FF FF 90 01"); // 400.4 rounds to 400
  assert.equal(hex(targetPower(100.2)), "31 25 FF FF FF FF 91 01"); // 400.8 rounds to 401
});
