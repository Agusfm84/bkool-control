import { ERG_MAX, ERG_MIN, LEVEL_MAX } from "../core/control.js";

// The riding screen. It only draws a "view" object and reports taps; it decides nothing.
// All text the rider sees is Spanish. Values arrive already computed by app.js.

/**
 * @typedef {object} View
 * @property {'unsupported'|'start'|'riding'|'summary'|'recovered'} page
 * @property {'off'|'connecting'|'on'|'lost'} bike
 * @property {'off'|'connecting'|'on'|'lost'} strap
 * @property {'idle'|'running'|'paused'|'finished'} status
 * @property {number} timeMs
 * @property {number|null} watts
 * @property {number|null} cadence
 * @property {number|null} speedKmh
 * @property {number|null} hr
 * @property {'gears'|'erg'} mode
 * @property {number} level
 * @property {number} ergTarget
 * @property {boolean} canMinus
 * @property {boolean} canPlus
 * @property {{kind:'info'|'error', text:string}|null} banner
 * @property {{durationS:number, avgW:number, maxW:number, avgCad:number, avgHr:number|null,
 *   maxHr:number|null}|null} summary
 * @property {boolean} canSave
 * @property {{text:string, yes:string}|null} [confirm]  a question before finish/discard
 */

/** "1:02:05" over an hour, "02:05" under. Pure, exported for tests. */
export function formatTime(ms) {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** Number for the screen: "--" when unknown; km/h with a comma decimal (Spanish). */
export function show(value, decimals = 0) {
  if (value == null || !Number.isFinite(value)) return "--";
  return decimals ? value.toFixed(decimals).replace(".", ",") : String(Math.round(value));
}

/** Which ladder ticks are lit: level L lights 1..L (Cambios); ERG lights by the target's place. */
export function ladderFill(mode, level, ergTarget) {
  if (mode === "erg") {
    const share = (ergTarget - ERG_MIN) / (ERG_MAX - ERG_MIN);
    return Math.max(1, Math.round(share * (LEVEL_MAX - 1)) + 1);
  }
  return level;
}

const CHIPS = {
  bike: {
    off: ["Conectar bici", "bike"],
    connecting: ["Buscando bici…", null],
    on: ["Bici conectada", null],
    lost: ["Bici sin conexión", null],
  },
  strap: {
    off: ["Conectar pulsómetro", "strap"],
    connecting: ["Buscando pulsómetro…", null],
    on: ["Pulso conectado", "strap-off"],
    lost: ["Pulso sin conexión", "strap-off"],
  },
};

/** What a connection chip says and what tapping it asks for (null = nothing to do). */
export function chip(device, state) {
  const [text, action] = CHIPS[device][state];
  return { text, action };
}

const MARK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/>
  <path d="M6 16l4-7h5l3 7M10 9l-1.5-2.5H7M13.5 9 12 16"/></svg>`;

const TEMPLATE = `
<header class="bar">
  <span class="mark">${MARK}</span>
  <h1 class="name">Bkool Control</h1>
  <span class="timer num" data-ref="timer" role="timer" aria-label="Tiempo de entrenamiento">00:00</span>
</header>
<nav class="links" aria-label="Conexiones">
  <button class="chip" type="button" data-action="bike" data-ref="bikeChip"></button>
  <button class="chip" type="button" data-action="strap" data-ref="strapChip"></button>
</nav>
<div class="banner" data-ref="banner" aria-live="assertive" aria-atomic="true"></div>

<section class="panel" data-page="unsupported" hidden>
  <h2>Este navegador no permite Bluetooth</h2>
  <p>Abre esta página con <strong>Chrome</strong> en Android o en el ordenador, o con
    <strong>Bluefy</strong> en el iPhone.</p>
</section>

<section class="panel" data-page="start" hidden>
  <h2>Enciende la bici y conéctala</h2>
  <p>Comprueba que ninguna otra app la está usando. El pulsómetro es opcional.</p>
  <button class="cta" type="button" data-action="bike">Conectar bici</button>
</section>

<section class="panel" data-page="recovered" hidden>
  <h2>Entrenamiento sin guardar</h2>
  <p>La página se cerró a mitad de un entrenamiento. Puedes guardarlo para Strava o descartarlo.</p>
  <div class="stats" data-ref="recoveredStats"></div>
  <button class="cta" type="button" data-action="save" data-ref="recoveredSave">Descargar para Strava</button>
  <button class="link" type="button" data-action="discard">Descartar</button>
</section>

<div data-page="riding" hidden>
  <section class="metrics" aria-label="Datos en directo">
    <div class="paused-tag" data-ref="pausedTag" hidden>En pausa</div>
    <div class="power"><span class="value num" data-ref="watts">--</span><span class="unit">W</span></div>
    <div class="trio">
      <div><div class="value num" data-ref="cadence">--</div><div class="label">rpm</div></div>
      <div><div class="value num" data-ref="speed">--</div><div class="label">km/h</div></div>
      <div><div class="value num" data-ref="hr">--</div><div class="label"><svg class="heart" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 14s-5.5-3.3-5.5-7.2A3 3 0 0 1 8 5a3 3 0 0 1 5.5 1.8C13.5 10.7 8 14 8 14z"/></svg> ppm</div></div>
    </div>
  </section>

  <section class="control" aria-label="Resistencia" style="margin-top:12px">
    <div class="modes" role="group" aria-label="Modo">
      <button type="button" data-action="gears" data-ref="gearsBtn">Cambios</button>
      <button type="button" data-action="erg" data-ref="ergBtn">ERG</button>
    </div>
    <div class="setting">
      <div class="big num" data-ref="settingBig">Nivel 5 / 20</div>
      <div class="sub" data-ref="settingSub">Pendiente 4 %</div>
    </div>
    <div class="ladder" data-ref="ladder" aria-hidden="true"></div>
    <div class="press">
      <button type="button" data-action="minus" data-ref="minus" aria-label="Bajar">−</button>
      <button type="button" data-action="plus" data-ref="plus" aria-label="Subir">+</button>
    </div>
  </section>
</div>

<section class="panel" data-page="summary" hidden>
  <h2>Entrenamiento terminado</h2>
  <div class="stats" data-ref="summaryStats"></div>
  <button class="cta" type="button" data-action="save" data-ref="summarySave">Descargar para Strava</button>
  <p data-ref="saveHint">Después, súbelo en strava.com → Subir actividad.</p>
  <button class="link" type="button" data-action="discard">Descartar y volver</button>
</section>

<section class="panel confirm" data-ref="confirm" hidden>
  <p class="confirm-text" data-ref="confirmText"></p>
  <div class="actions">
    <button type="button" data-action="cancel" class="primary">No, seguir</button>
    <button type="button" data-action="confirm" class="danger" data-ref="confirmYes"></button>
  </div>
</section>
<footer class="actions" data-ref="actions"></footer>
<button class="link" type="button" data-action="bike-off" data-ref="disconnect" hidden>Desconectar bici</button>
`;

const ACTIONS = {
  idle: [["start", "Empezar", "primary solo"]],
  running: [
    ["pause", "Pausa", "primary"],
    ["finish", "Terminar", "quiet"],
  ],
  paused: [
    ["resume", "Seguir", "primary"],
    ["finish", "Terminar", "quiet"],
  ],
};

function statsHtml(s) {
  const cell = (label, value, cls = "") =>
    `<div class="${cls}"><div class="label">${label}</div><div class="value num">${value}</div></div>`;
  const cells = [
    cell("Tiempo", formatTime(s.durationS * 1000), "lead"),
    cell("Potencia media", `${show(s.avgW)} W`, "power-stat"),
    cell("Potencia máxima", `${show(s.maxW)} W`),
    cell("Cadencia media", `${show(s.avgCad)} rpm`),
  ];
  if (s.avgHr != null) {
    cells.push(cell("Pulso medio", `${show(s.avgHr)} ppm`));
    cells.push(cell("Pulso máximo", `${show(s.maxHr)} ppm`, "wide"));
  } else {
    cells.push(cell("Pulso", "sin pulsómetro"));
  }
  return cells.join("");
}

/**
 * Builds the screen inside `root` and returns {render(view)}.
 * @param {HTMLElement} root
 * @param {(action:string)=>void} onAction  called with: bike, bike-off, strap, strap-off, gears,
 *   erg, minus, plus, start, pause, resume, finish, save, discard, confirm, cancel
 */
export function createScreen(root, onAction) {
  root.innerHTML = TEMPLATE;
  const ref = {};
  for (const el of root.querySelectorAll("[data-ref]")) ref[el.dataset.ref] = el;
  const pages = [...root.querySelectorAll("[data-page]")];
  for (let i = 0; i < LEVEL_MAX; i++) {
    const tick = document.createElement("i");
    tick.style.height = `${30 + (70 * i) / (LEVEL_MAX - 1)}%`; // a rising ladder
    ref.ladder.append(tick);
  }

  root.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (button && !button.disabled) onAction(button.dataset.action);
  });

  let lastActions = "";
  let lastStats = "";

  function render(v) {
    for (const p of pages) p.hidden = p.dataset.page !== v.page;

    ref.timer.textContent = formatTime(v.timeMs);
    ref.timer.dataset.status = v.status;

    for (const [key, el] of [
      ["bike", ref.bikeChip],
      ["strap", ref.strapChip],
    ]) {
      const c = chip(key, v[key]);
      el.dataset.state = v[key];
      el.textContent = c.text;
      if (c.action) el.dataset.action = c.action;
      else delete el.dataset.action;
      el.disabled = v.page === "unsupported" || !c.action;
    }

    // The live region stays in the page (empty when quiet) so screen readers announce changes.
    ref.banner.textContent = v.banner ? v.banner.text : "";
    ref.banner.dataset.kind = v.banner ? v.banner.kind : "none";

    if (v.page === "riding") {
      ref.watts.textContent = show(v.watts);
      const paused = v.status === "paused";
      ref.watts.parentElement.classList.toggle("empty", v.watts == null || paused);
      ref.pausedTag.hidden = !paused;
      ref.ladder.hidden = v.mode === "erg"; // in ERG the bike sets the resistance: no ladder
      ref.cadence.textContent = show(v.cadence);
      ref.speed.textContent = show(v.speedKmh, 1);
      ref.hr.textContent = show(v.hr);
      ref.hr.classList.toggle("empty", v.hr == null);
      ref.gearsBtn.setAttribute("aria-pressed", String(v.mode === "gears"));
      ref.ergBtn.setAttribute("aria-pressed", String(v.mode === "erg"));
      if (v.mode === "erg") {
        ref.settingBig.textContent = `Objetivo ${v.ergTarget} W`;
        ref.settingSub.textContent = "±10 W por toque · la bici ajusta la dureza";
      } else {
        ref.settingBig.textContent = `Nivel ${v.level} / ${LEVEL_MAX}`;
        ref.settingSub.textContent = `Pendiente ${v.level - 1} %`;
      }
      const lit = ladderFill(v.mode, v.level, v.ergTarget);
      [...ref.ladder.children].forEach((tick, i) => {
        tick.toggleAttribute("data-on", i < lit - 1);
        tick.toggleAttribute("data-current", i === lit - 1);
      });
      const live = v.bike === "on" && !v.confirm; // nothing changes behind an open question
      ref.minus.disabled = !live || !v.canMinus;
      ref.plus.disabled = !live || !v.canPlus;
      ref.gearsBtn.disabled = !live;
      ref.ergBtn.disabled = !live;
    }

    const stats = v.summary ? statsHtml(v.summary) : "";
    if (stats !== lastStats) {
      ref.summaryStats.innerHTML = stats; // built only from numbers, never from outside text
      ref.recoveredStats.innerHTML = stats;
      lastStats = stats;
    }
    ref.summarySave.disabled = !v.canSave;
    ref.recoveredSave.disabled = !v.canSave;

    ref.confirm.hidden = !v.confirm;
    if (v.confirm) {
      ref.confirmText.textContent = v.confirm.text;
      ref.confirmYes.textContent = v.confirm.yes;
    }
    ref.disconnect.hidden =
      Boolean(v.confirm) || !(v.page === "riding" && (v.bike === "on" || v.bike === "lost"));

    const actions = v.page === "riding" && !v.confirm ? (ACTIONS[v.status] ?? []) : [];
    const key = `${v.status}|${v.page}|${v.bike}|${Boolean(v.confirm)}`;
    if (key !== lastActions) {
      ref.actions.replaceChildren(
        ...actions.map(([action, text, cls]) => {
          const b = document.createElement("button");
          b.type = "button";
          b.dataset.action = action;
          b.className = cls;
          b.textContent = text;
          if (action === "start") b.disabled = v.bike !== "on";
          return b;
        }),
      );
      lastActions = key;
    }
  }

  return { render };
}
