// SetPilot server: runs inside [node.script] in the Max for Live device.
// Serves the dashboard on the local network and relays commands to the
// engine. No npm dependencies and no internet required.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseAls, findSessions, findByName, guessInstr, INSTR } = require("./setpilot_als.js");
const { buildTail, afconvertDecoder, buildWave, buildCounted, normalizeCueFile, extractGuide } = require("./setpilot_tail.js");

let maxApi = null;
try { maxApi = require("max-api"); } catch (e) { maxApi = null; }

const UI_DIR = path.join(__dirname, "ui");
// where logs, setlists, cues, waveforms and tails are kept: next to the
// device inside Max, in the user's app data folder in the app
const DATA_DIR = process.env.SETPILOT_DATA || __dirname;
const BASE_PORT = Number(process.env.SETPILOT_PORT) || 8780;
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".mp4": "video/mp4",
	".woff2": "font/woff2"
};

// Commands the dashboard may send, with the number of numeric args they take.
const COMMANDS = {
	play: 0, stop: 0, toggle: 0, cancel: 0, loopoff: 0,
	nextsong: 0, prevsong: 0, nextsec: 0, prevsec: 0, refresh: 0,
	selectsong: 2, playsong: 1, section: 3, loop: 2, repeat: 2,
	autostop: 1, setorder: -1, cuemode: 1, cuebars: 1, cuelang: 1,
	clickon: 1, clicksound: 1, clicksub: 1, clickmute: 1, clickaccent: 2, clicklevel: 2,
	temposet: 2, keyset: 2, clearfrom: 1, transition: 2, transdefault: 1, warpinfo: 1, rewarpsong: 1, mixvol: 2, mixmute: 2, mixsolo: 2, mixeron: 0,
	precount: 1, cuestyle: 1, arrset: -1, arrgo: 3, selectmed: 2, medgo: 3, playmed: 1, medlisten: 2, clipinfo: 1, cuesource: 1, warpcheck: 1, fadeout: 1, fadein: 1, autoset: 5, autoclear: 3, movesec: 3, wave: 1, routeopts: 0, setoutput: 2, applyoutputs: 0, settrackinstr: 2
};

function lanAddress() {
	const nets = os.networkInterfaces();
	for (const name of Object.keys(nets)) {
		for (const n of nets[name] || []) {
			if (n.family === "IPv4" && !n.internal) return n.address;
		}
	}
	return "localhost";
}

