const ES = new URLSearchParams(location.search).get("lang") === "es";
const T = ES ? {
  searching: "Buscando Live", searchingSub: "Abre Ableton Live: SetPilot se conecta solo.",
  connecting: "Conectando", connected: "Listo para tocar", connectedSub: "SetPilot está conectado a Live.",
  live: "Live", ms: "respuesta", songs: "canciones",
  rTitle: "Desde el teléfono o la tablet", rText: "Escanea el código en la misma red Wi-Fi.",
  open: "Abrir dashboard", foot: "SetPilot sigue en la barra de menú cuando cierras esta ventana."
} : {
  searching: "Looking for Live", searchingSub: "Open Ableton Live: SetPilot connects by itself.",
  connecting: "Connecting", connected: "Ready to play", connectedSub: "SetPilot is connected to Live.",
  live: "Live", ms: "response", songs: "songs",
  rTitle: "From your phone or tablet", rText: "Scan the code on the same Wi-Fi network.",
  open: "Open dashboard", foot: "SetPilot stays in the menu bar when you close this window."
};
// what the installer says is left to do, in Spanish
const STEPS_ES = {
  "restart-live": "Reinicia Live una vez para que cargue SetPilot.",
  "auto-select": "Live elige SetPilot solo al arrancar. Si no lo hace, elígelo en Settings > Tempo & MIDI > Control Surface.",
  "input": "SetPilot está elegido, pero su entrada MIDI no es SetPilot Bridge. Elígela para la respuesta más rápida.",
  "no-live": "No encontré Ableton Live en esta computadora.",
  "install-failed": "No pude copiar el script de SetPilot en tu User Library."
};
const $ = id => document.getElementById(id);
$("l-live").textContent = T.live; $("l-ms").textContent = T.ms; $("l-songs").textContent = T.songs;
$("r-title").textContent = T.rTitle; $("r-text").textContent = T.rText; $("open").textContent = T.open; $("foot").textContent = T.foot;
$("open").onclick = () => window.setpilot.open("dashboard");
let lastQr = null;

async function tick() {
  let s;
  try { s = await window.setpilot.status(); } catch (e) { return; }
  const on = s.live === "connected";
  document.body.className = on ? "on" : "searching";
  $("title").textContent = on ? T.connected : s.live === "connecting" ? T.connecting : T.searching;
  $("sub").textContent = on ? T.connectedSub : T.searchingSub;
  $("f-live").textContent = on && s.liveVersion ? s.liveVersion : "–";
  $("f-ms").textContent = on && s.latency ? s.latency.p50 + " ms" : "–";
  $("f-songs").textContent = on && s.songs != null ? s.songs : "–";
  if (s.dashboard) {
    $("url").textContent = s.dashboard.url;
    $("open").disabled = false;
  }
  if (s.qr && s.qr !== lastQr) { $("qr").innerHTML = s.qr; lastQr = s.qr; }
  const steps = $("steps");
  steps.replaceChildren(...s.steps.map(x => { const p = document.createElement("p"); p.textContent = (ES && STEPS_ES[x.id]) || x.text; return p; }));
  steps.classList.toggle("show", s.steps.length > 0);
}
tick();
setInterval(tick, 1000);
