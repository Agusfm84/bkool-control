import assert from "node:assert/strict";
import { test } from "node:test";
import { connectBike } from "../src/ble/bike.js";
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
  assert.ok(opts.optionalServices.includes(0x1818));
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