function start(engine) {
	// engine: { send(cmd, args), log(...msg), ui(key, value) }
	let struct = null;
	let pos = null;
	let port = BASE_PORT;
	const clients = new Set();

	function broadcast(event, data) {
		const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const res of clients) {
			try { res.write(line); } catch (e) { clients.delete(res); }
		}
	}

	function setStruct(obj) {
		struct = obj;
		broadcast("struct", struct);
	}

	function setPos(args) {
		const a = args.map(Number);
		pos = {
			t: a[0], playing: a[1], tempo: a[2], sigNum: a[3], sigDen: a[4],
			song: a[5], sec: a[6],
			qSong: a[7], qSec: a[8], qFired: a[9],
			loopSong: a[10], loopSec: a[11], loopOnce: a[12], liveLoop: a[13],
			armSong: a[14], pendingSong: a[15], autoStop: a[16], version: a[17], fade: a[18] || 0, countIn: a[19] || 0, arrK: a[20] == null ? -1 : a[20], qArrK: a[21] == null ? -1 : a[21], qAuto: a[22] || 0, med: a[23] == null ? -1 : a[23], medK: a[24] == null ? -1 : a[24], qMedK: a[25] == null ? -1 : a[25],
			at: Date.now()
		};
		broadcast("pos", pos);
	}

	let cue = null, voice = null, lastImport = null, mixer = null, routes = null;
	const waves = {};
	function setWave(w) { waves[w.song] = w; broadcast("wave", w); }
	function setRoutes(r) { routes = r; broadcast("routes", routes); }
	function setMixer(m) { mixer = m; broadcast("mixer", mixer); }
	function setMeters(args) { broadcast("meters", args.map(Number)); }
	let lastGap = 4;
	const importRoots = engine.importRoots || ["Downloads", "Desktop", "Music", "Documents"].map(d => path.join(os.homedir(), d));

	function setNotice(args) {
		broadcast("notice", { kind: String(args[0]), a: args[1] == null ? "" : String(args[1]), b: args[2] == null ? "" : args[2], c: args[3] == null ? "" : args[3], at: Date.now() });
	}

	function setImport(args) {
		lastImport = { kind: String(args[0]), a: args[1], b: args[2], c: args[3], at: Date.now() };
		broadcast("import", lastImport);
	}

	// parse a song's Live Set and hand the plan to the engine
	function importFile(opts) {
		let file = String(opts.path || "");
		try {
			if (fs.statSync(file).isDirectory()) {
				const als = fs.readdirSync(file).find(f => f.toLowerCase().endsWith(".als"));
				if (!als) return { ok: false, error: "no_als" };
				file = path.join(file, als);
			}
		} catch (e) { return { ok: false, error: "not_found" }; }
		let p;
		try { p = parseAls(file); } catch (e) { engine.log("import parse failed", e.message); return { ok: false, error: "parse" }; }
		if (!p.tracks.length) return { ok: false, error: "no_audio" };
		const gap = [0, 2, 4, 8, 16, 32].includes(Number(opts.gap)) ? Number(opts.gap) : lastGap;
		lastGap = gap;
		const plan = {
			title: String(opts.title || p.title).slice(0, 80),
			key: /^[A-G](#|b)?m?$/.test(opts.key || "") ? opts.key : p.key,
			bpm: Number(opts.bpm) > 0 ? Number(opts.bpm) : p.bpm,
			meter: p.meter, gap, end: p.end,
			locators: p.locators,
			instr: opts.instr && typeof opts.instr === "object" ? opts.instr : Object.fromEntries(p.tracks.map(t => [t.name, guessInstr(t.name)])),
			tracks: p.tracks.map(t => ({ name: t.name, clips: t.clips.map(c => ({ time: c.time, file: c.file, startBeat: c.startBeat, length: c.length, markers: c.markers })) }))
		};
		engine.importPlan(plan);
		return { ok: true, title: plan.title, key: plan.key, bpm: plan.bpm, sections: p.locators.length, tracks: p.tracks.length, missing: p.missing, tempoChanges: p.tempoChanges };
	}
	function setCue(args) {
		cue = { speak: Number(args[0]) || 0, natural: Number(args[1]) || 0, text: args.slice(2).join(" ") };
		broadcast("cue", cue);
	}
	function setVoice(v) { voice = v; broadcast("voice", voice); }

	function runCommand(cmd, args) {
		if (!(cmd in COMMANDS)) return false;
		const n = COMMANDS[cmd];
		let list = Array.isArray(args) ? args.map(v => parseInt(v, 10)).filter(v => !isNaN(v)) : [];
		if (n >= 0) {
			while (list.length < n) list.push(0);
			list = list.slice(0, n);
		}
		engine.send(cmd, list);
		return true;
	}

	function serveFile(res, file) {
		const full = path.join(UI_DIR, path.normalize(file).replace(/^(\.\.[\/\\])+/, ""));
		if (!full.startsWith(UI_DIR)) { res.writeHead(403); res.end(); return; }
		fs.readFile(full, (err, buf) => {
			if (err) { res.writeHead(404); res.end("not found"); return; }
			res.writeHead(200, {
				"Content-Type": MIME[path.extname(full)] || "application/octet-stream",
				"Cache-Control": "no-cache"
			});
			res.end(buf);
		});
	}

	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		if (req.method === "GET" && url.pathname === "/events") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				"Connection": "keep-alive",
				"X-Accel-Buffering": "no"
			});
			res.write("retry: 1000\n\n");
			if (struct) res.write(`event: struct\ndata: ${JSON.stringify(struct)}\n\n`);
			if (pos) res.write(`event: pos\ndata: ${JSON.stringify(pos)}\n\n`);
			if (cue) res.write(`event: cue\ndata: ${JSON.stringify(cue)}\n\n`);
			if (voice) res.write(`event: voice\ndata: ${JSON.stringify(voice)}\n\n`);
			if (mixer) res.write(`event: mixer\ndata: ${JSON.stringify(mixer)}\n\n`);
			if (routes) res.write(`event: routes\ndata: ${JSON.stringify(routes)}\n\n`);
			for (const k of Object.keys(waves)) res.write(`event: wave\ndata: ${JSON.stringify(waves[k])}\n\n`);
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		if (req.method === "POST" && url.pathname === "/cmd") {
			let body = "";
			req.on("data", c => { body += c; if (body.length > 1e5) req.destroy(); });
			req.on("end", () => {
				let ok = false;
				try {
					const msg = JSON.parse(body || "{}");
					ok = runCommand(String(msg.cmd || ""), msg.args || []);
				} catch (e) { ok = false; }
				res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok }));
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/import/list") {
			let list = [];
			try { list = findSessions(importRoots); } catch (e) { list = []; }
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
			res.end(JSON.stringify({ sessions: list, gap: lastGap }));
			return;
		}
		if (req.method === "POST" && url.pathname === "/import/peek") {
			let body = "";
			req.on("data", c => { body += c; if (body.length > 1e4) req.destroy(); });
			req.on("end", () => {
				let out;
				try {
					let file = String(JSON.parse(body || "{}").path || "");
					if (fs.statSync(file).isDirectory()) file = path.join(file, fs.readdirSync(file).find(f => f.toLowerCase().endsWith(".als")) || "");
					const p = parseAls(file);
					out = { ok: true, kinds: INSTR, tracks: p.tracks.map(t => ({ name: t.name, instr: guessInstr(t.name) })) };
				} catch (e) { out = { ok: false, error: "parse" }; }
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(out));
			});
			return;
		}
		if (req.method === "POST" && url.pathname === "/import/find") {
			let body = "";
			req.on("data", c => { body += c; if (body.length > 1e4) req.destroy(); });
			req.on("end", () => {
				let out = { ok: false };
				try {
					const q = JSON.parse(body || "{}");
					const home = os.homedir();
					const roots = importRoots.map(dir => ({ dir, depth: 5 })).concat([{ dir: home, depth: 3 }, { dir: "/Volumes", depth: 4 }]);
					const hits = findByName(roots, q.name, q.size, q.mtime);
					if (hits.length) {
						const meta = findSessions([path.dirname(hits[0].path)]).find(x => x.path === hits[0].path);
						out = { ok: true, session: meta || { path: hits[0].path, title: path.basename(hits[0].path, ".als"), folder: path.basename(path.dirname(hits[0].path)), key: "", bpm: 0, mtime: hits[0].mtime } };
					} else out = { ok: false, error: "not_found" };
				} catch (e) { out = { ok: false, error: "bad_request" }; }
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(out));
			});
			return;
		}
		if (req.method === "POST" && url.pathname === "/import") {
			let body = "";
			req.on("data", c => { body += c; if (body.length > 1e5) req.destroy(); });
			req.on("end", () => {
				let out;
				try { out = importFile(JSON.parse(body || "{}")); } catch (e) { out = { ok: false, error: "bad_request" }; }
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(out));
			});
			return;
		}
		// a medley from the wizard (names and sections don't fit /cmd's numbers)
		if (req.method === "POST" && url.pathname === "/medley") {
			let body = "";
			req.on("data", c => { body += c; if (body.length > 2e5) req.destroy(); });
			req.on("end", () => {
				let out = { ok: false };
				try {
					const o = JSON.parse(body || "{}");
					const okBuild = o && o.action === "build" && o.medley && Array.isArray(o.medley.parts) && o.medley.parts.length;
					const okDel = o && (o.action === "delete" || o.action === "unbuild") && o.id;
					const okSave = o && o.medley && Array.isArray(o.medley.slots) && o.medley.slots.length;
					if (okBuild || okDel || okSave) {
						if (engine.medley) engine.medley(o);
						out = { ok: true };
					} else out = { ok: false, error: "bad_medley" };
				} catch (e) { out = { ok: false, error: "bad_request" }; }
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(out));
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/state") {
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
			res.end(JSON.stringify({ struct, pos, cue, voice, mixer, routes }));
			return;
		}
		if (req.method === "GET") {
			serveFile(res, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
			return;
		}
		res.writeHead(405); res.end();
	});

	// keep proxies and iPads from dropping idle streams
	setInterval(() => {
		for (const res of clients) { try { res.write(": ping\n\n"); } catch (e) { clients.delete(res); } }
	}, 15000);

	function listen() {
		server.once("error", err => {
			if (err.code === "EADDRINUSE" && port < BASE_PORT + 10) { port++; listen(); }
			else engine.log("server error", err.message);
		});
		server.listen(port, "0.0.0.0", () => {
			const url = `http://${lanAddress()}:${port}`;
			engine.log("dashboard", url);
			engine.ui("url", url);
			engine.ui("local", `http://localhost:${port}`);
		});
	}
	listen();

	return {
		setStruct, setPos, setCue, setVoice, setImport, setNotice, setMixer, setMeters, setRoutes, setWave, importFile, runCommand,
		get url() { return `http://localhost:${port}`; },
		close() { server.close(); for (const r of clients) r.end(); }
	};
}

