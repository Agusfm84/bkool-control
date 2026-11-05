import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalUuid as bikeUuid, connectBike } from "../src/ble/bike.js";
import { trackResistance } from "../src/core/fec.js";
import {
  BKOOL_SERVICE,
  canonicalUuid,
  fakeBkoolBike,
  fakeBluetooth,
  fakeClock,
} from "./fake-ble.js";

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const settle = () => new Promise((r) => setImmediate(r));
/** Lets time pass in small steps, so timers scheduled after an await are reached too. */
async function run(clock, ms, step = 50) {
  for (let t = 0; t < ms; t += step) {
    await settle();
    await clock.advance(step);
  }
}

async function connected() {
  const bike = fakeBkoolBike();
  const bluetooth = fakeBluetooth(bike.device);
  const clock = fakeClock();
  const conn = await connectBike({ bluetooth, clock });
  return { ...bike, bluetooth, clock, conn };
}

test("no Web Bluetooth: rejects with kind unsupported", async () => {
  await assert.rejects(connectBike({ bluetooth: undefined }), { kind: "unsupported" });
});

test("chooser closed: rejects with kind cancelled", async () => {
  const bike = fakeBkoolBike();
  const err = Object.assign(new Error("User cancelled"), { name: "NotFoundError" });
  await assert.rejects(
    connectBike({ bluetooth: fakeBluetooth(bike.device, { requestError: err }) }),
    { kind: "cancelled" },
  );
});

test("device request filters on Bkool name prefixes and asks for both services", async () => {
  const { bluetooth } = await connected();
  const opts = bluetooth.requests[0];
  const prefixes = opts.filters.map((f) => f.namePrefix);
  for (const p of ["BKOOL", "Bkool", "bkool"]) assert.ok(prefixes.includes(p), `missing ${p}`);
  assert.ok(opts.optionalServices.includes(BKOOL_SERVICE));
  assert.ok(opts.optionalServices.includes("00001818-0000-1000-8000-00805f9b34fb"));
});

test("subscribes to the power measurement and both Bkool notify channels", async () => {
  const { power, n4, n6 } = await connected();
  assert.ok(power.notifying && n4.notifying && n6.notifying);
});

test("emits watts and cadence from the bike notifications", async () => {
  const { conn, power, n6 } = await connected();
  const seen = [];
  conn.onData((d) => seen.push(d));
  n6.emit(0, 0, 0xa8, 0x0c, 0); // Bkool cadence 90 rpm
  power.emit(0x00, 0x00, 0xb4, 0x00); // 180 W, no crank data
  assert.deepEqual(seen.at(-1), { watts: 180, cadence: 90 });
});

test("raw notifications are available for the spike page", async () => {
  const { conn, n4 } = await connected();
  const raw = [];
  conn.onRaw((uuid, view) => raw.push([uuid, view.byteLength]));
  n4.emit(1, 2, 3);
  assert.deepEqual(raw, [["f03ee004-4910-473c-be46-960948c2f59c", 3]]);
});

test("a burst of orders sent at once becomes one write of the last order", async () => {
  const { conn, write, clock } = await connected();
  for (const slope of [1, 2, 3, 4, 5]) conn.send(trackResistance(slope));
  await clock.advance(300);
  assert.equal(write.writes.length, 1);
  assert.equal(hex(write.writes[0]), hex(trackResistance(5)));
});

test("orders are spaced at least 250 ms apart and the newest wins", async () => {
  const { conn, write, clock } = await connected();
  conn.send(trackResistance(1));
  await clock.advance(0);
  for (const slope of [2, 3, 4]) {
    conn.send(trackResistance(slope));
    await clock.advance(25);
  }
  assert.equal(write.writes.length, 1); // only the first so far
  await clock.advance(250);
  assert.equal(write.writes.length, 2);
  assert.equal(hex(write.writes[1]), hex(trackResistance(4)));
});

test("link loss is reported as lost", async () => {
  const { conn, device } = await connected();
  const events = [];
  conn.onLinkChange((e) => events.push(e));
  device.simulateLinkLoss();
  await settle();
  assert.equal(events[0], "lost");
});

