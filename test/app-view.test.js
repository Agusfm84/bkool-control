import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_STALE_MS, fileName, viewFor } from "../src/app-view.js";
import * as control from "../src/core/control.js";
import * as workout from "../src/core/workout.js";

const base = (over = {}) => ({
  supported: true,
  bike: "on",
  strap: "off",
  ctrl: control.create(),
  w: workout.create(),
  latest: { watts: 180, cadence: 88, at: 10_000 },
  hr: null,
  recovered: null,
  confirm: null,
  message: null,
  ...over,
});

test("no Bluetooth in the browser: the unsupported page, whatever else is set", () => {
  assert.equal(viewFor(base({ supported: false }), 10_000).page, "unsupported");
});

test("bike off and no workout: the start page; bike on: the riding page", () => {
  assert.equal(viewFor(base({ bike: "off" }), 10_000).page, "start");
  assert.equal(viewFor(base(), 10_000).page, "riding");
});

test("a workout in progress keeps the riding page even if the bike was disconnected", () => {
  const w = workout.start(workout.create(), 0);
  assert.equal(viewFor(base({ bike: "off", w }), 10_000).page, "riding");
});

test("a finished workout shows the summary; a recovered one shows the recovery page first", () => {
  let w = workout.start(workout.create(), 0);
  w = workout.tick(w, 0, { watts: 150, cadence: 85, hr: null, speedKmh: 30 });
  w = workout.finish(w, 60_000);
  const v = viewFor(base({ w }), 61_000);
  assert.equal(v.page, "summary");
  assert.equal(v.summary.durationS, 60);
  assert.equal(v.canSave, true);
  const r = viewFor(base({ recovered: w, bike: "off" }), 61_000);
  assert.equal(r.page, "recovered");
  assert.equal(r.summary.avgW, 150);
});

test("a workout with no data samples cannot be saved (an empty TCX is invalid)", () => {
  const w = workout.finish(workout.start(workout.create(), 0), 5000);
  assert.equal(viewFor(base({ w }), 6000).canSave, false);
});

test("live numbers come from the latest reading; after 3 s without data they show as unknown", () => {
  const fresh = viewFor(base(), 10_000 + DATA_STALE_MS);
  assert.equal(fresh.watts, 180);
  assert.equal(fresh.cadence, 88);
  assert.ok(fresh.speedKmh > 20);
  const stale = viewFor(base(), 10_000 + DATA_STALE_MS + 1);
  assert.equal(stale.watts, null);
  assert.equal(stale.speedKmh, null);
});

test("heart rate shows only while fresh; '♥ --' (null) without a strap", () => {
  assert.equal(viewFor(base(), 10_000).hr, null);
  assert.equal(viewFor(base({ hr: { bpm: 140, at: 9000 } }), 10_000).hr, 140);
  assert.equal(viewFor(base({ hr: { bpm: 140, at: 1000 } }), 10_000).hr, null);
});

test("lost bike gives the red banner; a lost strap a quiet one; the bike wins", () => {
  assert.equal(viewFor(base({ bike: "lost" }), 10_000).banner.kind, "error");
  assert.match(viewFor(base({ bike: "lost" }), 10_000).banner.text, /Conexión perdida/);
  assert.equal(viewFor(base({ strap: "lost" }), 10_000).banner.kind, "info");
  assert.equal(viewFor(base({ bike: "lost", strap: "lost" }), 10_000).banner.kind, "error");
  const msg = { kind: "info", text: "No se eligió ninguna bici." };
  assert.equal(viewFor(base({ message: msg }), 10_000).banner, msg);
});

test("the control part follows the control state, with the limits", () => {
  const top = { ...control.create(), level: control.LEVEL_MAX };
  const v = viewFor(base({ ctrl: top }), 10_000);
  assert.equal(v.level, 20);
  assert.equal(v.canPlus, false);
  assert.equal(v.canMinus, true);
  const erg = control.setMode(control.create(), "erg").state;
  assert.equal(viewFor(base({ ctrl: erg }), 10_000).ergTarget, 100);
});

test("timer excludes pauses and the questions have Spanish texts", () => {
  let w = workout.start(workout.create(), 0);
  w = workout.pause(w, 60_000);
  w = workout.resume(w, 90_000);
  assert.equal(viewFor(base({ w }), 150_000).timeMs, 120_000);
  assert.deepEqual(viewFor(base({ w, confirm: "finish" }), 150_000).confirm, {
    text: "¿Terminar el entrenamiento?",
    yes: "Sí, terminar",
  });
  assert.match(viewFor(base({ confirm: "discard" }), 0).confirm.text, /Descartar/);
  assert.match(viewFor(base({ confirm: "bike-off" }), 0).confirm.text, /Desconectar/);
});

test("the file is named after the local start time", () => {
  const start = new Date(2026, 10, 5, 19, 7).getTime();
  assert.equal(fileName(start), "bkool-2026-11-05-1907.tcx");
});
