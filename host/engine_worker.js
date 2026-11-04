// The engine runs here, on its own thread, so its 20 ms tick never waits for
// the dashboard, waveform drawing or file work on the main thread.
//
// Reads come from the mirror (instant). The few calls that must wait for
// Live's answer (creating a track, importing a clip, routing) block this
// thread only: the main thread keeps the socket and the dashboard running,
// and we drain the bridge port synchronously while we wait, so every change
// Live sent before its answer is applied in order.

const { parentPort, workerData, receiveMessageOnPort } = require("worker_threads");
const { Mirror } = require("../bridge/mirror");
const { makeLiveAPI } = require("../bridge/facade");
const { loadEngine } = require("./engine_vm");

const bridge = workerData.bridgePort;
const signal = new Int32Array(workerData.sab);
let connected = false;
let q = 0;

const SLOW = new Set(["create_audio_clip", "create_audio_track"]);

function request(msg) {
	if (!connected) return { ok: false, err: "Live is not connected" };
	msg.q = ++q;
	bridge.postMessage({ out: msg });
	const deadline = Date.now() + (msg.t === "call" && SLOW.has(msg.f) ? 15000 : 3000);
	for (;;) {
		let m;
		while ((m = receiveMessageOnPort(bridge))) {
			const x = m.message;
			if (x.in && x.in.t === "res" && x.in.q === msg.q) return x.in;
			onBridge(x);
			if (!connected) return { ok: false, err: "Live disconnected" };
		}
		const left = deadline - Date.now();
		if (left <= 0) return { ok: false, err: "Live did not answer in time" };
		Atomics.wait(signal, 0, Atomics.load(signal, 0), Math.min(left, 50));
	}
}

const mirror = new Mirror({ send: msg => bridge.postMessage({ out: msg }), request });

const OWN_RE = /^(SP Cues|SetPilot)$/i;
const LiveAPI = makeLiveAPI(mirror, {
	ownTrack: m => {
		const song = m.objs.get(m.roots.song);
		for (const ref of (song && song.p.tracks) || []) {
			const tr = m.objs.get(ref.$);
			if (tr && OWN_RE.test(String(tr.p.name))) return ref.$;
		}
		return 0;
	}
});

const eng = loadEngine({
	LiveAPI,
	onOutlet: (n, flat) => parentPort.postMessage({ outlet: [n, flat] }),
	onMessnamed: (name, args) => parentPort.postMessage({ messnamed: [name, args] }),
	onPost: s => parentPort.postMessage({ post: s })
});

let started = false;
function onBridge(x) {
	if (x.state === "connected") { connected = true; return; }
	if (x.state === "disconnected") {
		connected = false;
		mirror.ready = false;
		parentPort.postMessage({ live: "disconnected" });
		return;
	}
	if (!x.in) return;
	const wasReady = mirror.ready;
	mirror.receive(x.in);
	if (x.in.t === "snap") {
		// a new snapshot: first connection, or Live reopened / loaded another set
		eng.init();
		started = true;
		parentPort.postMessage({ live: "ready", info: mirror.info, objects: mirror.objs.size, again: wasReady || undefined });
	}
}

bridge.on("message", onBridge);

parentPort.on("message", m => {
	if (m.send) { if (started) eng.send(m.send[0], m.send[1]); return; }
	if (m.setDict) { eng.dicts[m.setDict[0]] = m.setDict[1]; return; }
	if (m.getDict) { parentPort.postMessage({ dict: { id: m.getDict.id, value: eng.dicts[m.getDict.name] || null } }); return; }
	if (m.stats) { parentPort.postMessage({ stats: { id: m.stats.id, value: mirror.stats } }); return; }
});