test("the fake reports 128-bit lowercase uuids like a browser", async () => {
  const { power } = await connected();
  assert.equal(power.uuid, "00002a63-0000-1000-8000-00805f9b34fb");
  assert.equal(canonicalUuid(0x1818), "00001818-0000-1000-8000-00805f9b34fb");
});

test("a deliberate disconnect is not reported as a lost link", async () => {
  const { conn } = await connected();
  const events = [];
  conn.onLinkChange((e) => events.push(e));
  conn.disconnect();
  await settle();
  assert.deepEqual(events, []);
});

test("a failed write is retried so the bike does not miss the order", async () => {
  const { conn, write, clock } = await connected();
  write.failNextWrites = 1;
  conn.send(trackResistance(7));
  await clock.advance(0);
  assert.equal(write.writes.length, 0);
  await clock.advance(250);
  assert.equal(write.writes.length, 1);
  assert.equal(hex(write.writes[0]), hex(trackResistance(7)));
});

test("a persistent write failure gives up after a few retries", async () => {
  const { conn, write, clock } = await connected();
  write.failNextWrites = 99;
  conn.send(trackResistance(7));
  await clock.advance(5000);
  assert.equal(write.failNextWrites, 99 - 4); // 1 attempt + 3 retries, then the order is dropped
});

test("if a service is missing after connecting, the link is closed again", async () => {
  const bike = fakeBkoolBike();
  bike.device.missingService = BKOOL_SERVICE;
  await assert.rejects(connectBike({ bluetooth: fakeBluetooth(bike.device), clock: fakeClock() }), {
    kind: "not-found",
  });
  assert.equal(bike.device.gatt.connected, false);
});

test("a slow failed write is not retried after a newer order was already written", async () => {
  const { conn, write, clock } = await connected();
  let rejectFirst;
  const realWrite = write.writeValueWithoutResponse.bind(write);
  let calls = 0;
  write.writeValueWithoutResponse = (bytes) => {
    calls++;
    if (calls === 1) return new Promise((_, reject) => (rejectFirst = reject)); // hangs, then fails
    return realWrite(bytes);
  };
  conn.send(trackResistance(1)); // A
  clock.advance(0); // A in flight (do not await: it never resolves by itself)
  await settle();
  conn.send(trackResistance(2)); // B
  await clock.advance(300); // B written
  rejectFirst(Object.assign(new Error("late failure"), { name: "NetworkError" }));
  await settle();
  await clock.advance(1000);
  assert.equal(hex(write.writes.at(-1)), hex(trackResistance(2)));
});

test("onWrite confirms each order actually written, and reports a dropped one", async () => {
  const { conn, write, clock } = await connected();
  const results = [];
  conn.onWrite((order, ok) => results.push([hex(order), ok]));
  conn.send(trackResistance(3));
  await clock.advance(300);
  assert.deepEqual(results, [[hex(trackResistance(3)), true]]);
  write.failNextWrites = 99;
  conn.send(trackResistance(4));
  await clock.advance(5000);
  assert.deepEqual(results.at(-1), [hex(trackResistance(4)), false]);
  assert.equal(results.filter(([, ok]) => !ok).length, 1); // reported once, after the last retry
});

test("cadence comes from the Bkool channel even when the power channel sends zero crank data", async () => {
  // Real bike (spike 2026-11-05): crank revolutions and time in 0x2A63 are always 0.
  const { conn, power, n6, clock } = await connected();
  const seen = [];
  conn.onData((d) => seen.push(d));
  const zeroCrank = () => power.emit(0x30, 0x00, 0x96, 0x00, 4, 0, 0, 0, 0, 0x40, 0, 0, 0, 0);
  n6.emit(0x96, 0x00, 0x42, 0x0d, 0x5d); // 3394 / 36 = 94 rpm
  zeroCrank();
  await clock.advance(4000);
  n6.emit(0x96, 0x00, 0x42, 0x0d, 0x5d);
  zeroCrank();
  assert.deepEqual(seen.at(-1), { watts: 150, cadence: 94 });
});

