// Reads an Ableton Live Set (.als, Live 8 to 12) into a SetPilot import plan:
// tempo, meter, markers and the audio clips of every track with the real path
// of each sample. No dependencies.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const unxml = s => String(s).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (seg, tag) => { const m = seg.match(new RegExp("<" + tag + ' Value="([^"]*)"')); return m ? unxml(m[1]) : null; };
const KEY_RE = /^[A-G](#|b)?m?$/;

// Value is (numerator - 1) + 99 * log2(denominator)
function decodeMeter(v) {
	v = Number(v);
	if (!isFinite(v)) return [4, 4];
	return [(v % 99) + 1, Math.pow(2, Math.floor(v / 99))];
}

function block(x, start, open, close) {
	const i = x.indexOf(open, start);
	if (i < 0) return null;
	const j = x.indexOf(close, i);
	return j < 0 ? null : { text: x.slice(i, j + close.length), start: i, end: j + close.length };
}

// "Song Title (feat. Someone)-Album-F-100.00bpm" (MultiTracks download folders)
function metaFromName(name) {
	const m = name.match(/^(.*)-([A-G](?:#|b)?m?)-([\d.]+)\s*bpm$/i);
	if (!m) return { title: name };
	let head = m[1];
	const dash = head.indexOf("-");
	let title = dash > 0 ? head.slice(0, dash) : head;
	title = title.replace(/\s*\((feat|ft)\.?[^)]*\)\s*/i, " ").trim();
	return { title, key: m[2], bpm: Number(m[3]) };
}

function findFile(dir, name, depth) {
	if (depth < 0) return null;
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
	for (const e of entries) if (e.isFile() && e.name === name) return path.join(dir, e.name);
	for (const e of entries) {
		if (e.isDirectory() && !/^(Backup|Ableton Project Info)$/.test(e.name) && !e.name.startsWith(".")) {
			const f = findFile(path.join(dir, e.name), name, depth - 1);
			if (f) return f;
		}
	}
	return null;
}

function resolveSample(seg, projectDir) {
	const file = block(seg, 0, "<FileRef>", "</FileRef>");
	if (!file) return null;
	const t = file.text;
	const name = attr(t, "Name");
	const abs = attr(t, "Path");
	const candidates = [];
	// Live 10+: <RelativePath Value="Samples/Imported/x.wav" />
	const relNew = attr(t, "RelativePath");
	if (relNew) candidates.push(path.join(projectDir, relNew));
	// Live 8/9: <RelativePath><RelativePathElement Dir="MultiTracks" /></RelativePath> + <Name Value="x.m4a" />
	const dirs = [...t.matchAll(/<RelativePathElement[^>]*Dir="([^"]*)"/g)].map(m => unxml(m[1]));
	if (name) candidates.push(path.join(projectDir, ...dirs, name));
	if (abs) candidates.push(abs);
	for (const c of candidates) if (c && fs.existsSync(c)) return c;
	const base = name || (abs ? path.basename(abs) : null);
	return base ? findFile(projectDir, base, 3) : null;
}

function parseAls(file) {
	const raw = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8").replace(/\r/g, "");
	const projectDir = path.dirname(file);
	const folder = path.basename(projectDir);
	const base = path.basename(file, path.extname(file));

	// tempo and meter: first automation event, else the manual value
	let bpm = null, meter = [4, 4];
	const tempoBlock = block(raw, 0, "<Tempo>", "</Tempo>");
	if (tempoBlock) {
		const ev = tempoBlock.text.match(/<FloatEvent [^>]*Value="([^"]+)"/);
		bpm = Number(ev ? ev[1] : attr(tempoBlock.text, "Manual"));
	}
	const tempoChanges = tempoBlock ? (tempoBlock.text.match(/<FloatEvent /g) || []).length : 0;
	const sigBlock = block(raw, 0, "<TimeSignature>", "</TimeSignature>");
	if (sigBlock) {
		const numr = attr(sigBlock.text, "Numerator"), den = attr(sigBlock.text, "Denominator");
		const ev = sigBlock.text.match(/<EnumEvent [^>]*Value="([^"]+)"/);
		if (numr && den) meter = [Number(numr), Number(den)];
		else if (ev || attr(sigBlock.text, "Manual")) meter = decodeMeter(ev ? ev[1] : attr(sigBlock.text, "Manual"));
	}

	// markers
	const locators = [];
	for (const m of raw.matchAll(/<Locator(?: Id="\d+")?>([\s\S]*?)<\/Locator>/g)) {
		const time = Number(attr(m[1], "Time"));
		const name = attr(m[1], "Name");
		if (isFinite(time) && name !== null) locators.push({ time, name: name.trim() || "Section" });
	}
	locators.sort((a, b) => a.time - b.time);

	// audio tracks and their arrangement clips
	const tracks = [];
	let end = 0;
	for (const m of raw.matchAll(/<AudioTrack Id="\d+"[^>]*>([\s\S]*?)<\/AudioTrack>/g)) {
		const body = m[1];
		const nameBlock = block(body, 0, "<Name>", "</Name>");
		const user = nameBlock ? attr(nameBlock.text, "UserName") : null;
		const eff = nameBlock ? attr(nameBlock.text, "EffectiveName") : null;
		const name = (user && user.trim()) || eff || "Audio";
		// arrangement clips live in MainSequencer > Sample > ArrangerAutomation > Events
		const seq = block(body, 0, "<MainSequencer>", "</MainSequencer>");
		if (!seq) continue;
		const sample = block(seq.text, 0, "<Sample>", "</Sample>");
		if (!sample) continue;
		const clips = [];
		for (const c of sample.text.matchAll(/<AudioClip [^>]*Time="([^"]+)"[^>]*>([\s\S]*?)<\/AudioClip>/g)) {
			const seg = c[2];
			const time = Number(c[1]);
			const warped = attr(seg, "IsWarped") === "true";
			const cs = Number(attr(seg, "CurrentStart")) || 0;
			const ce = Number(attr(seg, "CurrentEnd")) || 0;
			// unwarped clips keep their bounds in seconds
			const toBeats = v => warped ? v : v * (bpm || 120) / 60;
			const len = toBeats(ce) - toBeats(cs);
			const fileOnDisk = resolveSample(seg, projectDir);
			const muted = attr(seg, "Disabled") === "true";
			if (muted) continue;
			// how the file's seconds sit on the clip's beats in the original set
			let markers = [];
			if (warped) {
				for (const w of seg.matchAll(/<WarpMarker [^>]*SecTime="([^"]+)"[^>]*BeatTime="([^"]+)"/g)) markers.push([Number(w[1]), Number(w[2])]);
				markers = markers.filter(x => isFinite(x[0]) && isFinite(x[1])).sort((x, y) => x[0] - y[0]);
			}
			if (markers.length < 2) markers = [[0, 0], [60 / (bpm || 120), 1]];
			clips.push({ time, startBeat: toBeats(cs), length: len, warped, markers, file: fileOnDisk, sample: attr(seg, "Name") });
			end = Math.max(end, time + len);
		}
		if (clips.length) tracks.push({ name, clips });
	}

	// markers after the end of the audio are leftovers (MultiTracks adds a Count Off there)
	const usable = locators.filter(l => l.time < end - 0.01);

	const meta = metaFromName(folder);
	const fromFile = /^(multitrack|untitled|set|project)$/i.test(base) ? null : metaFromName(base);
	const info = fromFile && fromFile.key ? fromFile : (meta.key ? meta : (fromFile || meta));
	return {
		file, projectDir,
		title: info.title || base,
		key: info.key && KEY_RE.test(info.key) ? info.key : "",
		bpm: bpm || info.bpm || 0,
		meter: meter[0] + "/" + meter[1],
		tempoChanges: Math.max(0, tempoChanges - 1),
		locators: usable,
		end,
		tracks,
		missing: tracks.reduce((n, t) => n + t.clips.filter(c => !c.file).length, 0)
	};
}

