// Riding state machine. Expected orders are written as literal bytes (level L → slope L−1 %).
import assert from "node:assert/strict";
import { test } from "node:test";
import { canPress, create, currentOrder, press, safeOrder, setMode } from "../src/core/control.js";

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ");

const SLOPE_0 = "33 25 FF FF FF 20 4E 50"; // level 1
const SLOPE_4 = "33 25 FF FF FF B0 4F 50"; // level 5: 20400 = 0x4FB0
const SLOPE_5 = "33 25 FF FF FF 14 50 50"; // level 6: 20500 = 0x5014
const SLOPE_19 = "33 25 FF FF FF 8C 55 50"; // level 20: 21900 = 0x558C
const ERG_100 = "31 25 FF FF FF FF 90 01";
const ERG_110 = "31 25 FF FF FF FF B8 01"; // 440 = 0x01B8
const ERG_90 = "31 25 FF FF FF FF 68 01"; // 360 = 0x0168

function pressN(state, dir, n) {
  let s = state;
  let order = null;
  for (let i = 0; i < n; i++) ({ state: s, order } = press(s, dir));
  return { state: s, order };
}

test("starts in gears mode at level 5 with ERG target 100 W", () => {
  const s = create();
  assert.equal(s.mode, "gears");
  assert.equal(s.level, 5);
  assert.equal(s.ergTarget, 100);
  assert.equal(hex(currentOrder(s)), SLOPE_4);
});

test("plus raises the level by one and orders the matching slope", () => {
  const { state, order } = press(create(), "plus");
  assert.equal(state.level, 6);
  assert.equal(hex(order), SLOPE_5);
});

test("minus lowers the level; level 1 is flat", () => {
  const { state, order } = pressN(create(), "minus", 4);
  assert.equal(state.level, 1);
  assert.equal(hex(order), SLOPE_0);
});

test("level 20 is the top: plus does nothing and is disabled", () => {
  const top = pressN(create(), "plus", 15).state;
  assert.equal(top.level, 20);
  assert.equal(hex(currentOrder(top)), SLOPE_19);
  const again = press(top, "plus");
  assert.equal(again.state.level, 20);
  assert.equal(again.order, null);
  assert.equal(canPress(top, "plus"), false);
  assert.equal(canPress(top, "minus"), true);
});

test("level 1 is the bottom: minus does nothing and is disabled", () => {
  const bottom = pressN(create(), "minus", 4).state;
  const again = press(bottom, "minus");
  assert.equal(again.state.level, 1);
  assert.equal(again.order, null);
  assert.equal(canPress(bottom, "minus"), false);
});

test("first switch to ERG targets 100 W", () => {
  const { state, order } = setMode(create(), "erg");
  assert.equal(state.mode, "erg");
  assert.equal(state.ergTarget, 100);
  assert.equal(hex(order), ERG_100);
});

test("in ERG, plus and minus move the target by 10 W", () => {
  const erg = setMode(create(), "erg").state;
  const up = press(erg, "plus");
  assert.equal(up.state.ergTarget, 110);
  assert.equal(hex(up.order), ERG_110);
  const down = press(erg, "minus");
  assert.equal(down.state.ergTarget, 90);
  assert.equal(hex(down.order), ERG_90);
});

test("ERG limits are 50 W and 400 W", () => {
  const erg = setMode(create(), "erg").state;
  const low = pressN(erg, "minus", 10).state;
  assert.equal(low.ergTarget, 50);
  assert.equal(press(low, "minus").order, null);
  assert.equal(canPress(low, "minus"), false);
  const high = pressN(erg, "plus", 40).state;
  assert.equal(high.ergTarget, 400);
  assert.equal(press(high, "plus").order, null);
  assert.equal(canPress(high, "plus"), false);
});

test("each mode remembers its value across switches", () => {
  let s = pressN(create(), "plus", 2).state; // level 7
  s = setMode(s, "erg").state;
  s = pressN(s, "plus", 5).state; // 150 W
  s = setMode(s, "gears").state;
  assert.equal(s.level, 7);
  const back = setMode(s, "erg");
  assert.equal(back.state.ergTarget, 150);
  assert.equal(hex(back.order), "31 25 FF FF FF FF 58 02");
});

test("the safe order is flat (level 1) whatever the mode", () => {
  assert.equal(hex(safeOrder()), SLOPE_0);
});

test("press and setMode never change the state they receive", () => {
  const s = create();
  const copy = structuredClone(s);
  press(s, "plus");
  setMode(s, "erg");
  assert.deepEqual(s, copy);
});