test("a chooser failure with no error name says it happened while choosing", async () => {
  const bike = fakeBkoolBike();
  await assert.rejects(
    connectBike({ bluetooth: fakeBluetooth(bike.device, { requestError: "weird" }) }),
    { kind: "not-found", step: "choose" },
  );
});

test("a set-up failure says which step failed", async () => {
  const bike = fakeBkoolBike();
  bike.device.missingService = "00001818-0000-1000-8000-00805f9b34fb";
  await assert.rejects(connectBike({ bluetooth: fakeBluetooth(bike.device) }), {
    kind: "not-found",
    step: "power-service",
  });
});

test("every uuid asked to the browser is a full 128-bit string (Bluefy rejects short numbers)", async () => {
  const { bluetooth, device } = await connected();
  for (const u of bluetooth.requests[0].optionalServices) assert.equal(typeof u, "string");
  for (const u of device.gatt.asked) assert.equal(typeof u, "string", `asked ${u}`);
});

test("a bare status number from the chooser is retried once after a pause", async () => {
  const bike = fakeBkoolBike();
  const bluetooth = fakeBluetooth(bike.device, { requestError: 2, failTimes: 1 });
  const clock = fakeClock();
  const pending = connectBike({ bluetooth, clock });
  await settle();
  assert.equal(bluetooth.requests.length, 1);
  await clock.advance(1200);
  const conn = await pending;
  assert.equal(bluetooth.requests.length, 2);
  assert.equal(conn.name, bike.device.name);
});

test("a cancelled chooser is not retried", async () => {
  const bike = fakeBkoolBike();
  const err = Object.assign(new Error("User cancelled"), { name: "NotFoundError" });
  const bluetooth = fakeBluetooth(bike.device, { requestError: err });
  await assert.rejects(connectBike({ bluetooth, clock: fakeClock() }), { kind: "cancelled" });
  assert.equal(bluetooth.requests.length, 1);
});

test("the chooser is retried only once: a second bare number fails while choosing", async () => {
  const bike = fakeBkoolBike();
  const bluetooth = fakeBluetooth(bike.device, { requestError: 2 });
  const clock = fakeClock();
  const pending = connectBike({ bluetooth, clock });
  const outcome = assert.rejects(pending, { kind: "not-found", step: "choose", cause: 2 });
  await settle();
  await clock.advance(5000);
  await outcome;
  assert.equal(bluetooth.requests.length, 2);
});

test("short uuid strings, as Bluefy reports them, are expanded to the full form", () => {
  assert.equal(bikeUuid("2a63"), "00002a63-0000-1000-8000-00805f9b34fb");
  assert.equal(bikeUuid("2A63"), "00002a63-0000-1000-8000-00805f9b34fb");
  assert.equal(bikeUuid("00002a63"), "00002a63-0000-1000-8000-00805f9b34fb");
  assert.equal(
    bikeUuid("F03EE006-4910-473C-BE46-960948C2F59C"),
    "f03ee006-4910-473c-be46-960948c2f59c",
  );
  assert.equal(bikeUuid(0x180), "00000180-0000-1000-8000-00805f9b34fb");
});

test("watts and cadence arrive when the browser names the power channel '2a63' (Bluefy)", async () => {
  // Real iPhone log 2026-11-05: Bluefy reports the characteristic uuid as "2a63".
  const { conn, power, n6 } = await connected();
  power.uuid = "2a63";
  const seen = [];
  conn.onData((d) => seen.push(d));
  n6.emit(0x96, 0x00, 0x42, 0x0d, 0x5d); // 94 rpm
  power.emit(0x30, 0x00, 0x96, 0x00, 4, 0, 0, 0, 0, 0x40, 0, 0, 0, 0); // 150 W
  assert.deepEqual(seen.at(-1), { watts: 150, cadence: 94 });
});

// --- T014: reconnect, re-send, safe disconnect -------------------------------------------