// Live Sets that look like songs to import, newest first
function findSessions(roots, limit = 40) {
	const out = [];
	const seen = new Set();
	function walk(dir, depth) {
		if (depth < 0) return;
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			const full = path.join(dir, e.name);
			if (e.isFile() && e.name.toLowerCase().endsWith(".als")) {
				if (seen.has(full)) continue;
				seen.add(full);
				let st;
				try { st = fs.statSync(full); } catch (er) { continue; }
				const folder = path.basename(dir);
				const meta = metaFromName(/^(multitrack|untitled)$/i.test(path.basename(e.name, ".als")) ? folder : path.basename(e.name, ".als"));
				out.push({ path: full, folder, title: meta.title, key: meta.key || "", bpm: meta.bpm || 0, mtime: st.mtimeMs });
			} else if (e.isDirectory() && !/^(Backup|Ableton Project Info|Samples|Library|node_modules)$/.test(e.name) && !/User Library/.test(full)) {
				walk(full, depth - 1);
			}
		}
	}
	for (const r of roots) walk(r, 2);
	out.sort((a, b) => b.mtime - a.mtime);
	return out.slice(0, limit);
}

// A file dropped on the dashboard: the browser only tells us its name, size
// and date, so look for it on this computer.
function findByName(roots, name, size, mtime) {
	name = String(name || "");
	if (!name) return [];
	const hits = [];
	const seen = new Set();
	function walk(dir, depth) {
		if (depth < 0 || hits.length > 20) return;
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			const full = path.join(dir, e.name);
			if (e.isFile() && e.name === name) {
				if (seen.has(full)) continue;
				seen.add(full);
				let st;
				try { st = fs.statSync(full); } catch (er) { continue; }
				let score = 0;
				if (size && st.size === Number(size)) score += 2;
				if (mtime && Math.abs(st.mtimeMs - Number(mtime)) < 2000) score += 1;
				hits.push({ path: full, score, mtime: st.mtimeMs });
			} else if (e.isDirectory() && !/^(Backup|Ableton Project Info|Samples|Library|node_modules|Applications|System)$/.test(e.name) && !/User Library/.test(full)) {
				walk(full, depth - 1);
			}
		}
	}
	for (const r of roots) walk(r.dir, r.depth);
	hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
	return hits;
}

