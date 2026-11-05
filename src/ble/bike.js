// Bluetooth plumbing for the Bkool Smart Bike (Web Bluetooth). No decisions here: it connects,
// subscribes, turns notifications into readings and writes orders, spaced and latest-wins.
import { parseCadence } from "../core/bkool.js";
import * as cps from "../core/cps.js";
import { trackResistance } from "../core/fec.js";

export const BKOOL_SERVICE = "f03eee01-4910-473c-be46-960948c2f59c";
const BKOOL_WRITE = "f03ee002-4910-473c-be46-960948c2f59c";
const BKOOL_NOTIFY_4 = "f03ee004-4910-473c-be46-960948c2f59c";
const BKOOL_NOTIFY_6 = "f03ee006-4910-473c-be46-960948c2f59c";

/** Minimum time between two writes to the bike. */
export const MIN_WRITE_GAP_MS = 250;
/** Waits between reconnect attempts after a lost link: 1 s, 2 s, 4 s, 8 s, then 10 s for ever. */
export const RECONNECT_WAITS_MS = [1000, 2000, 4000, 8000, 10000];
/** Longest wait for the safe order on disconnect before the link is closed anyway. */
export const DISCONNECT_TIMEOUT_MS = 2000;
/** Times a failed write is retried before the order is dropped. */
const MAX_WRITE_RETRIES = 3;

/**
 * One spelling for every UUID: lowercase 128-bit. Chrome reports "00002a63-0000-…", but Bluefy
 * (iPhone) reports short strings like "2a63"; numbers (0x2a63) and short hex are expanded.
 */
export function canonicalUuid(uuid) {
  const short =
    typeof uuid === "number" ? uuid.toString(16).padStart(8, "0") : String(uuid).toLowerCase();
  if (/^[0-9a-f]{4}$|^[0-9a-f]{8}$/.test(short)) {
    return `${short.padStart(8, "0")}-0000-1000-8000-00805f9b34fb`;
  }
  return short;
}

// Always full 128-bit strings when talking to the browser: Bluefy (iPhone) rejects short numbers.
const CYCLING_POWER = canonicalUuid(0x1818);
const POWER_MEASUREMENT = canonicalUuid(0x2a63);
const POWER_UUID = POWER_MEASUREMENT;

/** Pause before retrying a chooser rejected with a bare status number (Bluefy while starting). */
export const CHOOSER_RETRY_MS = 1200;

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

  const request = () =>
    bluetooth.requestDevice({
      // namePrefix is case-sensitive in Web Bluetooth, so list the spellings in use.
      filters: [{ namePrefix: "BKOOL" }, { namePrefix: "Bkool" }, { namePrefix: "bkool" }],
      optionalServices: [BKOOL_SERVICE, CYCLING_POWER],
    });
  let device;
  try {
    try {
      device = await request();
    } catch (first) {
      // Bluefy can reject with a bare iOS Bluetooth state number while its radio starts; once.
      if (typeof first !== "number") throw first;
      await new Promise((resolve) => clock.setTimeout(resolve, CHOOSER_RETRY_MS));
      device = await request();
    }
  } catch (err) {
    if (err?.name === "NotFoundError") throw failure("cancelled", err);
    if (err?.name === "SecurityError" || err?.name === "NotSupportedError") {
      throw failure("unsupported", err);
    }
    throw failure("not-found", err, "choose");
  }

  const listeners = { data: [], raw: [], link: [], write: [] };
  // A failing listener (e.g. a screen bug) must never stop the Bluetooth logic.
  const emit = (type, ...args) => {
    for (const fn of listeners[type]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(err);
      }
    }
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

  let step = "connect"; // last step reached, reported when set-up fails
  /** Connects and subscribes. Safe to call again after a lost link (used by reconnect). */
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

  // Reconnect: on a lost link, retry on RECONNECT_WAITS_MS; once back, re-send the last order
  // so the bike returns to the rider's level or ERG target (spec: link lost / restored).
  let linkDown = false;
  let retryTimer = null;

  function scheduleReconnect(attempt) {
    const wait = RECONNECT_WAITS_MS[Math.min(attempt, RECONNECT_WAITS_MS.length - 1)];
    retryTimer = clock.setTimeout(async () => {
      retryTimer = null;
      if (closing) return;
      try {
        await setUp();
      } catch {
        if (!closing) scheduleReconnect(attempt + 1);
        return;
      }
      if (closing) {
        device.gatt.disconnect();
        return;
      }
      if (device.gatt.connected === false) {
        scheduleReconnect(attempt + 1); // dropped again while setting up: keep trying
        return;
      }
      linkDown = false;
      emit("link", "back");
      if (lastOrder) {
        pending = lastOrder;
        retries = 0;
        schedule();
      }
    }, wait);
  }

  device.addEventListener("gattserverdisconnected", () => {
    if (closing || linkDown) return;
    linkDown = true;
    scheduleReconnect(0);
    emit("link", "lost");
  });

  try {
    await setUp();
  } catch (err) {
    closing = true;
    if (retryTimer !== null) clock.clearTimeout(retryTimer);
    retryTimer = null;
    device.gatt.disconnect();
    throw failure("not-found", err, step);
  }

  // Latest-wins sender: at most one write every MIN_WRITE_GAP_MS; a newer order replaces a
  // pending one, so fast taps never build up a queue of stale orders. A failed write is
  // retried a few times unless a newer order arrived meanwhile.
  let pending = null;
  let lastOrder = null; // the rider's latest order, re-sent after a reconnect
  let retries = 0;
  let timer = null;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let inFlight = null; // the write currently on its way to the bike, if any
  let writeSeq = 0; // increases on every write attempt; a late failure of an older write is ignored

  async function flush() {
    timer = null;
    if (!pending || closing || linkDown) return; // while down, the order waits for 'back'
    const order = pending;
    pending = null;
    lastWriteAt = clock.now();
    const mySeq = ++writeSeq;
    try {
      inFlight = writeChar.writeValueWithoutResponse(order);
      await inFlight;
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
    inFlight = null;
    if (pending) schedule();
  }

  const sleep = (ms) => new Promise((resolve) => clock.setTimeout(resolve, ms));

  /** The safe order, sent like any other: after a write in flight, respecting the gap, retried. */
  async function writeSafeOrder() {
    const order = trackResistance(0);
    try {
      await inFlight;
    } catch {
      // the previous order failed; the safe order goes anyway
    }
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const wait = Math.max(0, lastWriteAt + MIN_WRITE_GAP_MS - clock.now());
      if (wait > 0) await sleep(wait);
      lastWriteAt = clock.now();
      try {
        await writeChar.writeValueWithoutResponse(order);
        emit("write", order, true);
        return;
      } catch {
        // retry
      }
    }
    emit("write", order, false);
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
      lastOrder = order;
      pending = order;
      retries = 0;
      schedule();
    },
    /** Leaves the bike at level 1 (slope 0 %), then closes the link. Never throws. */
    async disconnect() {
      if (closing) return;
      closing = true;
      if (timer !== null) clock.clearTimeout(timer);
      if (retryTimer !== null) clock.clearTimeout(retryTimer);
      timer = null;
      retryTimer = null;
      pending = null;
      if (!linkDown) {
        let timeoutId = null;
        const timeout = new Promise((resolve) => {
          timeoutId = clock.setTimeout(resolve, DISCONNECT_TIMEOUT_MS);
        });
        await Promise.race([writeSafeOrder(), timeout]);
        clock.clearTimeout(timeoutId);
      }
      device.gatt.disconnect();
    },
  };
}
