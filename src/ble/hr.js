// Bluetooth plumbing for a standard heart-rate strap (Web Bluetooth): connects, subscribes to
// Heart Rate Measurement and turns notifications into bpm. On a lost link it keeps retrying.
import * as hr from "../core/hr.js";
import { CHOOSER_RETRY_MS, canonicalUuid } from "./bike.js";

// Always full 128-bit strings when talking to the browser: Bluefy (iPhone) rejects short numbers.
const HEART_RATE = canonicalUuid(0x180d);
const HR_MEASUREMENT = canonicalUuid(0x2a37);

/** Waits between reconnect attempts: 1 s, 2 s, 4 s, 8 s, then 10 s for ever. */
const RETRY_WAITS_MS = [1000, 2000, 4000, 8000, 10000];

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

function failure(kind, cause, step) {
  return { kind, cause, step };
}

/**
 * Asks the user to pick the strap and connects to it.
 * @param {{bluetooth?: Bluetooth, clock?: object}} [options] injectable for tests
 * @returns {Promise<Strap>} rejects with {kind: 'unsupported'|'cancelled'|'not-found'}
 */
export async function connectStrap({
  bluetooth = globalThis.navigator?.bluetooth,
  clock = defaultClock,
} = {}) {
  if (!bluetooth) throw failure("unsupported");

  const request = () =>
    bluetooth.requestDevice({
      filters: [{ services: [HEART_RATE] }],
      optionalServices: [HEART_RATE],
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

  const listeners = { hr: [], link: [] };
  // A failing listener (e.g. a screen bug) must never stop the reconnection logic.
  const emit = (type, ...args) => {
    for (const fn of listeners[type]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(err);
      }
    }
  };

  let closing = false;
  let retrying = false;
  let retryTimer = null;

  function onNotify(event) {
    const bpm = hr.parse(event.target.value);
    emit("hr", bpm > 0 ? bpm : null); // 0 = no skin contact: no reading
  }

  let step = "connect";
  /** Connects and subscribes. Safe to call again after a lost link. */
  async function setUp() {
    step = "connect";
    const server = await device.gatt.connect();
    step = "hr-service";
    const service = await server.getPrimaryService(HEART_RATE);
    step = "hr-notify";
    const c = await service.getCharacteristic(HR_MEASUREMENT);
    c.removeEventListener("characteristicvaluechanged", onNotify);
    c.addEventListener("characteristicvaluechanged", onNotify);
    await c.startNotifications();
  }

  function scheduleRetry(attempt) {
    const wait = RETRY_WAITS_MS[Math.min(attempt, RETRY_WAITS_MS.length - 1)];
    retryTimer = clock.setTimeout(async () => {
      retryTimer = null;
      if (closing) return;
      try {
        await setUp();
      } catch {
        if (!closing) scheduleRetry(attempt + 1);
        return;
      }
      if (closing) {
        device.gatt.disconnect();
        return;
      }
      retrying = false;
      emit("link", "back");
    }, wait);
  }

  device.addEventListener("gattserverdisconnected", () => {
    if (closing || retrying) return;
    retrying = true;
    emit("link", "lost");
    scheduleRetry(0);
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

  return {
    name: device.name,
    onHr(fn) {
      listeners.hr.push(fn);
    },
    onLinkChange(fn) {
      listeners.link.push(fn);
    },
    disconnect() {
      closing = true;
      if (retryTimer !== null) clock.clearTimeout(retryTimer);
      retryTimer = null;
      device.gatt.disconnect();
    },
  };
}
