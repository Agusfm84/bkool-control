// Spike page (plan step 5): proves on the real bike that slope and ERG orders work, and checks
// what Bluefy allows. Throwaway screen; the logic it uses is the real one from core/ and ble/.
import { canonicalUuid, connectBike } from "./ble/bike.js";
import { targetPower, trackResistance } from "./core/fec.js";
import * as hr from "./core/hr.js";

const $ = (sel) => document.querySelector(sel);
const HR_SERVICE = canonicalUuid(0x180d);
const HR_MEASUREMENT = canonicalUuid(0x2a37);
const hex = (bytes) =>
  [...new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

// Orders seen in the open-source driver before control works (risk R5): basic resistance 0,
// wind defaults, flat slope with zero rolling resistance.
const INIT_ORDERS = [
  [0x30, 0x25, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00],
  [0x32, 0x25, 0xff, 0xff, 0xff, 0x1e, 0x7f, 0x00],
  [0x33, 0x25, 0xff, 0xff, 0xff, 0x20, 0x4e, 0x00],
].map((a) => Uint8Array.from(a));

let bike = null;
let initTimers = [];

function cancelInit() {
  for (const id of initTimers) clearTimeout(id);
  initTimers = [];
}

function log(line) {
  const el = $("#log");
  const time = new Date().toLocaleTimeString("es-ES");
  el.textContent = `${time}  ${line}\n${el.textContent}`.slice(0, 20000);
}

function setControls(enabled) {
  for (const b of document.querySelectorAll("[data-slope],[data-erg]")) b.disabled = !enabled;
  $("#disconnect").disabled = !enabled;
  $("#connect").disabled = enabled;
  $("#connect-any").disabled = enabled;
}

const MESSAGES = {
  unsupported: "Este navegador no permite Bluetooth. Usa Chrome (Android/PC) o Bluefy (iPhone).",
  cancelled: "No se eligió ninguna bici. Comprueba que está encendida y sin otra app conectada.",
  "not-found": "No se pudo conectar con la bici. Apágala y enciéndela, y vuelve a probar.",
};

const labels = new Map(); // order hex → label, to name confirmations in the log

function send(order, label) {
  labels.set(hex(order), label);
  bike.send(order);
  log(`… en cola ${label}: ${hex(order)}`);
}

$("#support").textContent = navigator.bluetooth
  ? "Bluetooth disponible en este navegador ✔"
  : MESSAGES.unsupported;

/** Whatever the browser threw, as text: some browsers reject with values that are not Errors. */
function describe(cause) {
  try {
    return describeUnsafe(cause);
  } catch {
    return "(error ilegible)";
  }
}

function describeUnsafe(cause) {
  if (cause == null) return "(sin detalle)";
  if (typeof cause !== "object") return `${typeof cause}: ${String(cause)}`;
  const parts = [cause.name, cause.message, cause.code].filter((x) => x != null && x !== "");
  if (parts.length) return parts.join(" | ");
  try {
    return `objeto: ${JSON.stringify(cause)} ${String(cause)}`;
  } catch {
    return `objeto: ${String(cause)}`;
  }
}

// Diagnostic only: asks the browser to list every nearby device instead of filtering by name,
// in case the name filter is what fails on this browser.
const anyDevice = () => ({
  requestDevice: (opts) =>
    navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: opts.optionalServices,
    }),
});

$("#connect").addEventListener("click", () => connect(false));
$("#connect-any").addEventListener("click", () => connect(true));

// Diagnostic only: can this browser open the device list at all, asking for nothing else?
$("#list-only").addEventListener("click", async () => {
  if (!navigator.bluetooth) return log(MESSAGES.unsupported);
  log("solo lista: pidiendo la lista de aparatos…");
  $("#list-only").disabled = true;
  try {
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
    log(`✔ solo lista: elegido "${device.name ?? "sin nombre"}"`);
  } catch (err) {
    log(`✖ solo lista: ${describe(err)}`);
  } finally {
    $("#list-only").disabled = false;
  }
});

async function connect(any) {
  $("#connect").disabled = true;
  $("#connect-any").disabled = true;
  $("#bike-status").textContent = "Conectando…";
  $("#bike-status").className = "";
  log(any ? "buscando cualquier aparato…" : "buscando la bici por nombre…");
  try {
    bike = await connectBike(any && navigator.bluetooth ? { bluetooth: anyDevice() } : {});
  } catch (err) {
    $("#connect").disabled = false;
    $("#connect-any").disabled = false;
    $("#bike-status").textContent = MESSAGES[err?.kind] ?? MESSAGES["not-found"];
    log(`✖ conexión: ${err?.kind} · paso: ${err?.step ?? "?"} · ${describe(err?.cause)}`);
    return;
  }
  $("#bike-status").textContent = `Conectado a ${bike.name}.`;
  $("#bike-status").className = "ok";
  setControls(false);
  $("#disconnect").disabled = false;
  $("#connect").disabled = true;
  $("#connect-any").disabled = true;
  bike.onWrite((order, ok) => {
    const label = labels.get(hex(order)) ?? "orden";
    log(ok ? `→ enviado a la bici: ${label}` : `✖ NO se pudo enviar: ${label}`);
  });
  bike.onData(({ watts, cadence }) => {
    $("#watts").textContent = watts;
    $("#cadence").textContent = cadence ?? "--";
  });
  bike.onRaw((uuid, view) => log(`← ${uuid.slice(0, 8)}: ${hex(view)}`));
  bike.onLinkChange((e) => {
    if (e === "back") {
      $("#bike-status").textContent = `Conectado a ${bike?.name}. Conexión recuperada.`;
      $("#bike-status").className = "ok";
      setControls(true);
      log("✔ enlace recuperado: se reenvía la última orden");
      return;
    }
    cancelInit();
    $("#bike-status").textContent = "Conexión perdida. Reintentando…";
    $("#bike-status").className = "bad";
    setControls(false);
    $("#connect").disabled = false;
    $("#connect-any").disabled = false;
    log(`✖ enlace: ${e}`);
  });
  // Initial orders, spaced ourselves (the latest-wins sender would keep only the last one).
  // The test buttons stay disabled until the last one has gone out, so a tap cannot replace it.
  // Timers belong to this connection only: they are cancelled on disconnect or link loss.
  const thisBike = bike;
  $("#bike-status").textContent = `Conectado a ${bike.name}. Preparando la bici…`;
  for (const [i, order] of INIT_ORDERS.entries()) {
    initTimers.push(
      setTimeout(() => {
        if (bike === thisBike) send(order, `inicio ${i + 1}`);
      }, i * 400),
    );
  }
  initTimers.push(
    setTimeout(
      () => {
        if (bike !== thisBike) return;
        setControls(true);
        $("#bike-status").textContent =
          `Conectado a ${bike.name}. Listo: deja 1 segundo entre toques.`;
      },
      INIT_ORDERS.length * 400 + 300,
    ),
  );
  requestWakeLock();
}

