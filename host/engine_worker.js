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
const { AudioRouter } = require("./audio_router");
const { prepareSet } = require("./prepare_set");

const bridge = workerData.bridgePort;
const signal = new Int32Array(workerData.sab);
let connected = false;
let q = 0;

const SLOW = new Set(["create_audio_clip", "duplicate_clip_to_arrangement", "create_audio_track", "add_cue", "delete_cue", "insert_plugin"]);

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
let eng = null;
const router = new AudioRouter({
	mirror,
	send: (role, msg) => parentPort.postMessage({ plugin: { role, msg } }),
	reply: (cmd, args) => { if (started) eng.send(cmd, args); }
});
const LiveAPI = makeLiveAPI(mirror, {
	// the engine's "own track" is where the Cues plugin sits
	ownTrack: m => {
		const cues = router.roleTracks().cues;
		if (cues) return cues;
		const song = m.objs.get(m.roots.song);
		for (const ref of (song && song.p.tracks) || []) {
			const tr = m.objs.get(ref.$);
			if (tr && OWN_RE.test(String(tr.p.name))) return ref.$;
		}
		return 0;
	}
});

eng = loadEngine({
	LiveAPI,
	onOutlet: (n, flat) => { if (n === 1) router.outlet1(flat); else parentPort.postMessage({ outlet: [n, flat] }); },
	onMessnamed: (name, args) => router.messnamed(name, args),
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
		eng.send("voiceplayer", [router.connected.cues ? 1 : 0]);
		eng.send("cueops", [1]);
		parentPort.postMessage({ live: "ready", info: mirror.info, objects: mirror.objs.size, again: wasReady || undefined });
	}
}

bridge.on("message", onBridge);

// which roles have a SetPilot Audio in this set (for the app's "prepare" button)
let lastRoles = "";
setInterval(() => {
	if (!mirror.ready) return;
	const r = router.roleTracks(), key = JSON.stringify(r);
	if (key !== lastRoles) { lastRoles = key; parentPort.postMessage({ setRoles: r }); }
}, 1000);

parentPort.on("message", m => {
	if (m.send) { if (started) eng.send(m.send[0], m.send[1]); return; }
	if (m.setDict) { eng.dicts[m.setDict[0]] = m.setDict[1]; return; }
	if (m.getDict) { parentPort.postMessage({ dict: { id: m.getDict.id, value: eng.dicts[m.getDict.name] || null } }); return; }
	if (m.pluginRoles) { router.setConnected(m.pluginRoles); return; }
	if (m.pluginEvent) { router.event(m.pluginEvent.role, m.pluginEvent.m); return; }
	if (m.prepareSet) {
		let r;
		try { r = { ok: true, done: prepareSet({ mirror, router, log: x => parentPort.postMessage({ post: x }) }) }; }
		catch (e) { r = { ok: false, err: e.message }; }
		parentPort.postMessage({ prepared: Object.assign({ id: m.prepareSet }, r) });
		return;
	}
	// tests and support: the arrangement clips between two beats, as the mirror has them
	if (m.dumpClips) {
		const [a, b] = m.dumpClips, out = [], song = mirror.objs.get(mirror.roots.song);
		for (const tref of (song && song.p.tracks) || []) {
			const tr = mirror.objs.get(tref.$);
			for (const cref of (tr && tr.p.arrangement_clips) || []) {
				const c = mirror.objs.get(cref.$);
				if (c && c.p.start_time >= a - 0.001 && c.p.start_time < b) out.push({ track: tr.p.name, st: c.p.start_time, et: c.p.end_time, sm: c.p.start_marker, em: c.p.end_marker, pitch: c.p.pitch_coarse });
			}
		}
		parentPort.postMessage({ clipsDump: out });
		return;
	}
	if (m.stats) { parentPort.postMessage({ stats: { id: m.stats.id, value: mirror.stats } }); return; }
});
