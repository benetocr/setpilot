// SetPilot app host: connects to Live through the SetPilot Remote Script,
// runs the engine on its own thread and serves the dashboard.
//   node host/main.js
// Environment (all optional): SETPILOT_DATA (data folder), SETPILOT_PORT
// (dashboard port), SETPILOT_DOORBELL ("udp:<port>" in tests; the app's MIDI
// port otherwise).

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { Worker, MessageChannel } = require("worker_threads");
const { LiveLink } = require("./live_link");
const { makeDoorbell } = require("./doorbell");
const { setup } = require("../installer/setup");
const { announce } = require("./announce");
const { PluginServer } = require("./plugin_server");

function dataDir() {
	if (process.env.SETPILOT_DATA) return process.env.SETPILOT_DATA;
	const home = os.homedir();
	if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "SetPilot");
	if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "SetPilot");
	return path.join(home, ".local", "share", "SetPilot");
}

function startHost({ log: logOut = console.log } = {}) {
	const DATA = dataDir();
	fs.mkdirSync(DATA, { recursive: true });
	process.env.SETPILOT_DATA = DATA;
	// Logs go where support (and the user) can find them: next to SetPilot's
	// things in the User Library when there is one, else the data folder.
	let LOG_DIR = DATA;
	try {
		const libs = require("../installer/setup").findUserLibraries();
		const lib = libs.find(l => fs.existsSync(l));
		if (lib) { LOG_DIR = path.join(lib, "SetPilot", "Logs"); fs.mkdirSync(LOG_DIR, { recursive: true }); }
	} catch (e) { }
	for (const f of ["host.log", "setpilot.log"]) {
		try { if (fs.statSync(path.join(LOG_DIR, f)).size > 5e6) fs.renameSync(path.join(LOG_DIR, f), path.join(LOG_DIR, f + ".old")); } catch (e) { }
	}
	if (!process.env.SETPILOT_LOG) process.env.SETPILOT_LOG = path.join(LOG_DIR, "setpilot.log");
	const LOG = path.join(LOG_DIR, "host.log");
	const log = (...m) => {
		const line = new Date().toISOString() + " " + m.join(" ");
		fs.appendFile(LOG, line + "\n", () => {});
		logOut(line);
	};

	// ---------------------------------------------------------------- setup
	// put the Remote Script where Live looks for it (only when missing or old)
	const status = { live: "searching", liveInfo: null, latency: null, started: Date.now(), setup: null };
	if (process.env.SETPILOT_SKIP_SETUP !== "1") {
		try {
			const r = setup();
			status.setup = r;
			for (const i of r.installed) if (i.changed) log("installed the SetPilot Remote Script in", i.dir);
			for (const i of r.plugins || []) if (i.changed) log("installed SetPilot Audio in", i.dir);
			for (const st of r.steps) log("setup:", st.text);
		} catch (e) { log("setup failed:", e.message); }
	}

	// core/setpilot_server.js asks for "max-api": give it ours
	const shimPath = require.resolve("./maxapi_shim");
	const resolve = Module._resolveFilename;
	Module._resolveFilename = function (req, ...rest) { return req === "max-api" ? shimPath : resolve.call(this, req, ...rest); };
	const maxApi = require("./maxapi_shim");
	// the audio interface and its outputs' names, for the dashboard's output choices
	const { makeAudioInfo } = require("./audio_devices");
	const audio = makeAudioInfo({
		prefsDirs: () => { try { return require("../installer/setup").prefsDirs(); } catch (e) { return []; } }, log,
		// Live switched interface: read its outputs again (the engine reads Ext. Out's channels)
		onChange: () => worker.postMessage({ send: ["routeopts", []] })
	});
	maxApi.audioInfo = () => audio.get();
	maxApi.audioRefresh = () => audio.refresh();
	audio.refresh().catch(() => {});

	// ---------------------------------------------------------------- engine thread
	const sab = new SharedArrayBuffer(4);
	const signal = new Int32Array(sab);
	const { port1, port2 } = new MessageChannel();
	// the recorded pads that come with the app (one loop per key)
	let pads = null;
	for (const dir of [process.env.SETPILOT_PADS, process.resourcesPath && path.join(process.resourcesPath, "pads"), path.join(__dirname, "..", "assets", "pads")]) {
		if (!dir) continue;
		try { const j = JSON.parse(fs.readFileSync(path.join(dir, "pads.json"), "utf8")); pads = { dir, list: j.pads }; break; } catch (e) { }
	}
	const worker = new Worker(path.join(__dirname, "engine_worker.js"), { workerData: { sab, bridgePort: port2, pads }, transferList: [port2] });
	const toBridge = x => { port1.postMessage(x); Atomics.add(signal, 0, 1); Atomics.notify(signal, 0); };
	let dictReq = 0, prepReq = 0;
	const prepWait = new Map();
	const dictWait = new Map();

	const doorbell = makeDoorbell(process.env.SETPILOT_DOORBELL, log);
	const link = new LiveLink({ doorbell: doorbell && doorbell.ring, log }).start();
	link.on("state", (s, extra) => {
		status.live = s;
		if (s === "connected") { status.liveInfo = extra; toBridge({ state: "connected" }); log("Live connected", extra && extra.live ? "(Live " + extra.live + ")" : ""); }
	});
	link.on("disconnected", why => { toBridge({ state: "disconnected" }); log("Live disconnected:", why); });
	link.on("message", m => toBridge({ in: m }));
	port1.on("message", x => {
		if (!x.out) return;
		if (!link.send(x.out) && x.out.q != null) toBridge({ in: { t: "res", q: x.out.q, ok: false, err: "not connected" } });
	});

	worker.on("message", m => {
		if (m.outlet) { if (m.outlet[0] === 0) maxApi._dispatch(m.outlet[1]); }
		else if (m.plugin) plugins.send(m.plugin.role, m.plugin.msg);
		else if (m.setRoles) status.setRoles = m.setRoles;
		else if (m.prepared && m.prepared.auto) {
			log("prepare set (" + m.prepared.auto + "):", m.prepared.ok ? (m.prepared.done.join(", ") || "nothing to do") : m.prepared.err);
			status.autoPrepared = m.prepared;
		}
		else if (m.prepared) { const w = prepWait.get(m.prepared.id); prepWait.delete(m.prepared.id); if (w) w(m.prepared); }
		else if (m.post) { if (process.env.SP_DEBUG) log("[engine]", m.post); }
		else if (m.dict) { const w = dictWait.get(m.dict.id); dictWait.delete(m.dict.id); if (w) w(m.dict.value); }
		else if (m.live === "ready") {
			log("engine ready,", m.objects, "objects from Live");
			worker.postMessage({ pluginRoles: plugins.roles() });
			calibrate();
		}
		else if (m.live === "disconnected") status.latency = null;
	});
	worker.on("error", e => log("engine thread failed:", e.stack || e.message));
	worker.on("exit", code => log("engine thread exited", code));

	maxApi._bus.on("outlet", args => {
		const [where, ...rest] = args;
		if (where === "js") worker.postMessage({ send: [rest[0], rest.slice(1)] });
		else if (where === "ui") { if (rest[0] === "status") status.text = rest.slice(1).join(" "); if (rest[0] === "url") status.url = rest[1]; }
	});
	maxApi._bus.on("post", s => log(s));
	maxApi._bus.on("getDict", (name, cb) => { const id = ++dictReq; dictWait.set(id, cb); worker.postMessage({ getDict: { id, name } }); });
	maxApi._bus.on("setDict", (name, value) => worker.postMessage({ setDict: [name, value] }));

	// ---------------------------------------------------------------- audio side
	// SetPilot Audio plugins (click, cues, guide gate, tail) connect here; the
	// engine thread decides what they play
	const plugins = new PluginServer({ log }).start();
	status.plugins = {};
	plugins.on("roles", roles => {
		status.plugins = roles;
		worker.postMessage({ pluginRoles: roles });
		log("plugins:", Object.keys(roles).join(", ") || "none");
	});
	plugins.on("event", (role, m) => worker.postMessage({ pluginEvent: { role, m } }));

	// ---------------------------------------------------------------- timing
	// Measure how long Live takes to carry out a command and tell the engine,
	// so timed changes (band in after a count-in, stop at the end) are asked
	// for that much earlier. Repeated now and then while stopped.
	async function calibrate() {
		const m = await link.measure(15);
		if (!m) return;
		status.latency = m;
		worker.postMessage({ send: ["latency", [m.p50]] });
		log("Live answers in", m.p50, "ms (95%:", m.p95 + " ms," + (m.doorbell ? " doorbell" : " no doorbell") + ")");
	}
	const recal = setInterval(() => { if (link.state === "connected") calibrate(); }, 60000);

	// ---------------------------------------------------------------- dashboard
	require(path.join(__dirname, "..", "core", "setpilot_server.js"));
	let ann = null;
	maxApi._bus.on("outlet", args => {
		if (args[0] !== "ui" || args[1] !== "url" || ann) return;
		const port = Number(String(args[2]).split(":").pop());
		ann = announce(port, log);
		status.dashboard = { url: ann.url, friendly: ann.friendly, local: "http://localhost:" + port };
		log("dashboard:", ann.url, "(also " + ann.friendly + ")");
		if (process.stdout.isTTY) ann.qr().then(q => q && console.log(q));
	});

	return {
		link, worker, status, log, dataDir: DATA,
		qrSvg: () => (ann ? ann.qrSvg() : Promise.resolve("")),
		// add SetPilot Audio tracks to the open set
		prepareSet: () => new Promise(resolve => { const id = ++prepReq; prepWait.set(id, r => { log("prepare set:", r.ok ? (r.done.join(", ") || "nothing to do") : r.err); resolve(r); }); worker.postMessage({ prepareSet: id }); }),
		// put back what the engine changed in the set (muted Guide, faders
		// mid-fade...), give Live a moment to apply it, then close
		async stop() {
			clearInterval(recal);
			worker.postMessage({ send: ["notifydeleted", []] });
			await new Promise(r => setTimeout(r, 400));
			link.stop(); worker.terminate(); plugins.stop(); if (doorbell) doorbell.close(); if (ann) ann.stop();
		}
	};
}

module.exports = { startHost, dataDir };

if (require.main === module) {
	const h = startHost();
	const bye = () => h.stop().then(() => process.exit(0));
	process.on("SIGINT", bye);
	process.on("SIGTERM", bye);
}