module.exports = { start };

// ---------------------------------------------------------------- inside Max
if (maxApi) {
	const LOG = process.env.SETPILOT_LOG || path.join(DATA_DIR, "setpilot.log");
	const writeLog = (...m) => {
		const line = new Date().toISOString() + " " + m.join(" ") + "\n";
		fs.appendFile(LOG, line, () => {});
	};
	writeLog("server starting, node", process.version);
	let localUrl = `http://localhost:${BASE_PORT}`;
	const srv = start({
		send(cmd, args) { maxApi.outlet("js", cmd, ...args); },
		medley(o) {
			// one JSON message, like the stored setlist (no dict object needed in the patch)
			maxApi.outlet("js", "medleyjson", JSON.stringify(o));
		},
		importPlan(plan) {
			maxApi.setDict("setpilot_import", plan)
				.then(() => maxApi.outlet("js", "importplan"))
				.catch(e => { writeLog("import dict failed", e && (e.message || JSON.stringify(e))); srv.setImport(["error", "dict"]); });
		},
		log(...msg) { maxApi.post(msg.join(" ")); writeLog(...msg); },
		ui(key, value) {
			if (key === "local") localUrl = value;
			else maxApi.outlet("ui", key, value);
		}
	});
	maxApi.addHandler("pos", (...args) => srv.setPos(args));
	// setlist order per set, saved next to the device
	const crypto = require("crypto");
	const STORE_DIR = path.join(DATA_DIR, "setlists");
	let current = null;
	const restoredFor = {};
	const keyFor = d => crypto.createHash("sha1")
		.update(((d && d.songs) || []).map(s => s.name).sort().join("\n")).digest("hex").slice(0, 16);

	maxApi.addHandler("struct", async () => {
		try {
			const d = await maxApi.getDict("setpilot_struct");
			current = d;
			srv.setStruct(d);
			queuePrepare(d);
			const key = keyFor(d);
			if (d && d.songs && d.songs.length && !restoredFor[key]) {
				restoredFor[key] = true;
				fs.readFile(path.join(STORE_DIR, key + ".json"), "utf8", (err, txt) => {
					// outputs per instrument are the same for every set (same interface): use the last ones
					let data = {};
					try { data = !err && txt ? JSON.parse(txt) : {}; } catch (e) { data = {}; }
					const def = readDefaults();
					if (def.outputs && !(data.instr && data.instr.outputs && Object.keys(data.instr.outputs).length)) {
						data.instr = Object.assign({}, data.instr || {}, { outputs: def.outputs });
					}
					if (Object.keys(data).length) { writeLog("restoring setlist", key); maxApi.outlet("js", "restore", JSON.stringify(data)); }
				});
			}
		}
		catch (e) { writeLog("struct read failed: " + e.message); }
	});
	// ------------------------------------------------ voice cues
	// Every section name gets a short spoken file made with the Mac's own
	// voices (say). A file with the same name in cues/custom/ wins, so a
	// team can record its own voice.
	const { execFile } = require("child_process");
	const CUE_DIR = path.join(DATA_DIR, "cues");
	const CUSTOM_DIR = path.join(CUE_DIR, "custom");
	let voices = null;
	let voiceKey = "";
	const slug = t => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cue";
	const ES_WORDS = /\b(verso|coro|puente|estribillo|interludio|final|precoro|pre coro|instrumental|entrada|salida|refran)\b/i;

	function listVoices() {
		return new Promise(resolve => {
			if (voices) return resolve(voices);
			if (process.platform !== "darwin") { voices = []; return resolve(voices); }
			execFile("/usr/bin/say", ["-v", "?"], { maxBuffer: 4 << 20 }, (err, out) => {
				voices = [];
				try { fs.mkdirSync(CUE_DIR, { recursive: true }); fs.writeFileSync(path.join(CUE_DIR, "voices.txt"), (err ? "ERR " + err.message + "\n" : "") + out); } catch (e) { }
				if (!err) for (const line of out.split("\n")) {
					const m = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]{2,})\s+#/);
					if (m) voices.push({ name: m[1].trim(), lang: m[2].replace("-", "_") });
				}
				resolve(voices);
			});
		});
	}

	function pickVoice(list, lang) {
		const novelty = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Kathy|Ralph|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/;
		const region = lang === "es" ? ["es_MX", "es_US", "es_419", "es_ES"] : ["en_US", "en_GB", "en_AU", "en_CA"];
		let best = null, bestScore = -1;
		for (const v of list) {
			if (!v.lang.startsWith(lang + "_") || novelty.test(v.name)) continue;
			let score = 10 - Math.max(0, region.indexOf(v.lang) < 0 ? 5 : region.indexOf(v.lang));
			if (/premium/i.test(v.name)) score += 30;
			else if (/enhanced|mejorad/i.test(v.name)) score += 20;
			if (/^(Paulina|Mónica|Monica|Samantha|Ava|Zoe|Allison)\b/.test(v.name)) score += 5;
			if (score > bestScore) { bestScore = score; best = v; }
		}
		return best;
	}

	function speak(voice, text, out, rate) {
		return new Promise(resolve => {
			const args = ["-r", String(rate || 185), "-o", out, "--file-format=WAVE", "--data-format=LEI16@44100"];
			if (voice) args.unshift("-v", voice.name);
			args.push(text);
			execFile("/usr/bin/say", args, err => resolve(!err));
		});
	}

	// Cue sources, best first: a recording in cues/custom/, the song's own guide
	// (its Guide stem, cut at import), the Mac's voice. All of them trimmed to
	// the words and at the same speech level (normalized once, then cached).
	const GUIDE_DIR = path.join(CUE_DIR, "guide");
	const guides = {};   // song name -> { key, cues: { text: file }, nums: [two, three, four] | null }
	try {
		for (const d of fs.readdirSync(GUIDE_DIR)) {
			try { const ix = JSON.parse(fs.readFileSync(path.join(GUIDE_DIR, d, "index.json"), "utf8")); if (ix && ix.song) guides[ix.song] = ix; } catch (e) { }
		}
	} catch (e) { }

	async function macVoice(voice, vdir, text, rate) {
		const file = path.join(vdir, slug(text) + (rate ? "-" + rate : "") + ".wav");
		if (fs.existsSync(file)) return file;
		const raw = file + ".raw.wav";
		if (!(await speak(voice, text, raw, rate))) return null;
		try { normalizeCueFile(raw, file); } finally { fs.unlink(raw, () => {}); }
		return file;
	}
	function customCue(text) {
		for (const ext of [".wav", ".aif", ".aiff"]) {
			const c = path.join(CUSTOM_DIR, slug(text) + ext);
			if (!fs.existsSync(c)) continue;
			const st = fs.statSync(c);
			const out = path.join(CUSTOM_DIR, ".normalized", slug(text) + "-" + Math.round(st.mtimeMs) + ".wav");
			if (fs.existsSync(out)) return out;
			if (ext !== ".wav") return c;   // only wav files are measured; others play as they are
			try { fs.mkdirSync(path.dirname(out), { recursive: true }); return normalizeCueFile(c, out); } catch (e) { return c; }
		}
		return null;
	}

	async function prepareCues(d) {
		const texts = (d && d.cueTexts) || [];
		const setting = (d && d.settings && d.settings.cueLang) || 0;
		let lang = setting === 1 ? "es" : setting === 2 ? "en" : (texts.some(t => ES_WORDS.test(t.replace(/^[gu]\|[^|]*\|/, ""))) ? "es" : "en");
		const list = await listVoices();
		const voice = pickVoice(list, lang) || pickVoice(list, lang === "es" ? "en" : "es");
		if (!prepareCues.logged) {
			prepareCues.logged = true;
			writeLog("voices " + lang + ":", list.filter(v => v.lang.startsWith(lang)).map(v => v.name + "/" + v.lang).join(", "));
		}
		// "-n1": normalized files; older ones are made again
		const vdir = path.join(CUE_DIR, slug(voice ? voice.name : "default") + "-n1");
		const loaded = new Set((d && d.cueLoaded) || []);
		const gsig = Object.keys(guides).map(k => k + ":" + guides[k].key).join(",");
		const key = (voice ? voice.name : "") + "|" + gsig + "|" + texts.join("|");
		const fresh = key !== voiceKey;
		voiceKey = key;
		srv.setVoice({ name: voice ? voice.name : "", lang });
		fs.mkdirSync(vdir, { recursive: true });
		const NUMS = lang === "es" ? ["dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho"] : ["two", "three", "four", "five", "six", "seven", "eight"];
		let fromGuide = 0;
		// a medley ("u|id|Text") speaks with one voice: its song's guide when that
		// guide has every cue of the medley, else the Mac voice for all of them
		const unit = {};
		for (const full of texts) {
			const u = /^u\|([^|]*)\|(.*)$/.exec(full);
			if (!u) continue;
			const id = u[1], name = u[2].replace(/@[\d.]+@\d+$/, "");
			(unit[id] = unit[id] || { names: new Set(), counted: false }).names.add(name);
			if (u[2] !== name) unit[id].counted = true;
		}
		const medVoice = {};
		for (const id of Object.keys(unit)) {
			const m = ((d && d.medleys) || []).find(x => String(x.id) === id);
			const voiceSong = m && (m.voice || (m.slots && m.slots[0] && d.songs[m.slots[0].s] && d.songs[m.slots[0].s].name));
			const gi = voiceSong ? guides[voiceSong] : null;
			const all = gi && [...unit[id].names].every(n => gi.cues[n] && fs.existsSync(gi.cues[n])) && (!unit[id].counted || (gi.nums && gi.nums.length >= 3));
			medVoice[id] = all ? voiceSong : null;
		}
		for (const full of texts) {
			if (!fresh && loaded.has(full)) continue;
			// "g|Song|Text" asks for the song's own guide when it has that cue
			let song = null, k = full;
			const g = /^g\|([^|]*)\|(.*)$/.exec(full);
			if (g) { song = g[1]; k = g[2]; }
			const u = /^u\|([^|]*)\|(.*)$/.exec(full);
			if (u) { song = medVoice[u[1]] || null; k = u[2]; }
			const gi = song ? guides[song] : null;
			const m = /^(.*)@([\d.]+)@(\d+)$/.exec(k);
			const text = m ? m[1] : k;
			try {
				let nameFile = customCue(text);
				if (!nameFile && gi && gi.cues[text] && fs.existsSync(gi.cues[text])) { nameFile = gi.cues[text]; fromGuide++; }
				if (!m) {
					if (!nameFile) nameFile = await macVoice(voice, vdir, text);
					if (!nameFile) { writeLog("voice failed for", text); continue; }
					maxApi.outlet("js", "cuefile", full, nameFile);
					continue;
				}
				// counted: "Chorus, two, three, four" at this tempo and meter
				const bpm = Number(m[2]), beats = Math.max(2, Math.min(8, Number(m[3])));
				const fromG = !!(gi && nameFile === gi.cues[text]);
				const cdir = path.join(fromG ? path.dirname(nameFile) : vdir, "counted");
				fs.mkdirSync(cdir, { recursive: true });
				const out = path.join(cdir, slug(text) + "-" + bpm + "-" + beats + (fromG ? "" : "-" + slug(voice ? voice.name : "v")) + ".wav");
				if (!fs.existsSync(out)) {
					if (!nameFile) nameFile = await macVoice(voice, vdir, text, 215);
					if (!nameFile) throw new Error("say failed");
					const nums = [];
					for (let b = 2; b <= beats; b++) {
						// the guide's own count when it has one, else the Mac voice
						let nf = fromG && gi.nums && gi.nums[b - 2] && fs.existsSync(gi.nums[b - 2]) ? gi.nums[b - 2] : null;
						if (!nf) nf = await macVoice(voice, vdir, NUMS[b - 2], 215);
						if (!nf) throw new Error("say failed");
						nums.push(nf);
					}
					buildCounted(nameFile, nums, bpm, out);
				}
				maxApi.outlet("js", "cuefile", full, out);
			} catch (e) { writeLog("cue failed for", full, e.message); }
		}
		if (fresh) writeLog("cues ready:", texts.length, "voice", voice ? voice.name : "none", lang, fromGuide ? "(" + fromGuide + " from guides)" : "");
	}

	// the engine sends a song's Guide clip and sections: cut its cues once
	let guideChain = Promise.resolve();
	maxApi.addHandler("guideprep", (i) => {
		guideChain = guideChain.then(async () => {
			let plan;
			try { plan = await maxApi.getDict("setpilot_guide_" + i); } catch (e) { return; }
			if (!plan || !plan.clip || !plan.clip.file) return;
			let st;
			try { st = fs.statSync(plan.clip.file); } catch (e) { writeLog("guide missing", plan.clip.file); return; }
			const key = require("crypto").createHash("sha1").update(JSON.stringify([plan.clip, plan.sections, plan.ref, plan.bl, st.size, st.mtimeMs, 2])).digest("hex").slice(0, 16);
			if (guides[plan.song] && guides[plan.song].key === key) return;
			const dir = path.join(GUIDE_DIR, slug(plan.song));
			try {
				const t0 = Date.now();
				const r = await extractGuide(plan, { decode, cacheDir: path.join(DATA_DIR, "waves", "seg"), outDir: dir, log: m => writeLog(m) });
				const ix = { song: plan.song, key, cues: r.cues, nums: r.nums, found: r.found, total: r.total };
				fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(ix));
				guides[plan.song] = ix;
				writeLog("guide ready: " + plan.song + " in " + (Date.now() - t0) + " ms");
				maxApi.outlet("js", "guideready", plan.song, r.found, r.total);
				voiceKey = "";
				if (current) queuePrepare(current);
			} catch (e) { writeLog("guide failed for " + plan.song + ": " + e.message); }
		});
	});
	maxApi.addHandler("notice", (...args) => srv.setNotice(args));

	let preparing = Promise.resolve();
	const queuePrepare = d => { preparing = preparing.then(() => prepareCues(d)).catch(e => writeLog("cue prep failed", e.message)); };
	maxApi.addHandler("mixer", async () => {
		try { srv.setMixer(await maxApi.getDict("setpilot_mixer")); } catch (e) { writeLog("mixer read failed: " + e.message); }
	});
	maxApi.addHandler("meters", (...args) => srv.setMeters(args));
	maxApi.addHandler("cueplan", (...args) => srv.setCue(args));
	maxApi.addHandler("cuefired", () => {});
	maxApi.addHandler("importmsg", (...args) => srv.setImport(args));
	// a Live Set dropped on the device
	maxApi.addHandler("importpath", (...args) => {
		let p = args.join(" ").replace(/^"|"$/g, "");
		p = p.replace(/^[^/:]+:(?=\/)/, "");   // "Macintosh HD:/Users/..." -> "/Users/..."
		writeLog("dropped", p);
		const r = srv.importFile({ path: p });
		if (!r.ok) { srv.setImport(["error", r.error]); maxApi.outlet("ui", "status", "Import failed: " + r.error); }
		else maxApi.outlet("ui", "status", "Importing " + r.title + "...");
	});

	// ------------------------------------------------ song tails (Overlap, Crossfade)
	const TAIL_DIR = path.join(DATA_DIR, "tails");
	const decode = afconvertDecoder(path.join(os.tmpdir(), "setpilot"));
	const lastTail = {};
	let tailChain = Promise.resolve();
	let waveChain = Promise.resolve();
	maxApi.addHandler("waveprep", () => {
		waveChain = waveChain.then(async () => {
			const t0 = Date.now();
			try {
				const plan = await maxApi.getDict("setpilot_wave");
				const w = await buildWave(plan, { cacheDir: path.join(DATA_DIR, "waves"), log: writeLog });
				srv.setWave(w);
				writeLog("wave ready:", plan.song, w.peaks.length, "points in", Date.now() - t0, "ms");
			} catch (e) { writeLog("wave failed:", e.message); }
		});
	});
	maxApi.addHandler("tailprep", (job) => {
		tailChain = tailChain.then(async () => {
			const t0 = Date.now();
			try {
				const plan = await maxApi.getDict("setpilot_tail");
				const r = await buildTail(plan, { outDir: TAIL_DIR, cacheDir: path.join(TAIL_DIR, "cache"), decode, log: writeLog });
				const prev = lastTail[plan.song];
				if (prev && prev !== r.file) fs.unlink(prev, () => {});
				lastTail[plan.song] = r.file;
				writeLog("tail ready:", plan.song, r.clips, "clips,", r.seconds.toFixed(1), "s, in", Date.now() - t0, "ms");
				maxApi.outlet("js", "tailready", job, r.file);
			} catch (e) {
				writeLog("tail failed:", e.message);
				maxApi.outlet("js", "tailfailed", job);
			}
		});
	});

	const DEFAULTS = path.join(STORE_DIR, "defaults.json");
	function readDefaults() { try { return JSON.parse(fs.readFileSync(DEFAULTS, "utf8")); } catch (e) { return {}; } }
	maxApi.addHandler("routes", async () => {
		try { srv.setRoutes(await maxApi.getDict("setpilot_routes")); } catch (e) { writeLog("routes read failed: " + e.message); }
	});
	maxApi.addHandler("store", (...args) => {
		if (!current) return;
		try {
			const o = JSON.parse(args.join(" "));
			if (o.instr && o.instr.outputs) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
				fs.writeFileSync(DEFAULTS, JSON.stringify({ outputs: o.instr.outputs }));
			}
		} catch (e) { }
		// the file is named after the songs the engine saved, not the last song list
		// we heard of: right after an import the two can differ for a moment
		let key = keyFor(current);
		try {
			const o = JSON.parse(args.join(" "));
			if (Array.isArray(o.order) && o.order.length) key = keyFor({ songs: o.order.map(n => ({ name: n })) });
		} catch (e) { }
		restoredFor[key] = true;
		fs.mkdir(STORE_DIR, { recursive: true }, () => {
			fs.writeFile(path.join(STORE_DIR, key + ".json"), args.join(" "), err => {
				if (err) writeLog("store failed", err.message);
			});
		});
	});
	// ask the engine to resend everything; it may have started before us
	setTimeout(() => maxApi.outlet("js", "hello"), 200);
	setTimeout(() => maxApi.outlet("js", "hello"), 2000);
	maxApi.addHandler("status", (...args) => maxApi.outlet("ui", "status", args.join(" ")));
	maxApi.addHandler("log", (...args) => writeLog("[engine]", ...args));
	maxApi.addHandler(maxApi.MESSAGE_TYPES.ALL, (handled, ...args) => {
		if (!handled) writeLog("[unhandled]", ...args);
	});
	maxApi.addHandler("openui", () => {
		const { exec } = require("child_process");
		const cmd = process.platform === "win32" ? `start "" "${localUrl}"` : `open "${localUrl}"`;
		exec(cmd);
	});
}
