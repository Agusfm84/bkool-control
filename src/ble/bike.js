// Bluetooth plumbing for the Bkool Smart Bike (Web Bluetooth). No decisions here: it connects,
// subscribes, turns notifications into readings and writes orders, spaced and latest-wins.
import { parseCadence } from "../core/bkool.js";
import * as cps from "../core/cps.js";

export const BKOOL_SERVICE = "f03eee01-4910-473c-be46-960948c2f59c";
const BKOOL_WRITE = "f03ee002-4910-473c-be46-960948c2f59c";
const BKOOL_NOTIFY_4 = "f03ee004-4910-473c-be46-960948c2f59c";
const BKOOL_NOTIFY_6 = "f03ee006-4910-473c-be46-960948c2f59c";
const CYCLING_POWER = 0x1818;
const POWER_MEASUREMENT = 0x2a63;

/** Minimum time between two writes to the bike. */
export const MIN_WRITE_GAP_MS = 250;

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

function failure(kind, cause) {
  return { kind, cause };
}

/**
 * Asks the user to pick the bike and connects to it.
 * @returns {Promise<Bike>} rejects with {kind: 'unsupported'|'cancelled'|'not-found'}
 */
export async function connectBike({
  bluetooth = globalThis.navigator?.bluetooth,
  clock = defaultClock,
} = {}) {
  if (!bluetooth) throw failure("unsupported");

  let device;
  try {
    device = await bluetooth.requestDevice({
      filters: [{ namePrefix: "BKOOL" }, { namePrefix: "Bkool" }],
      optionalServices: [BKOOL_SERVICE, CYCLING_POWER],
    });
  } catch (err) {
    if (err?.name === "NotFoundError") throw failure("cancelled", err);
    if (err?.name === "SecurityError" || err?.name === "NotSupportedError") {
      throw failure("unsupported", err);
    }
    throw failure("not-found", err);
  }

  const listeners = { data: [], raw: [], link: [] };
  const emit = (type, ...args) => {
    for (const fn of listeners[type]) fn(...args);
  };

  let crank = null;
  let bkoolCadence = null;
  let writeChar = null;

  function onNotify(event) {
    const char = event.target;
    const view = char.value;
    emit("raw", String(char.uuid), view);
    if (char.uuid === BKOOL_NOTIFY_6) {
      const c = parseCadence(view);
      if (c !== null) bkoolCadence = c;
    } else if (char.uuid === POWER_MEASUREMENT) {
      const r = cps.parse(view, crank, clock.now());
      crank = r.crank;
      emit("data", { watts: r.watts, cadence: r.cadence ?? bkoolCadence });
    }
  }

  async function setUp() {
    const server = await device.gatt.connect();
    const bkool = await server.getPrimaryService(BKOOL_SERVICE);
    writeChar = await bkool.getCharacteristic(BKOOL_WRITE);
    const power = await (await server.getPrimaryService(CYCLING_POWER)).getCharacteristic(
      POWER_MEASUREMENT,
    );
    const notifiers = [
      power,
      await bkool.getCharacteristic(BKOOL_NOTIFY_4),
      await bkool.getCharacteristic(BKOOL_NOTIFY_6),
    ];
    for (const c of notifiers) {
      c.removeEventListener("characteristicvaluechanged", onNotify);
      c.addEventListener("characteristicvaluechanged", onNotify);
      await c.startNotifications();
    }
  }

  try {
    await setUp();
  } catch (err) {
    throw failure("not-found", err);
  }

  device.addEventListener("gattserverdisconnected", () => emit("link", "lost"));

  // Latest-wins sender: at most one write every MIN_WRITE_GAP_MS; a newer order replaces a
  // pending one, so fast taps never build up a queue of stale orders.
  let pending = null;
  let timer = null;
  let lastWriteAt = Number.NEGATIVE_INFINITY;

  async function flush() {
    timer = null;
    if (!pending) return;
    const order = pending;
    pending = null;
    lastWriteAt = clock.now();
    try {
      await writeChar.writeValueWithoutResponse(order);
    } catch {
      // Link problems are reported through onLinkChange; the order is simply dropped.
    }
    if (pending) schedule();
  }

  function schedule() {
    if (timer !== null) return;
    const wait = Math.max(0, lastWriteAt + MIN_WRITE_GAP_MS - clock.now());
    timer = clock.setTimeout(flush, wait);
  }

  return {
    name: device.name,
    onData(fn) {
      listeners.data.push(fn);
    },
    onRaw(fn) {
      listeners.raw.push(fn);
    },
    onLinkChange(fn) {
      listeners.link.push(fn);
    },
    send(order) {
      pending = order;
      schedule();
    },
    disconnect() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      pending = null;
      device.gatt.disconnect();
    },
  };
}
