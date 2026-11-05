import assert from "node:assert/strict";
import { test } from "node:test";
import { create, finish, pause, start, tick } from "../src/core/workout.js";
import { createRecovery } from "../src/store/recovery.js";

const fakeStorage = () => {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
};

const throwing = () => {
  const boom = () => {
    throw new Error("QuotaExceededError");
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
};

const reading = (watts, hr = null) => ({ watts, cadence: 80, hr, speedKmh: 30 });

// 3 s recorded with a gap in the middle.
const recorded = () => {
  let w = start(create(), 0);
  w = tick(w, 0, reading(150, 120));
  w = tick(w, 1000, null);
  w = tick(w, 2000, reading(200));
  return w;
};

test("save then load (new instance, same storage) returns an equal running workout", () => {
  const storage = fakeStorage();
  const w = recorded();
  assert.equal(createRecovery(storage).save(w), true);
  assert.deepEqual(createRecovery(storage).load(), w);
});

test("a paused workout round-trips", () => {
  const storage = fakeStorage();
  const w = pause(recorded(), 2500);
  const r = createRecovery(storage);
  assert.equal(r.save(w), true);
  assert.deepEqual(r.load(), w);
});

test("a finished, not yet downloaded workout round-trips (spec: 'during or after')", () => {
  const storage = fakeStorage();
  const w = finish(recorded(), 3000);
  const r = createRecovery(storage);
  assert.equal(r.save(w), true);
  assert.deepEqual(r.load(), w);
});

test("clear then load returns null", () => {
  const r = createRecovery(fakeStorage());
  r.save(recorded());
  assert.equal(r.clear(), true);
  assert.equal(r.load(), null);
});

test("saving an idle workout is a no-op: it does not erase a pending recovery", () => {
  const r = createRecovery(fakeStorage());
  const w = recorded();
  r.save(w);
  assert.equal(r.save(create()), false);
  assert.deepEqual(r.load(), w);
});

test("save ignores null/undefined", () => {
  const r = createRecovery(fakeStorage());
  assert.equal(r.save(null), false);
  assert.equal(r.save(undefined), false);
  assert.equal(r.load(), null);
});

test("load of nothing, corrupted JSON, or an unknown shape returns null", () => {
  const storage = fakeStorage();
  const r = createRecovery(storage);
  assert.equal(r.load(), null);
  r.save(recorded());
  const [key] = [...storage.data.keys()];
  const stored = JSON.parse(storage.data.get(key));
  const bad = [
    "{not json",
    "null",
    "42",
    '"text"',
    "[]",
    JSON.stringify({ ...stored, v: 999 }),
    JSON.stringify({ ...stored, v: undefined }),
    JSON.stringify({ v: stored.v, workout: null }),
    JSON.stringify({ v: stored.v, workout: { status: "idle" } }),
    JSON.stringify({ v: stored.v, workout: { status: "running", samples: "x" } }),
    JSON.stringify({ v: stored.v, workout: { status: "bogus", samples: [] } }),
  ];
  for (const raw of bad) {
    storage.data.set(key, raw);
    assert.equal(r.load(), null, raw);
  }
});

test("a throwing storage never throws and reports failure", () => {
  const r = createRecovery(throwing());
  assert.equal(r.save(recorded()), false);
  assert.equal(r.load(), null);
  assert.equal(r.clear(), false);
});

test("missing storage never throws", () => {
  const r = createRecovery(undefined);
  assert.equal(r.save(recorded()), false);
  assert.equal(r.load(), null);
  assert.equal(r.clear(), false);
});

test("a storage that returns non-string junk does not throw", () => {
  const r = createRecovery({ getItem: () => ({}), setItem() {}, removeItem() {} });
  assert.equal(r.load(), null);
});

test("stored data carries a version field", () => {
  const storage = fakeStorage();
  createRecovery(storage).save(recorded());
  const [raw] = [...storage.data.values()];
  assert.equal(typeof JSON.parse(raw).v, "number");
});
