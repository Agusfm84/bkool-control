import assert from "node:assert/strict";
import { test } from "node:test";
import { CHOOSER_RETRY_MS } from "../src/ble/bike.js";
import { connectStrap } from "../src/ble/hr.js";
import { fakeBluetooth, fakeClock, fakeHrStrap, HR_SERVICE } from "./fake-ble.js";

const settle = () => new Promise((r) => setImmediate(r));

async function connected(opts) {
  const strap = fakeHrStrap();
  const bluetooth = fakeBluetooth(strap.device, opts);
  const clock = fakeClock();
  const conn = await connectStrap({ bluetooth, clock });
  return { ...strap, bluetooth, clock, conn };
}

test("no Web Bluetooth: rejects with kind unsupported", async () => {
  await assert.rejects(connectStrap({ bluetooth: undefined }), { kind: "unsupported" });
});

test("chooser closed: rejects with kind cancelled and is not retried", async () => {
  const strap = fakeHrStrap();
  const err = Object.assign(new Error("User cancelled"), { name: "NotFoundError" });
  const bluetooth = fakeBluetooth(strap.device, { requestError: err });
  await assert.rejects(connectStrap({ bluetooth, clock: fakeClock() }), { kind: "cancelled" });
  assert.equal(bluetooth.requests.length, 1);
});

test("a bare-number rejection is retried once after a pause", async () => {
  const strap = fakeHrStrap();
  const bluetooth = fakeBluetooth(strap.device, { requestError: 2, failTimes: 1 });
  const clock = fakeClock();
  const pending = connectStrap({ bluetooth, clock });
  await settle();
  assert.equal(bluetooth.requests.length, 1);
  await clock.advance(CHOOSER_RETRY_MS);
  const conn = await pending;
  assert.equal(bluetooth.requests.length, 2);
  assert.equal(conn.name, "FakeStrap 1234");
});

test("any other request failure: rejects with kind not-found", async () => {
  const strap = fakeHrStrap();
  const bluetooth = fakeBluetooth(strap.device, { requestError: new Error("boom") });
  await assert.rejects(connectStrap({ bluetooth, clock: fakeClock() }), { kind: "not-found" });
});

test("request filters on the Heart Rate service as a full 128-bit string", async () => {
  const { bluetooth, device } = await connected();
  const opts = bluetooth.requests[0];
  assert.deepEqual(opts.filters, [{ services: [HR_SERVICE] }]);
  assert.ok(opts.optionalServices.includes(HR_SERVICE));
  for (const u of device.gatt.asked) assert.match(u, /^[0-9a-f]{8}-0000-1000-8000-00805f9b34fb$/);
  assert.ok(device.gatt.asked.length >= 2);
});

test("emits bpm from the 0x2A37 notifications (u8 and u16)", async () => {
  const { hr, conn } = await connected();
  assert.equal(hr.notifying, true);
  const got = [];
  conn.onHr((bpm) => got.push(bpm));
  hr.emit(0x00, 72);
  hr.emit(0x01, 0x2c, 0x01);
  assert.deepEqual(got, [72, 300]);
});

test("link loss: 'lost', retries after 1, 2, 4 s, then 'back' and bpm flows again", async () => {
  const { device, hr, clock, conn } = await connected();
  const events = [];
  const got = [];
  conn.onLinkChange((e) => events.push(e));
  conn.onHr((b) => got.push(b));
  device.gatt.failNextConnects = 2;
  const before = device.connectCalls;
  device.simulateLinkLoss();
  assert.deepEqual(events, ["lost"]);
  await clock.advance(999);
  assert.equal(device.connectCalls, before);
  await clock.advance(1); // 1 s: fails
  assert.equal(device.connectCalls, before + 1);
  await clock.advance(1999);
  assert.equal(device.connectCalls, before + 1);
  await clock.advance(1); // +2 s: fails
  assert.equal(device.connectCalls, before + 2);
  await clock.advance(3999);
  assert.equal(device.connectCalls, before + 2);
  assert.deepEqual(events, ["lost"]);
  await clock.advance(1); // +4 s: succeeds
  assert.equal(device.connectCalls, before + 3);
  assert.deepEqual(events, ["lost", "back"]);
  hr.emit(0x00, 80);
  assert.deepEqual(got, [80]);
});

test("retry waits grow 1, 2, 4, 8, 10, 10 s", async () => {
  const { device, clock, conn } = await connected();
  conn.onLinkChange(() => {});
  device.gatt.failNextConnects = 99;
  const before = device.connectCalls;
  device.simulateLinkLoss();
  for (const [i, wait] of [1000, 2000, 4000, 8000, 10000, 10000].entries()) {
    await clock.advance(wait - 1);
    assert.equal(device.connectCalls, before + i, `before attempt ${i + 1}`);
    await clock.advance(1);
    assert.equal(device.connectCalls, before + i + 1, `attempt ${i + 1}`);
  }
});

test("a deliberate disconnect is not reported as lost and stops the retries", async () => {
  const { device, clock, conn } = await connected();
  const events = [];
  conn.onLinkChange((e) => events.push(e));
  device.gatt.failNextConnects = 99;
  device.simulateLinkLoss();
  const calls = device.connectCalls;
  conn.disconnect();
  assert.equal(clock.pendingTimers(), 0, "the retry timer is cancelled, not just ignored");
  await clock.advance(60000);
  assert.equal(device.connectCalls, calls);
  assert.deepEqual(events, ["lost"]);
});

test("disconnect on a healthy link emits nothing", async () => {
  const { conn, clock } = await connected();
  const events = [];
  conn.onLinkChange((e) => events.push(e));
  conn.disconnect();
  await clock.advance(60000);
  assert.deepEqual(events, []);
});

test("a screen listener that throws on 'lost' does not stop the reconnection", async () => {
  const { device, clock, conn } = await connected();
  const events = [];
  conn.onLinkChange(() => {
    throw new Error("screen bug");
  });
  conn.onLinkChange((e) => events.push(e));
  device.simulateLinkLoss();
  await clock.advance(1000);
  assert.deepEqual(events, ["lost", "back"]);
});

test("bpm 0 (strap without skin contact) is reported as no reading", async () => {
  const { hr, conn } = await connected();
  const seen = [];
  conn.onHr((b) => seen.push(b));
  hr.emit(0x00, 0);
  hr.emit(0x00, 75);
  assert.deepEqual(seen, [null, 75]);
});
