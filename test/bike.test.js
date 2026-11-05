import assert from "node:assert/strict";
import { test } from "node:test";
import { connectBike } from "../src/ble/bike.js";
import { trackResistance } from "../src/core/fec.js";
import { BKOOL_SERVICE, fakeBkoolBike, fakeBluetooth, fakeClock } from "./fake-ble.js";

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
  assert.ok(prefixes.includes("BKOOL") && prefixes.includes("Bkool"));
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
