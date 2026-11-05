// What the screen shows, computed from the app state. Pure: no DOM, no Bluetooth, time passed in.
import * as control from "./core/control.js";
import { fromPower } from "./core/speed.js";
import * as workout from "./core/workout.js";

/** A reading older than this is no longer "live": the screen shows "--" and the second is a gap. */
export const DATA_STALE_MS = 3000;

const CONFIRMS = {
  finish: { text: "¿Terminar el entrenamiento?", yes: "Sí, terminar" },
  discard: { text: "¿Descartar este entrenamiento? No se podrá recuperar.", yes: "Sí, descartar" },
  "bike-off": { text: "¿Desconectar la bici a mitad del entrenamiento?", yes: "Sí, desconectar" },
};

const fresh = (x, now) => x != null && now - x.at <= DATA_STALE_MS;

/**
 * The reading recorded this second, or null when the bike sent nothing recently (a gap).
 * @returns {{watts:number, cadence:number|null, hr:number|null, speedKmh:number}|null}
 */
export function readingAt(s, now) {
  if (!fresh(s.latest, now)) return null;
  return {
    watts: s.latest.watts,
    cadence: s.latest.cadence,
    hr: fresh(s.hr, now) ? s.hr.bpm : null,
    speedKmh: fromPower(s.latest.watts),
  };
}

const hasData = (w) => (w?.samples ?? []).some((x) => !x.gap);

function pageFor(s) {
  if (!s.supported) return "unsupported";
  if (s.recovered) return "recovered";
  if (s.w.status === "finished") return "summary";
  if (s.bike === "off" && s.w.status === "idle") return "start";
  return "riding";
}

function bannerFor(s) {
  if (s.bike === "lost")
    return { kind: "error", text: "Conexión perdida con la bici. Reintentando…" };
  if (s.strap === "lost") return { kind: "info", text: "Pulsómetro desconectado. Reintentando…" };
  return s.message;
}

/** The View that src/ui/screen.js draws. */
export function viewFor(s, now) {
  const page = pageFor(s);
  const r = readingAt(s, now);
  const shown = page === "recovered" ? s.recovered : s.w;
  return {
    page,
    bike: s.bike,
    strap: s.strap,
    status: s.w.status,
    timeMs: workout.elapsedMs(s.w, now),
    watts: r?.watts ?? null,
    cadence: r?.cadence ?? null,
    speedKmh: r?.speedKmh ?? null,
    hr: r?.hr ?? null,
    mode: s.ctrl.mode,
    level: s.ctrl.level,
    ergTarget: s.ctrl.ergTarget,
    canMinus: control.canPress(s.ctrl, "minus"),
    canPlus: control.canPress(s.ctrl, "plus"),
    banner: bannerFor(s),
    summary: page === "summary" || page === "recovered" ? workout.summary(shown) : null,
    canSave: hasData(shown),
    confirm: s.confirm ? CONFIRMS[s.confirm] : null,
  };
}

/** "bkool-2026-11-05-1907.tcx" from the local start time. */
export function fileName(startedAtMs) {
  const d = new Date(startedAtMs);
  const two = (n) => String(n).padStart(2, "0");
  return `bkool-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}.tcx`;
}
