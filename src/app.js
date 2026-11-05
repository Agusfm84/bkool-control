// Bkool Control — the one owner of the app state. Wires Bluetooth, the workout clock, recovery,
// the TCX file and the screen. Decisions live in core/ and app-view.js; this file only connects.
import { fileName, readingAt, viewFor } from "./app-view.js";
import { connectBike } from "./ble/bike.js";
import { connectStrap } from "./ble/hr.js";
import * as control from "./core/control.js";
import * as tcx from "./core/tcx.js";
import * as workout from "./core/workout.js";
import { createRecovery } from "./store/recovery.js";
import { saveFile } from "./ui/save-file.js";
import { createScreen } from "./ui/screen.js";

const RECOVERY_EVERY_MS = 5000;
const INIT_GAP_MS = 400;
// Orders the bike gets before it obeys (spike T008: it worked with them; risk R5 not isolated).
const INIT_ORDERS = [
  [0x30, 0x25, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00],
  [0x32, 0x25, 0xff, 0xff, 0xff, 0x1e, 0x7f, 0x00],
  [0x33, 0x25, 0xff, 0xff, 0xff, 0x20, 0x4e, 0x00],
].map((a) => Uint8Array.from(a));

const MESSAGES = {
  bikeCancelled:
    "No se eligió ninguna bici. Comprueba que está encendida y que ninguna otra app la usa.",
  bikeFailed: "No se pudo conectar con la bici. Apágala y enciéndela, y vuelve a probar.",
  strapCancelled: "No se eligió ningún pulsómetro. Póntelo (humedecido) y vuelve a probar.",
  strapFailed: "No se pudo conectar el pulsómetro. Vuelve a probar.",
  noBackup:
    "Este navegador no deja guardar una copia del entrenamiento. Si cierras la página, se perderá.",
  saveFailed: "No se pudo guardar el archivo. Vuelve a probar.",
  saved: "Archivo listo. Súbelo en strava.com → Subir actividad.",
  oops: "Algo ha fallado. Vuelve a probar.",
  backupStuck: "No se pudo borrar la copia guardada. Si vuelve a aparecer, descártala.",
};

const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recovery = createRecovery();

/** The whole app state; only this file changes it. */
const s = {
  supported: Boolean(globalThis.navigator?.bluetooth),
  bike: "off",
  strap: "off",
  ctrl: control.create(),
  w: workout.create(),
  latest: null,
  hr: null,
  recovered: recovery.load(),
  confirm: null,
  message: null,
};
let bike = null;
let strap = null;
let lastBackupAt = 0;
let backupWarned = false;

const info = (text) => {
  s.message = text ? { kind: "info", text } : null;
};

// ---- Bluetooth -----------------------------------------------------------------------------

async function connectTheBike() {
  if (s.bike !== "off") return; // a double tap must not open two choosers
  s.bike = "connecting";
  info(null);
  render();
  let b;
  try {
    b = await connectBike();
  } catch (err) {
    s.bike = "off";
    if (err?.kind === "unsupported") s.supported = false;
    else info(err?.kind === "cancelled" ? MESSAGES.bikeCancelled : MESSAGES.bikeFailed);
    render();
    return;
  }
  bike = b;
  b.onData(({ watts, cadence }) => {
    s.latest = { watts, cadence, at: now() };
  });
  let linkLost = false;
  let ready = false;
  b.onLinkChange((e) => {
    if (bike !== b) return;
    linkLost = e === "lost";
    if (ready) s.bike = linkLost ? "lost" : "on"; // during init the bike stays "connecting"
    render();
  });
  // Init orders, spaced by hand (the latest-wins sender would keep only the last one), then the
  // rider's current setting. The bike counts as connected once they are out.
  for (const order of INIT_ORDERS) {
    b.send(order);
    await sleep(INIT_GAP_MS);
    if (bike !== b) return;
  }
  b.send(control.currentOrder(s.ctrl));
  ready = true;
  s.bike = linkLost ? "lost" : "on"; // a drop during init is shown, not hidden
  keepScreenOn();
  render();
}

async function disconnectTheBike() {
  const b = bike;
  if (!b) return;
  bike = null;
  s.bike = "off";
  s.latest = null;
  render();
  await b.disconnect(); // sends level 1 first, then closes
}

async function connectTheStrap() {
  if (s.strap !== "off") return;
  s.strap = "connecting";
  info(null);
  render();
  try {
    const st = await connectStrap();
    strap = st;
    st.onHr((bpm) => {
      s.hr = bpm == null ? null : { bpm, at: now() };
    });
    st.onLinkChange((e) => {
      if (strap !== st) return;
      s.strap = e === "lost" ? "lost" : "on";
      render();
    });
    s.strap = "on";
  } catch (err) {
    s.strap = "off";
    if (err?.kind === "unsupported") s.supported = false;
    else info(err?.kind === "cancelled" ? MESSAGES.strapCancelled : MESSAGES.strapFailed);
  }
  render();
}

