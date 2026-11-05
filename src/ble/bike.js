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
/** Times a failed write is retried before the order is dropped. */
const MAX_WRITE_RETRIES = 3;

/** Browsers report every UUID as a lowercase 128-bit string: 0x2a63 → "00002a63-0000-…". */
export function canonicalUuid(uuid) {
  if (typeof uuid === "number") {
    return `${uuid.toString(16).padStart(8, "0")}-0000-1000-8000-00805f9b34fb`;
  }
  return String(uuid).toLowerCase();
}

const POWER_UUID = canonicalUuid(POWER_MEASUREMENT);

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

/** step: where it failed (choose, connect, bkool-service, power-service, …) for the spike log. */
function failure(kind, cause, step) {
  return { kind, cause, step };
}

/**
 * Asks the user to pick the bike and connects to it.
 * @param {{bluetooth?: Bluetooth, clock?: object}} [options] injectable for tests
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
      // namePrefix is case-sensitive in Web Bluetooth, so list the spellings in use.
      filters: [{ namePrefix: "BKOOL" }, { namePrefix: "Bkool" }, { namePrefix: "bkool" }],
      optionalServices: [BKOOL_SERVICE, CYCLING_POWER],
    });
  } catch (err) {
    if (err?.name === "NotFoundError") throw failure("cancelled", err);
    if (err?.name === "SecurityError" || err?.name === "NotSupportedError") {
      throw failure("unsupported", err);
    }
    throw failure("not-found", err, "choose");
  }

  const listeners = { data: [], raw: [], link: [], write: [] };
  const emit = (type, ...args) => {
    for (const fn of listeners[type]) fn(...args);
  };

  let crank = null;
  let bkoolCadence = null;
  let writeChar = null;
  let closing = false;

  function onNotify(event) {
    const char = event.target;
    const uuid = canonicalUuid(char.uuid);
    const view = char.value;
    emit("raw", uuid, view);
    if (uuid === BKOOL_NOTIFY_6) {
      const c = parseCadence(view);
      if (c !== null) bkoolCadence = c;
    } else if (uuid === POWER_UUID) {
      const r = cps.parse(view, crank, clock.now());
      crank = r.crank;
      // The Bkool's own channel first: on the real bike the standard crank data is always 0.
      emit("data", { watts: r.watts, cadence: bkoolCadence ?? r.cadence });
    }
  }

  /** Connects and subscribes. Safe to call again after a lost link (used by reconnect). */
  let step = "connect";
  async function setUp() {
    crank = null;
    bkoolCadence = null;
    step = "connect";
    const server = await device.gatt.connect();
    step = "bkool-service";
    const bkool = await server.getPrimaryService(BKOOL_SERVICE);
    step = "bkool-write";
    writeChar = await bkool.getCharacteristic(BKOOL_WRITE);
    step = "power-service";
    const powerService = await server.getPrimaryService(CYCLING_POWER);
    step = "characteristics";
    const notifiers = [
      ["power-notify", await powerService.getCharacteristic(POWER_MEASUREMENT)],
      ["bkool-notify-4", await bkool.getCharacteristic(BKOOL_NOTIFY_4)],
      ["bkool-notify-6", await bkool.getCharacteristic(BKOOL_NOTIFY_6)],
    ];
    for (const [name, c] of notifiers) {
      step = name;
      c.removeEventListener("characteristicvaluechanged", onNotify);
      c.addEventListener("characteristicvaluechanged", onNotify);
      await c.startNotifications();
    }
  }

  device.addEventListener("gattserverdisconnected", () => {
    if (!closing) emit("link", "lost");
  });

  try {
    await setUp();
  } catch (err) {
    closing = true;
    device.gatt.disconnect();
    throw failure("not-found", err, step);
  }

  // Latest-wins sender: at most one write every MIN_WRITE_GAP_MS; a newer order replaces a
  // pending one, so fast taps never build up a queue of stale orders. A failed write is
  // retried a few times unless a newer order arrived meanwhile.
  let pending = null;
  let retries = 0;
  let timer = null;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let writeSeq = 0; // increases on every write attempt; a late failure of an older write is ignored

  async function flush() {
    timer = null;
    if (!pending || closing) return;
    const order = pending;
    pending = null;
    lastWriteAt = clock.now();
    const mySeq = ++writeSeq;
    try {
      await writeChar.writeValueWithoutResponse(order);
      retries = 0;
      emit("write", order, true);
    } catch {
      if (mySeq === writeSeq && !pending && retries < MAX_WRITE_RETRIES) {
        retries++;
        pending = order;
      } else {
        retries = 0;
        emit("write", order, false);
      }
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
    /** fn(order, ok): ok=true once an order is written; false when it is dropped after retries. */
    onWrite(fn) {
      listeners.write.push(fn);
    },
    send(order) {
      pending = order;
      retries = 0;
      schedule();
    },
    disconnect() {
      closing = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      pending = null;
      device.gatt.disconnect();
    },
  };
}
