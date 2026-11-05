const ES = new URLSearchParams(location.search).get("lang") === "es";
const T = ES ? {
  searching: "Buscando Live", searchingSub: "Abre Ableton Live: SetPilot se conecta solo.",
  connecting: "Conectando", connected: "Listo para tocar", connectedSub: "SetPilot está conectado a Live.",
  live: "Live", ms: "respuesta", songs: "canciones",
  rTitle: "Desde el teléfono o la tablet", rText: "Escanea el código en la misma red Wi-Fi.",
  open: "Abrir dashboard", prepare: "Preparar este set", preparing: "Preparando…",
  soundMissing: "Agrega las pistas SetPilot Cues, Click y Tail, y SetPilot Audio en tu Guide, para que SetPilot diga los cues y marque el click exacto.",
  soundFound: "SetPilot Audio está en este set. Si una parte no se pone verde, revisa que la pista no esté apagada.",
  soundNoPlugin: "Instala SetPilot Audio y vuelve a abrir Live para que SetPilot tenga su propio sonido.",
  roles: { cues: "Cues", click: "Click", guide: "Guide", tail: "Tail" }, foot: "SetPilot sigue en la barra de menú cuando cierras esta ventana."
} : {
  searching: "Looking for Live", searchingSub: "Open Ableton Live: SetPilot connects by itself.",
  connecting: "Connecting", connected: "Ready to play", connectedSub: "SetPilot is connected to Live.",
  live: "Live", ms: "response", songs: "songs",
  rTitle: "From your phone or tablet", rText: "Scan the code on the same Wi-Fi network.",
  open: "Open dashboard", prepare: "Prepare this set", preparing: "Preparing…",
  soundMissing: "Add the SetPilot Cues, Click and Tail tracks, and SetPilot Audio on your Guide, so SetPilot can speak the cues and play a sample-exact click.",
  soundFound: "SetPilot Audio is in this set. If a part does not turn green, check that its track is on.",
  soundNoPlugin: "Install SetPilot Audio and reopen Live so SetPilot has its own sound.",
  roles: { cues: "Cues", click: "Click", guide: "Guide", tail: "Tail" }, foot: "SetPilot stays in the menu bar when you close this window."
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
$("prepare").textContent = T.prepare;
$("prepare").onclick = async () => {
  const b = $("prepare");
  b.disabled = true; b.textContent = T.preparing;
  const r = await window.setpilot.prepare();
  b.disabled = false; b.textContent = T.prepare;
  if (!r.ok) $("sound-text").textContent = r.err;
};
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
  // SetPilot's own sound: which parts are in the set (grey) and playing (green)
  const roles = ["cues", "click", "guide", "tail"];
  $("roles").replaceChildren(...roles.map(r => {
    const e = document.createElement("span");
    e.textContent = T.roles[r];
    e.className = s.plugins[r] ? "in" : s.setRoles[r] ? "found" : "";
    return e;
  }));
  const missing = roles.filter(r => r !== "tail" && !s.setRoles[r]).length > 0;
  $("sound").classList.toggle("show", on);
  $("prepare").hidden = !missing;
  if ($("prepare").disabled === false && !$("sound-text").dataset.err) $("sound-text").textContent = missing ? T.soundMissing : T.soundFound;
  const steps = $("steps");
  steps.replaceChildren(...s.steps.map(x => { const p = document.createElement("p"); p.textContent = (ES && STEPS_ES[x.id]) || x.text; return p; }));
  steps.classList.toggle("show", s.steps.length > 0);
}
tick();
setInterval(tick, 1000);