function disconnectTheStrap() {
  const st = strap;
  strap = null;
  s.strap = "off";
  s.hr = null;
  st?.disconnect();
  render();
}

/** While the link is down the adapter keeps the newest order and sends it when the bike is back. */
function sendSetting(order) {
  if (order && bike && s.bike !== "connecting") bike.send(order);
}

// ---- Workout -------------------------------------------------------------------------------

function backup(force = false) {
  const t = now();
  if (!force && t - lastBackupAt < RECOVERY_EVERY_MS) return;
  lastBackupAt = t;
  if (!recovery.save(s.w) && !backupWarned) {
    backupWarned = true;
    info(MESSAGES.noBackup);
  }
}

function finishWorkout() {
  s.w = workout.finish(s.w, now());
  backup(true);
  // Owner's decision (2026-11-05): the bike stays connected, back at slope 0 % (level 1).
  s.ctrl = { ...s.ctrl, mode: "gears", level: control.LEVEL_MIN };
  sendSetting(control.safeOrder());
}

let saving = false;
async function saveWorkout() {
  if (saving) return; // a double tap must not open two share sheets
  saving = true;
  try {
    await saveOnce();
  } finally {
    saving = false;
  }
}

function clearBackup() {
  if (!recovery.clear()) info(MESSAGES.backupStuck);
}

async function saveOnce() {
  const w = s.recovered ?? s.w;
  if (!(w.samples ?? []).some((x) => !x.gap)) return;
  const text = tcx.build(w.samples, new Date(w.startedAt).toISOString());
  const result = await saveFile(fileName(w.startedAt), text);
  if (result === "cancelled") return;
  if (result === "failed") {
    info(MESSAGES.saveFailed);
    render();
    return;
  }
  s.recovered = null;
  s.w = workout.create();
  info(MESSAGES.saved);
  clearBackup();
  render();
}

function discardWorkout() {
  s.recovered = null;
  s.w = workout.create();
  info(null);
  clearBackup();
}

// ---- Screen actions ------------------------------------------------------------------------

const workoutRunning = () => s.w.status === "running" || s.w.status === "paused";

const ACTIONS = {
  bike: connectTheBike,
  "bike-off": () => {
    if (workoutRunning()) s.confirm = "bike-off";
    else return disconnectTheBike();
  },
  strap: connectTheStrap,
  "strap-off": disconnectTheStrap,
  gears: () => {
    const r = control.setMode(s.ctrl, "gears");
    s.ctrl = r.state;
    sendSetting(r.order);
  },
  erg: () => {
    const r = control.setMode(s.ctrl, "erg");
    s.ctrl = r.state;
    sendSetting(r.order);
  },
  minus: () => press("minus"),
  plus: () => press("plus"),
  start: () => {
    if (s.bike !== "on") return;
    s.w = workout.start(s.w, now());
    info(null);
    keepScreenOn();
    backup(true);
  },
  pause: () => {
    s.w = workout.pause(s.w, now());
    backup(true);
  },
  resume: () => {
    s.w = workout.resume(s.w, now());
  },
  finish: () => {
    if (workoutRunning()) s.confirm = "finish";
  },
  save: saveWorkout,
  discard: () => {
    s.confirm = "discard";
  },
  cancel: () => {
    s.confirm = null;
  },
  confirm: () => {
    const what = s.confirm;
    s.confirm = null;
    if (what === "finish") finishWorkout();
    else if (what === "discard") discardWorkout();
    else if (what === "bike-off") return disconnectTheBike();
  },
};

function press(dir) {
  const r = control.press(s.ctrl, dir);
  s.ctrl = r.state;
  sendSetting(r.order);
}

async function onAction(action) {
  try {
    await ACTIONS[action]?.();
  } catch (err) {
    console.error(err); // never a raw error on screen
    info(MESSAGES.oops);
  }
  render();
}

// ---- Clock, screen, wake lock --------------------------------------------------------------

const screen = createScreen(document.getElementById("app"), onAction);

function render() {
  screen.render(viewFor(s, now()));
}

function tick() {
  const t = now();
  if (s.w.status === "running") {
    s.w = workout.tick(s.w, t, readingAt(s, t));
    backup();
  }
  render();
}

let wakeLock = null;
async function keepScreenOn() {
  try {
    if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    // not allowed here (battery saver, old browser): the screen may dim, nothing else breaks
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (s.bike === "on" || workoutRunning())) {
    keepScreenOn();
  }
});

setInterval(tick, 1000);
render();