test("link loss: 'lost', retries after 1, 2, 4 s, then 'back' and the last order is re-sent", async () => {
  const { conn, device, write, clock } = await connected();
  const events = [];
  conn.onLinkChange((e) => events.push(e));
  conn.send(trackResistance(6));
  await clock.advance(300);
  const writesBefore = write.writes.length;
  device.gatt.failNextConnects = 2;
  const calls = device.connectCalls;
  device.simulateLinkLoss();
  assert.deepEqual(events, ["lost"]);
  await clock.advance(999);
  assert.equal(device.connectCalls, calls);
  await clock.advance(1); // 1 s: fails
  await clock.advance(2000); // +2 s: fails
  assert.equal(device.connectCalls, calls + 2);
  await clock.advance(3999);
  assert.deepEqual(events, ["lost"]);
  await clock.advance(1); // +4 s: succeeds
  assert.deepEqual(events, ["lost", "back"]);
  await clock.advance(300);
  assert.equal(write.writes.length, writesBefore + 1);
  assert.equal(hex(write.writes.at(-1)), hex(trackResistance(6)));
});

test("an order given while the link is down is the one sent when it comes back", async () => {
  const { conn, device, write, clock } = await connected();
  conn.send(trackResistance(3));
  await clock.advance(300);
  device.simulateLinkLoss();
  conn.send(trackResistance(9)); // rider taps + while the bike is away
  await clock.advance(500);
  assert.equal(hex(write.writes.at(-1)), hex(trackResistance(3)), "nothing written while down");
  await clock.advance(1000); // reconnects
  await clock.advance(300);
  assert.equal(hex(write.writes.at(-1)), hex(trackResistance(9)));
});

test("disconnect writes level 1 (slope 0 %) before closing the link", async () => {
  const { conn, device, write, clock } = await connected();
  conn.send(trackResistance(10));
  await clock.advance(300);
  let writesWhenClosed = null;
  device.addEventListener("gattserverdisconnected", () => {
    writesWhenClosed = write.writes.map(hex);
  });
  await conn.disconnect();
  assert.equal(writesWhenClosed?.at(-1), hex(trackResistance(0)));
  assert.equal(device.gatt.connected, false);
});

test("disconnect while reconnecting stops the retries and leaves no timer", async () => {
  const { conn, device, clock } = await connected();
  const events = [];
  conn.onLinkChange((e) => events.push(e));
  device.gatt.failNextConnects = 99;
  device.simulateLinkLoss();
  await clock.advance(1000);
  const calls = device.connectCalls;
  await conn.disconnect();
  assert.equal(clock.pendingTimers(), 0);
  await clock.advance(60000);
  assert.equal(device.connectCalls, calls);
  assert.deepEqual(events, ["lost"]);
});

test("a screen listener that throws does not stop the bike from reconnecting", async () => {
  const { conn, device, clock } = await connected();
  const events = [];
  conn.onLinkChange(() => {
    throw new Error("screen bug");
  });
  conn.onLinkChange((e) => events.push(e));
  device.simulateLinkLoss();
  await clock.advance(1000);
  assert.deepEqual(events, ["lost", "back"]);
});

test("reconnect waits grow 1, 2, 4, 8, 10, 10 s (never more than 10 s)", async () => {
  const { device, clock, conn } = await connected();
  conn.onLinkChange(() => {});
  device.gatt.failNextConnects = 99;
  const before = device.connectCalls;
  device.simulateLinkLoss();
  for (const [i, wait] of [1000, 2000, 4000, 8000, 10000, 10000, 10000].entries()) {
    await clock.advance(wait - 1);
    assert.equal(device.connectCalls, before + i, `before attempt ${i + 1}`);
    await clock.advance(1);
    assert.equal(device.connectCalls, before + i + 1, `attempt ${i + 1}`);
  }
});

test("disconnect waits for a write in flight and keeps the gap before the safe order", async () => {
  const { conn, write, clock } = await connected();
  let release;
  const realWrite = write.writeValueWithoutResponse.bind(write);
  let calls = 0;
  write.writeValueWithoutResponse = (bytes) => {
    calls++;
    if (calls === 1) {
      return new Promise((resolve) => {
        release = () => resolve(realWrite(bytes));
      });
    }
    return realWrite(bytes);
  };
  conn.send(trackResistance(12));
  const started = clock.advance(0); // write of level 13 starts and hangs (the fake clock awaits it)
  await settle();
  const done = conn.disconnect();
  await settle();
  assert.equal(calls, 1, "no second write while the first is in flight");
  release();
  await started;
  await run(clock, 200);
  assert.equal(write.writes.length, 1, "the safe order waits the 250 ms gap");
  await run(clock, 300);
  await done;
  assert.deepEqual(write.writes.map(hex), [hex(trackResistance(12)), hex(trackResistance(0))]);
});

