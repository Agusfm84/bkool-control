// Spike page (plan step 5): proves on the real bike that slope and ERG orders work, and checks
// what Bluefy allows. Throwaway screen; the logic it uses is the real one from core/ and ble/.
import { connectBike } from "./ble/bike.js";
import { targetPower, trackResistance } from "./core/fec.js";
import * as hr from "./core/hr.js";

const $ = (sel) => document.querySelector(sel);
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

function log(line) {
  const el = $("#log");
  const time = new Date().toLocaleTimeString("es-ES");
  el.textContent = `${time}  ${line}\n${el.textContent}`.slice(0, 20000);
}

function setControls(enabled) {
  for (const b of document.querySelectorAll("[data-slope],[data-erg]")) b.disabled = !enabled;
  $("#disconnect").disabled = !enabled;
  $("#connect").disabled = enabled;
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

$("#connect").addEventListener("click", async () => {
  $("#connect").disabled = true;
  $("#bike-status").textContent = "Conectando…";
  $("#bike-status").className = "";
  try {
    bike = await connectBike();
  } catch (err) {
    $("#connect").disabled = false;
    $("#bike-status").textContent = MESSAGES[err?.kind] ?? MESSAGES["not-found"];
    log(`✖ conexión: ${err?.kind} ${err?.cause?.name ?? ""} ${err?.cause?.message ?? ""}`);
    return;
  }
  $("#bike-status").textContent = `Conectado a ${bike.name}.`;
  $("#bike-status").className = "ok";
  setControls(false);
  $("#disconnect").disabled = false;
  $("#connect").disabled = true;
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
    $("#bike-status").textContent = "Conexión perdida.";
    $("#bike-status").className = "bad";
    setControls(false);
    log(`✖ enlace: ${e}`);
  });
  // Initial orders, spaced ourselves (the latest-wins sender would keep only the last one).
  // The test buttons stay disabled until the last one has gone out, so a tap cannot replace it.
  $("#bike-status").textContent = `Conectado a ${bike.name}. Preparando la bici…`;
  for (const [i, order] of INIT_ORDERS.entries()) {
    setTimeout(() => send(order, `inicio ${i + 1}`), i * 400);
  }
  setTimeout(
    () => {
      if (!bike) return;
      setControls(true);
      $("#bike-status").textContent =
        `Conectado a ${bike.name}. Listo: deja 1 segundo entre toques.`;
    },
    INIT_ORDERS.length * 400 + 300,
  );
  requestWakeLock();
});

$("#disconnect").addEventListener("click", () => {
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
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [0x180d] }] });
    device.addEventListener("gattserverdisconnected", () => {
      $("#bpm").textContent = "--";
      hrStatus("Pulsómetro desconectado.");
    });
    const server = await device.gatt.connect();
    const ch = await (await server.getPrimaryService(0x180d)).getCharacteristic(0x2a37);
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
