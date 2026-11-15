// The cue bank: recorded cues ("Verse 1", "Chorus", "Build"...) that SetPilot
// speaks, one voice for every song. Any .wav in the bank folders counts, by
// its file name. A section's name finds its recording in English or Spanish
// ("Coro 2" is "Chorus 2"); a number the bank lacks is put together from the
// name and the number ("Chorus" + "5"). Every cue is trimmed to its words,
// brought to one level and one sample rate, once, and kept.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readWav, readFrames, writeWavFloat, normalizeSpeech, trimSpeech } = require("./setpilot_tail.js");
const { partName } = require("./cue_words.js");

const RATE = 44100;
const slug = t => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// names that mean the same recording
const ALIAS = { "a-cappella": "acapella", "a-capella": "acapella", "prechorus": "pre-chorus", "postchorus": "post-chorus", "turn-around": "turnaround", "outro": "outro", "end": "ending", "final": "ending", "inst": "instrumental" };

function walk(dir, out, depth) {
	let list;
	try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
	for (const e of list) {
		if (e.name.startsWith(".")) continue;
		const full = path.join(dir, e.name);
		if (e.isDirectory()) { if (depth < 3) walk(full, out, depth + 1); }
		else if (/\.wav$/i.test(e.name)) out.push(full);
	}
}

function resample(x, from, to) {
	if (from === to) return x;
	const n = Math.floor(x.length * to / from), y = new Float32Array(n), k = from / to;
	for (let i = 0; i < n; i++) {
		const p = i * k, a = Math.floor(p), f = p - a;
		y[i] = (x[a] || 0) * (1 - f) + (x[a + 1] || 0) * f;
	}
	return y;
}

function fade(x, inMs, outMs) {
	const a = Math.min(x.length, Math.round(RATE * inMs / 1000)), b = Math.min(x.length, Math.round(RATE * outMs / 1000));
	for (let i = 0; i < a; i++) x[i] *= i / a;
	for (let i = 0; i < b; i++) x[x.length - 1 - i] *= i / b;
	return x;
}

// dirs: folders to look in, the first that has a name wins
function makeBank({ dirs, cacheDir, log = () => {} }) {
	let index = {}, names = {}, sig = "", count = 0;

	function scan() {
		const ix = {}, nm = {}, parts = [];
		for (const d of dirs) {
			if (!d) continue;
			const files = [];
			walk(d, files, 0);
			for (const f of files.sort()) {
				const k = slug(path.basename(f).replace(/\.wav$/i, ""));
				if (!k || ix[k]) continue;
				ix[k] = f;
				nm[k] = path.basename(f).replace(/\.wav$/i, "");
				try { const st = fs.statSync(f); parts.push(k + ":" + st.size + ":" + Math.round(st.mtimeMs)); } catch (e) { }
			}
		}
		const s = crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 10);
		if (s !== sig) log("cue bank: " + parts.length + " cues");
		index = ix; names = nm; sig = s; count = parts.length;
		return count;
	}

	const has = k => !!index[k];
	const key = k => (has(k) ? k : has(ALIAS[k]) ? ALIAS[k] : null);

	// the recordings that say a text, in order: ["verse-1"] or ["chorus", "5"]; null when the bank can't
	function partsFor(text) {
		const tries = [slug(text)];
		const p = partName(text);
		if (p && !p.count) tries.push(slug(p.name));
		for (const t of tries) {
			if (!t) continue;
			const k = key(t);
			if (k) return [k];
		}
		// a number the bank has no recording of with that name: the name, then the number
		const num = (/(\d+)\s*$/.exec(String(text)) || [])[1];
		for (const t of tries) {
			const base = key(String(t || "").replace(/-\d+$/, ""));
			if (!base) continue;
			return num && has(String(+num)) ? [base, String(+num)] : [base];
		}
		return null;
	}

	function ready(k) {
		const out = path.join(cacheDir, k + "-" + sig + ".wav");
		if (fs.existsSync(out)) return out;
		const w = readWav(index[k]), fr = readFrames(w, 0, w.frames);
		let x = fr.data[0];
		if (fr.data.length > 1) { x = new Float32Array(x.length); for (let i = 0; i < x.length; i++) x[i] = (fr.data[0][i] + fr.data[1][i]) / 2; }
		x = fade(resample(normalizeSpeech(trimSpeech(x, w.rate), w.rate), w.rate, RATE), 4, 25);
		fs.mkdirSync(cacheDir, { recursive: true });
		writeWavFloat(out, x, x, RATE);
		return out;
	}

	// the file that says a text, or null. Made once, then kept.
	function cue(text) {
		if (!count) return null;
		const parts = partsFor(text);
		if (!parts) return null;
		try {
			if (parts.length === 1) return ready(parts[0]);
			const out = path.join(cacheDir, parts.join("+") + "-" + sig + ".wav");
			if (fs.existsSync(out)) return out;
			const datas = parts.map(k => { const f = ready(k), w = readWav(f); return readFrames(w, 0, w.frames).data[0]; });
			const gap = Math.round(RATE * 0.05);
			let len = 0;
			datas.forEach((d, i) => { len += d.length + (i ? gap : 0); });
			const x = new Float32Array(len);
			let at = 0;
			datas.forEach((d, i) => { if (i) at += gap; x.set(d, at); at += d.length; });
			writeWavFloat(out, x, x, RATE);
			return out;
		} catch (e) { log("cue bank: " + text + " failed: " + e.message); return null; }
	}

	// "two" of "Chorus, two, three, four": the bank's number files
	function number(n) { return has(String(n)) ? cue(String(n)) : null; }

	scan();
	return { scan, cue, number, partsFor, get sig() { return sig; }, get count() { return count; }, list: () => Object.keys(index).map(k => names[k]).sort() };
}

module.exports = { makeBank, slug };
