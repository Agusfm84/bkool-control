// A fake Web Bluetooth stack for contract tests: records writes and lets tests push notifications.
// Like real browsers, it reports every UUID as a lowercase 128-bit string, even when a 16-bit
// number was used to create or look it up.

/** Same rule browsers apply: 0x2a63 → "00002a63-0000-1000-8000-00805f9b34fb". */
export function canonicalUuid(uuid) {
  if (typeof uuid === "number") {
    return `${uuid.toString(16).padStart(8, "0")}-0000-1000-8000-00805f9b34fb`;
  }
  return String(uuid).toLowerCase();
}

class FakeTarget {
  #listeners = {};
  addEventListener(type, fn) {
    if (!this.#listeners[type]) this.#listeners[type] = [];
    this.#listeners[type].push(fn);
  }
  removeEventListener(type, fn) {
    this.#listeners[type] = (this.#listeners[type] ?? []).filter((f) => f !== fn);
  }
  dispatch(type, event = {}) {
    for (const fn of this.#listeners[type] ?? []) fn({ target: this, ...event });
  }
}

export class FakeCharacteristic extends FakeTarget {
  constructor(uuid) {
    super();
    this.uuid = canonicalUuid(uuid);
    this.notifying = false;
    this.writes = [];
    this.value = null;
  }
  async startNotifications() {
    this.notifying = true;
    return this;
  }
  async writeValueWithoutResponse(bytes) {
    // Like a real browser: no write once the link is down.
    // A characteristic from before a lost link is invalid until it is fetched again.
    if (this.stale || (this.device && !this.device.gatt.connected)) {
      throw Object.assign(new Error("GATT Server is disconnected"), { name: "NetworkError" });
    }
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      throw Object.assign(new Error("write failed"), { name: "NetworkError" });
    }
    this.writes.push(Uint8Array.from(bytes));
  }
  /** Test helper: the device sends a notification. */
  emit(...bytes) {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    this.dispatch("characteristicvaluechanged");
  }
}

class FakeService {
  constructor(uuid, chars) {
    this.uuid = canonicalUuid(uuid);
    this.chars = new Map(chars.map((c) => [c.uuid, c]));
  }
  async getCharacteristic(uuid) {
    this.asked?.push(uuid);
    const c = this.chars.get(canonicalUuid(uuid));
    if (!c) throw Object.assign(new Error(`no characteristic ${uuid}`), { name: "NotFoundError" });
    c.stale = false;
    return c;
  }
}

export class FakeDevice extends FakeTarget {
  constructor(name, services) {
    super();
    this.name = name;
    this.services = new Map(services.map((s) => [s.uuid, s]));
    this.missingService = null;
    this.connectCalls = 0;
    const device = this;
    this.gatt = {
      connected: false,
      asked: [], // every uuid passed to getPrimaryService/getCharacteristic, as given
      failNextConnects: 0,
      async connect() {
        device.connectCalls++;
        if (this.failNextConnects > 0) {
          this.failNextConnects--;
          throw Object.assign(new Error("connect failed"), { name: "NetworkError" });
        }
        this.connected = true;
        return this;
      },
      disconnect() {
        this.connected = false;
        device.dispatch("gattserverdisconnected");
      },
      async getPrimaryService(uuid) {
        this.asked.push(uuid);
        const key = canonicalUuid(uuid);
        const s = key === device.missingService ? undefined : device.services.get(key);
        if (!s) throw Object.assign(new Error(`no service ${uuid}`), { name: "NotFoundError" });
        return s;
      },
    };
    for (const svc of this.services.values()) {
      svc.asked = this.gatt.asked;
      for (const c of svc.chars.values()) c.device = this;
    }
  }
  /** Test helper: the Bluetooth link is lost without the app asking. */
  simulateLinkLoss() {
    this.gatt.connected = false;
    for (const svc of this.services.values()) for (const c of svc.chars.values()) c.stale = true;
    this.dispatch("gattserverdisconnected");
  }
}

export function fakeBluetooth(device, { requestError = null, failTimes = Infinity } = {}) {
  return {
    requests: [],
    async requestDevice(options) {
      this.requests.push(options);
      if (requestError != null && this.requests.length <= failTimes) throw requestError;
      return device;
    },
  };
}

export const BKOOL_SERVICE = "f03eee01-4910-473c-be46-960948c2f59c";
export const BKOOL_WRITE = "f03ee002-4910-473c-be46-960948c2f59c";
export const BKOOL_NOTIFY_4 = "f03ee004-4910-473c-be46-960948c2f59c";
export const BKOOL_NOTIFY_6 = "f03ee006-4910-473c-be46-960948c2f59c";

/** A fake BkoolFBike with the services seen in the owner's nRF Connect capture. */
export function fakeBkoolBike() {
  const write = new FakeCharacteristic(BKOOL_WRITE);
  const n4 = new FakeCharacteristic(BKOOL_NOTIFY_4);
  const n6 = new FakeCharacteristic(BKOOL_NOTIFY_6);
  const power = new FakeCharacteristic(0x2a63);
  const device = new FakeDevice("BkoolFBike", [
    new FakeService(BKOOL_SERVICE, [write, n4, n6]),
    new FakeService(0x1818, [power]),
  ]);
  return { device, write, n4, n6, power };
}

export const HR_SERVICE = "0000180d-0000-1000-8000-00805f9b34fb";
export const HR_MEASUREMENT = "00002a37-0000-1000-8000-00805f9b34fb";

/** A fake heart-rate strap: Heart Rate service 0x180D with the 0x2A37 measurement characteristic. */
export function fakeHrStrap(name = "FakeStrap 1234") {
  const hr = new FakeCharacteristic(0x2a37);
  const device = new FakeDevice(name, [new FakeService(0x180d, [hr])]);
  return { device, hr };
}

/** Manual clock: timers only fire when the test advances time. */
export function fakeClock() {
  let now = 0;
  let timers = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers = timers.filter((t) => t.id !== id);
    },
    /** Test helper: timers scheduled and not yet fired or cancelled. */
    pendingTimers: () => timers.length,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        await t.fn();
        await new Promise((r) => setImmediate(r));
      }
      now = end;
    },
  };
}
