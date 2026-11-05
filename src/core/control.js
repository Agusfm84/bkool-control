// Riding state machine: Cambios (virtual gears) and ERG (fixed power). Pure: every function
// returns a new state and the order to send to the bike; nothing here touches Bluetooth.
import { targetPower, trackResistance } from "./fec.js";

export const LEVEL_MIN = 1;
export const LEVEL_MAX = 20;
export const LEVEL_START = 5;
export const ERG_MIN = 50;
export const ERG_MAX = 400;
export const ERG_STEP = 10;
export const ERG_START = 100;

/** Level L simulates a slope of (L − 1) %: level 1 is flat, level 20 is 19 %. */
const slopeFor = (level) => level - LEVEL_MIN;

export function create() {
  return { mode: "gears", level: LEVEL_START, ergTarget: ERG_START, ergUsed: false };
}

export function currentOrder(state) {
  return state.mode === "erg"
    ? targetPower(state.ergTarget)
    : trackResistance(slopeFor(state.level));
}

export function safeOrder() {
  return trackResistance(slopeFor(LEVEL_MIN));
}

export function canPress(state, dir) {
  if (state.mode === "erg") {
    return dir === "plus" ? state.ergTarget < ERG_MAX : state.ergTarget > ERG_MIN;
  }
  return dir === "plus" ? state.level < LEVEL_MAX : state.level > LEVEL_MIN;
}

export function press(state, dir) {
  if (!canPress(state, dir)) return { state, order: null };
  const delta = dir === "plus" ? 1 : -1;
  const next =
    state.mode === "erg"
      ? { ...state, ergTarget: state.ergTarget + delta * ERG_STEP }
      : { ...state, level: state.level + delta };
  return { state: next, order: currentOrder(next) };
}

export function setMode(state, mode) {
  const next = { ...state, mode, ergUsed: state.ergUsed || mode === "erg" };
  return { state: next, order: currentOrder(next) };
}
