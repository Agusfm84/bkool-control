// Design preview: draws the screen in each state with invented sample data, no bike needed.
// Open preview.html?state=riding (start, erg, lost, paused, summary, recovered, unsupported).
import { createScreen } from "./screen.js";

const base = {
  page: "riding",
  bike: "on",
  strap: "on",
  status: "running",
  timeMs: 42 * 60_000 + 15_000,
  watts: 182,
  cadence: 88,
  speedKmh: 31.2,
  hr: 142,
  mode: "gears",
  level: 7,
  ergTarget: 150,
  canMinus: true,
  canPlus: true,
  banner: null,
  summary: null,
  canSave: false,
};

const summary = { durationS: 2535, avgW: 176, maxW: 312, avgCad: 86, avgHr: 139, maxHr: 161 };

const STATES = {
  riding: {},
  start: { page: "start", bike: "off", strap: "off", status: "idle", timeMs: 0 },
  idle: { status: "idle", timeMs: 0, watts: 0, cadence: 0, speedKmh: 0, hr: null, strap: "off" },
  erg: { mode: "erg", ergTarget: 150, watts: 151, cadence: 92 },
  lost: {
    bike: "lost",
    watts: null,
    cadence: null,
    speedKmh: null,
    banner: { kind: "error", text: "Conexión perdida con la bici. Reintentando…" },
  },
  paused: { status: "paused", watts: 0, cadence: 0, speedKmh: 0 },
  top: { level: 20, canPlus: false, watts: 412, cadence: 79 },
  summary: { page: "summary", status: "finished", summary, canSave: true },
  recovered: {
    page: "recovered",
    bike: "off",
    strap: "off",
    status: "idle",
    summary,
    canSave: true,
  },
  unsupported: { page: "unsupported", bike: "off", strap: "off", status: "idle", timeMs: 0 },
};

const name = new URLSearchParams(location.search).get("state") ?? "riding";
const screen = createScreen(document.getElementById("app"), (a) => console.log("tap:", a));
screen.render({ ...base, ...(STATES[name] ?? {}) });