test("a failed safe order is retried before the link is closed", async () => {
  const { conn, write, device, clock } = await connected();
  write.failNextWrites = 2;
  const done = conn.disconnect();
  await run(clock, 1000);
  await done;
  assert.equal(hex(write.writes.at(-1)), hex(trackResistance(0)));
  assert.equal(device.gatt.connected, false);
});

test("disconnect drops an order not yet written; while the link is down it writes nothing", async () => {
  const a = await connected();
  a.conn.send(trackResistance(1));
  await a.clock.advance(300);
  a.conn.send(trackResistance(15)); // queued, not yet written when disconnect() is called
  const d = a.conn.disconnect();
  await run(a.clock, 1000);
  await d;
  assert.ok(!a.write.writes.map(hex).includes(hex(trackResistance(15))));

  const b = await connected();
  b.device.gatt.failNextConnects = 99;
  b.device.simulateLinkLoss();
  const writes = b.write.writes.length;
  await b.conn.disconnect();
  assert.equal(b.write.writes.length, writes);
});

test("a disconnect that never settles still closes the link after a short wait", async () => {
  const { conn, write, device, clock } = await connected();
  write.writeValueWithoutResponse = () => new Promise(() => {}); // stalled radio
  const done = conn.disconnect();
  await run(clock, 3000);
  await done;
  assert.equal(device.gatt.connected, false);
});

test("after a disconnect times out, the safe order is not retried on the closed link", async () => {
  const { conn, write, clock } = await connected();
  let rejectSlow;
  const realWrite = write.writeValueWithoutResponse.bind(write);
  write.writeValueWithoutResponse = () =>
    new Promise((_, reject) => {
      rejectSlow = reject;
    });
  const done = conn.disconnect();
  await run(clock, 2500); // timeout wins
  await done;
  write.writeValueWithoutResponse = realWrite;
  rejectSlow(new Error("late failure"));
  await run(clock, 2000);
  assert.equal(write.writes.length, 0, "no write after the link was closed");
  assert.equal(clock.pendingTimers(), 0, "no timer left behind");
});

test("a second disconnect waits for the first one", async () => {
  const { conn } = await connected();
  const first = conn.disconnect();
  assert.equal(conn.disconnect(), first);
  await first;
});

test("disconnect during a reconnect set-up waits for it, then sends level 1 before closing", async () => {
  const { conn, device, write, clock } = await connected();
  device.simulateLinkLoss();
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  const realGetService = device.gatt.getPrimaryService.bind(device.gatt);
  device.gatt.getPrimaryService = async (uuid) => {
    await gate; // the services answer slowly
    return realGetService(uuid);
  };
  const retry = clock.advance(1000); // reconnect: connect() succeeds, set-up hangs on services
  await settle();
  assert.equal(device.gatt.connected, true);
  const done = conn.disconnect();
  openGate();
  await retry;
  await run(clock, 1000);
  await done;
  assert.equal(hex(write.writes.at(-1)), hex(trackResistance(0)));
  assert.equal(device.gatt.connected, false);
});

test("a reconnect that finishes after disconnect gave up is closed again", async () => {
  const { conn, device, clock } = await connected();
  device.simulateLinkLoss();
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  const realGetService = device.gatt.getPrimaryService.bind(device.gatt);
  device.gatt.getPrimaryService = async (uuid) => {
    await gate;
    return realGetService(uuid);
  };
  const retry = clock.advance(1000); // reconnect set-up hangs
  await settle();
  const done = conn.disconnect();
  await run(clock, 2500); // the 2 s limit passes
  await done;
  device.gatt.connected = true; // the stalled set-up finally gets through
  openGate();
  await retry;
  await settle();
  assert.equal(device.gatt.connected, false, "the late reconnect is closed");
  assert.equal(clock.pendingTimers(), 0);
});