$("#disconnect").addEventListener("click", () => {
  cancelInit();
  bike?.send(trackResistance(0));
  setTimeout(() => {
    bike?.disconnect();
    bike = null;
    $("#bike-status").textContent = "Desconectado.";
    $("#bike-status").className = "";
    setControls(false);
  }, 400);
});

for (const b of document.querySelectorAll("[data-slope]")) {
  b.addEventListener("click", () => {
    const slope = Number(b.dataset.slope);
    send(trackResistance(slope), `pendiente ${slope} %`);
  });
}
for (const b of document.querySelectorAll("[data-erg]")) {
  b.addEventListener("click", () => {
    const watts = Number(b.dataset.erg);
    send(targetPower(watts), `ERG ${watts} W`);
  });
}

function hrStatus(text) {
  $("#hr-status").textContent = text;
}

$("#hr").addEventListener("click", async () => {
  if (!navigator.bluetooth) {
    hrStatus(MESSAGES.unsupported);
    return;
  }
  hrStatus("Buscando pulsómetro…");
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HR_SERVICE] }],
    });
    device.addEventListener("gattserverdisconnected", () => {
      $("#bpm").textContent = "--";
      hrStatus("Pulsómetro desconectado.");
    });
    const server = await device.gatt.connect();
    const ch = await (await server.getPrimaryService(HR_SERVICE)).getCharacteristic(HR_MEASUREMENT);
    ch.addEventListener("characteristicvaluechanged", (e) => {
      $("#bpm").textContent = hr.parse(e.target.value);
    });
    await ch.startNotifications();
    hrStatus(`Pulsómetro conectado: ${device.name ?? "sin nombre"}.`);
    log(`✔ pulsómetro conectado: ${device.name ?? "sin nombre"}`);
  } catch (err) {
    hrStatus(
      err?.name === "NotFoundError"
        ? "No se eligió ningún pulsómetro. Póntelo (humedecido) y vuelve a probar."
        : "No se pudo conectar el pulsómetro. Vuelve a probar.",
    );
    log(`✖ pulsómetro: ${err?.name ?? ""} ${err?.message ?? ""}`);
  }
});

async function requestWakeLock() {
  try {
    await navigator.wakeLock.request("screen");
    $("#wake").textContent = "Pantalla encendida: sí, el navegador lo permite ✔";
  } catch (err) {
    $("#wake").textContent = `Pantalla encendida: no disponible (${err?.name ?? "sin soporte"}).`;
  }
}

$("#download").addEventListener("click", () => {
  const blob = new Blob(["Prueba de descarga de Bkool Control\n"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "prueba-bkool.txt";
  document.body.append(a); // some iPhone browsers ignore clicks on detached links
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  log("✔ descarga lanzada: busca prueba-bkool.txt en Descargas/Archivos");
});

$("#clear").addEventListener("click", () => {
  $("#log").textContent = "";
});

// R3 on iPhone: Bluefy shows "downloaded" but saves nothing. Two other ways out, tested here.
// The test file looks like the real one the app will produce (a small TCX).
const TEST_TCX_NAME = "prueba-bkool.tcx";
const TEST_TCX = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities><Activity Sport="Biking"><Id>2026-11-05T20:00:00Z</Id></Activity></Activities>
</TrainingCenterDatabase>
`;

$("#share").addEventListener("click", async () => {
  if (!navigator.share) return log("✖ compartir: este navegador no tiene la opción de compartir");
  // Try the XML type first; if refused, plain text (some iPhones only accept common types).
  const candidates = ["application/xml", "text/plain"].map(
    (type) => new File([TEST_TCX], TEST_TCX_NAME, { type }),
  );
  const file = candidates.find((f) => !navigator.canShare || navigator.canShare({ files: [f] }));
  if (!file) return log("✖ compartir: no acepta archivos ni como XML ni como texto");
  log(`compartir: tipo aceptado ${file.type}`);
  try {
    await navigator.share({ files: [file], title: TEST_TCX_NAME });
    log("✔ compartir: menú abierto y terminado. ¿Pudiste guardarlo en Archivos?");
  } catch (err) {
    log(
      err?.name === "AbortError"
        ? "compartir: cerraste el menú sin elegir nada"
        : `✖ compartir: ${describe(err)}`,
    );
  }
});

$("#open-tab").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([TEST_TCX], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank"; // no download attribute: the browser shows the file instead
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  log("abrir: si se abrió una pestaña con el texto, usa compartir → Guardar en Archivos");
});