// what instrument a track is, from its name (same rules as the engine)
const INSTR = ["click", "guide", "drums", "perc", "bass", "eg", "ag", "keys", "synth", "strings", "vox", "loops", "other"];
const INSTR_RE = [
	["click", /\b(click|clic|metronome|metronomo)\b/],
	["guide", /\b(guide|guides|guia|cues?|vocal cues)\b/],
	["drums", /\b(drums?|drum kit|kick|snare|hats?|hihat|hh|toms?|overheads?|oh|cymbals?|bateria|bombo|redoblante)\b/],
	["perc", /\b(perc\w*|shakers?|tamb\w*|congas?|bongos?|claps?|cajon|cowbell)\b/],
	["bass", /\b(bass\w*|bajo|sub)\b/],
	["ag", /\b(ag\d*|acoustic|acustica|acustico|acgtr)\b/],
	["eg", /\b(eg\d*|electric|elec|guitars?|gtrs?|guitarra)\b/],
	["keys", /\b(keys?|piano|rhodes|wurli\w*|organ|organo|b3|teclados?|ep)\b/],
	["synth", /\b(synth\w*|pads?|arp\w*|lead synth)\b/],
	["strings", /\b(strings?|violin\w*|cellos?|violas?|orch\w*|brass|horns?|cuerdas|trumpets?)\b/],
	["vox", /\b(vox|vocals?|bgvs?|bv|alto|altos|tenors?|sopranos?|choir|voz|voces|harmony|harm|lead vocal)\b/],
	["loops", /\b(loops?|tracks?|fx|sfx|ambient|drones?|seq\w*|textures?)\b/]
];
function normName(n) {
	n = String(n).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
	n = n.replace(/^[\s\d]+[-_.)\s]+/, "");
	if (n.indexOf(" - ") >= 0) n = n.slice(n.lastIndexOf(" - ") + 3);
	n = n.replace(/\([^)]*\)/g, " ").replace(/\btrack\b/g, " ").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
	return n;
}
function guessInstr(name) {
	const n = normName(name).replace(/(\D)(\d)/g, "$1 $2");
	for (const [k, re] of INSTR_RE) if (re.test(n)) return k;
	return "other";
}

module.exports = { parseAls, findSessions, findByName, guessInstr, INSTR, metaFromName, decodeMeter };
