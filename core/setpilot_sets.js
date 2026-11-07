// Saved setlists: a setlist kept by name, so it can be opened again in a new,
// empty Live set. It holds where each song came from (its Live Set file), the
// medleys built from them, and everything SetPilot knows about the setlist
// (order, keys, tempos, arrangements, transitions, cue settings).
//
// Opening one imports the songs again one after the other, builds the
// medleys, and puts every setting back.

const fs = require("fs");
const path = require("path");

const slug = t => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "setlist";

function makeSets(o) {
	// o: { dataDir, importFile(opts), medley(body), clickSong(spec), restore(json), getStore(), getStruct(),
	//      broadcast(event, data), findByName(roots, name, size, mtime), roots, log }
	const SETS_DIR = path.join(o.dataDir, "sets");
	const SOURCES = path.join(o.dataDir, "sources.json");
	const MEDLEYS = path.join(o.dataDir, "medleys-built.json");
	const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
	const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };
	const log = o.log || (() => {});

	// ------------------------------------------------ what each song came from
	function rememberImport(title, file, opts) {
		const all = readJson(SOURCES, {});
		let st = null;
		try { st = fs.statSync(file); } catch (e) { }
		all[title] = { path: file, name: path.basename(file), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0, instr: opts.instr || null, gap: opts.gap, key: opts.key || "", bpm: Number(opts.bpm) || 0, at: Date.now() };
		writeJson(SOURCES, all);
	}
	function rememberMedley(body) {
		if (!body || !body.medley || !body.medley.name) return;
		const all = readJson(MEDLEYS, {});
		all[body.medley.name] = { at: body.at, medley: body.medley, when: Date.now() };
		writeJson(MEDLEYS, all);
	}

	// ------------------------------------------------ the list
	function list() {
		let files = [];
		try { files = fs.readdirSync(SETS_DIR).filter(f => f.endsWith(".json")); } catch (e) { }
		return files.map(f => {
			const s = readJson(path.join(SETS_DIR, f), null);
			if (!s) return null;
			return { id: f.replace(/\.json$/, ""), name: s.name, savedAt: s.savedAt, songs: (s.order || []).map(n => ({ name: n, medley: !!(s.songs[n] && s.songs[n].medley), click: !!(s.songs[n] && s.songs[n].click), missing: !!(s.songs[n] && s.songs[n].missing) })) };
		}).filter(Boolean).sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
	}

	function save(name) {
		const struct = o.getStruct();
		if (!struct || !struct.songs || !struct.songs.length) return { ok: false, error: "empty" };
		name = String(name || "").trim().slice(0, 80) || "Setlist";
		let store = null;
		try { store = JSON.parse(o.getStore() || "null"); } catch (e) { store = null; }
		const names = struct.songs.map(s => s.name);
		const order = store && Array.isArray(store.order) && store.order.length ? store.order.filter(n => names.includes(n)) : [];
		for (const n of names) if (!order.includes(n)) order.push(n);
		const sources = readJson(SOURCES, {}), built = readJson(MEDLEYS, {});
		const songs = {};
		let missing = 0;
		const missingNames = [];
		for (const n of order) {
			const sg = struct.songs.find(s => s.name === n);
			if (sg && sg.clk) songs[n] = { click: { bpm: sg.bpm || 120, key: sg.key || "", bars: sg.clk.bars || 0, pad: sg.clk.pad === 0 ? 0 : 1 } };
			else if (sg && sg.med && built[n]) songs[n] = { medley: built[n] };
			else if (sources[n]) songs[n] = { source: sources[n] };
			else { songs[n] = { missing: true }; missing++; missingNames.push(n); }
		}
		const id = slug(name);
		writeJson(path.join(SETS_DIR, id + ".json"), { v: 1, name, savedAt: new Date().toISOString(), order, songs, store });
		log("setlist saved:", name, order.length, "songs", missing ? "(" + missing + " without a source)" : "");
		o.broadcast("sets", list());
		return { ok: true, id, missing, missingNames };
	}

	function remove(id) {
		try { fs.unlinkSync(path.join(SETS_DIR, slug(id) + ".json")); } catch (e) { return { ok: false, error: "not_found" }; }
		o.broadcast("sets", list());
		return { ok: true };
	}

	// ------------------------------------------------ opening one
	let loading = null;
	let waiter = null;
	// the engine reports each import and medley build ("done" or "error")
	function onImportMsg(kind) {
		if (!waiter) return;
		if (kind === "done" || kind === "error") { const w = waiter; waiter = null; w(kind); }
	}
	const waitDone = ms => new Promise(resolve => {
		const t = setTimeout(() => { waiter = null; resolve("timeout"); }, ms);
		waiter = k => { clearTimeout(t); resolve(k); };
	});
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const progress = p => { loading = Object.assign({ at: Date.now() }, p); o.broadcast("setload", loading); };

	function findFile(src, title) {
		if (src && src.path && fs.existsSync(src.path)) return src.path;
		const roots = o.roots.map(dir => ({ dir, depth: 5 }));
		if (src && src.name) {
			const hits = o.findByName(roots, src.name, src.size, src.mtime);
			if (hits.length) return hits.sort((a, b) => b.score - a.score)[0].path;
		}
		return null;
	}

	async function open(id) {
		if (loading && !loading.done) return { ok: false, error: "busy" };
		const s = readJson(path.join(SETS_DIR, slug(id) + ".json"), null);
		if (!s) return { ok: false, error: "not_found" };
		const struct = o.getStruct();
		if (struct && struct.songs && struct.songs.length) return { ok: false, error: "not_empty" };
		run(s).catch(e => { log("setlist open failed:", e.message); progress({ name: s.name, done: true, error: e.message }); });
		return { ok: true };
	}

	async function run(s) {
		// songs and click songs in setlist order, then the medleys made of them
		const plain = s.order.filter(n => s.songs[n] && (s.songs[n].source || s.songs[n].click));
		const meds = s.order.filter(n => s.songs[n] && s.songs[n].medley);
		const skipped = s.order.filter(n => !s.songs[n] || s.songs[n].missing);
		const n = plain.length + meds.length;
		let i = 0;
		log("opening setlist", s.name, "-", plain.length, "songs,", meds.length, "medleys");
		for (const title of plain) {
			progress({ name: s.name, i: ++i, n, title, stage: "song" });
			if (s.songs[title].click) {
				o.clickSong(Object.assign({ name: title }, s.songs[title].click));
				const kc = await waitDone(60 * 1000);
				if (kc !== "done") { skipped.push(title); log("setlist: click song", kc, title); }
				await sleep(800);
				continue;
			}
			const src = s.songs[title].source;
			const file = findFile(src, title);
			if (!file) { skipped.push(title); log("setlist: not found", title); continue; }
			const r = o.importFile({ path: file, title, instr: src.instr || undefined, gap: src.gap, key: src.key || undefined, bpm: src.bpm || undefined });
			if (!r.ok) { skipped.push(title); log("setlist: import failed", title, r.error); continue; }
			const k = await waitDone(10 * 60 * 1000);
			if (k !== "done") { skipped.push(title); log("setlist: import", k, title); }
			await sleep(800);
		}
		for (const title of meds) {
			progress({ name: s.name, i: ++i, n, title, stage: "medley" });
			const m = s.songs[title].medley;
			o.medley({ action: "build", at: typeof m.at === "number" ? m.at : 0, medley: m.medley });
			const k = await waitDone(10 * 60 * 1000);
			if (k !== "done") { skipped.push(title); log("setlist: medley", k, title); }
			await sleep(800);
		}
		// every setting as it was (order, keys, tempos, arrangements...)
		await sleep(1500);
		if (s.store) o.restore(JSON.stringify(s.store));
		progress({ name: s.name, i: n, n, done: true, skipped });
		log("setlist opened:", s.name, skipped.length ? "(skipped " + skipped.join(", ") + ")" : "");
	}

	return { list, save, remove, open, onImportMsg, rememberImport, rememberMedley, get loading() { return loading; } };
}

module.exports = { makeSets, slug };
