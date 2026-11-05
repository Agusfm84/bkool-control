// A fake Web Bluetooth stack for contract tests: records writes and lets tests push notifications.

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
    this.uuid = uuid;
    this.notifying = false;
    this.writes = [];
    this.value = null;
  }
  async startNotifications() {
    this.notifying = true;
    return this;
  }
  async writeValueWithoutResponse(bytes) {
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
    this.uuid = uuid;
    this.chars = new Map(chars.map((c) => [c.uuid, c]));
  }
  async getCharacteristic(uuid) {
    const c = this.chars.get(uuid);
    if (!c) throw Object.assign(new Error(`no characteristic ${uuid}`), { name: "NotFoundError" });
    return c;
  }
}

export class FakeDevice extends FakeTarget {
  constructor(name, services) {
    super();
    this.name = name;
    this.services = new Map(services.map((s) => [s.uuid, s]));
    this.connectCalls = 0;
    const device = this;
    this.gatt = {
      connected: false,
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
        const s = device.services.get(uuid);
        if (!s) throw Object.assign(new Error(`no service ${uuid}`), { name: "NotFoundError" });
        return s;
      },
    };
  }
  /** Test helper: the Bluetooth link is lost without the app asking. */
  simulateLinkLoss() {
    this.gatt.connected = false;
    this.dispatch("gattserverdisconnected");
  }
}

export function fakeBluetooth(device, { requestError = null } = {}) {
  return {
    requests: [],
    async requestDevice(options) {
      this.requests.push(options);
      if (requestError) throw requestError;
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
