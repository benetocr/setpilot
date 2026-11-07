// Hearing the guide's cues: each short cue ("Verse two", "Coro") goes through
// whisper.cpp (bundled with the app, runs on the computer, no internet), first
// as English, then as Spanish for what English didn't make out.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { partName, PROMPT } = require("../core/cue_words.js");

function findWhisper(extra) {
	const dirs = [].concat(extra || [], process.env.SETPILOT_WHISPER_DIR || [], process.resourcesPath ? path.join(process.resourcesPath, "bin") : [], path.join(__dirname, "..", "native-dist")).filter(Boolean);
	for (const d of dirs) {
		const bin = path.join(d, "whisper-cli"), model = ["ggml-base-q5_1.bin", "ggml-base.bin", "ggml-tiny-q5_1.bin", "ggml-tiny.bin"].map(m => path.join(d, "models", m)).find(f => fs.existsSync(f));
		if (fs.existsSync(bin) && model) return { bin, model };
	}
	return null;
}

function wav16(pcm) {
	// 16 kHz mono 16 bit, with a little silence around the words
	const pad = 4000, n = pcm.length + pad * 2, b = Buffer.alloc(44 + n * 2);
	b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
	b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
	b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
	for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i], 44 + (pad + i) * 2);
	return b;
}

function makeHear({ log = () => {}, dirs } = {}) {
	const w = findWhisper(dirs);
	function run(files, lang) {
		return new Promise(resolve => {
			const args = ["-m", w.model, "-l", lang, "-t", String(Math.max(2, Math.min(8, os.cpus().length))), "-nt", "-np", "-otxt", "--prompt", PROMPT[lang] || PROMPT.en];
			files.forEach(f => args.push("-f", f));
			execFile(w.bin, args, { timeout: 120000, maxBuffer: 8 << 20 }, err => {
				if (err) log("whisper: " + err.message.split("\n")[0]);
				resolve(files.map(f => { try { return fs.readFileSync(f + ".txt", "utf8").trim(); } catch (e) { return ""; } }));
			});
		});
	}
	// cues: [{ id, pcm: Int16Array at 16 kHz }] -> [{ id, text, name, count }]
	async function hear(cues) {
		if (!w) return { ok: false, error: "no_whisper" };
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-hear-"));
		const t0 = Date.now();
		try {
			const files = cues.map((c, i) => { const f = path.join(dir, "cue-" + i + ".wav"); fs.writeFileSync(f, wav16(c.pcm)); return f; });
			const out = cues.map(c => ({ id: c.id, text: "", name: null, count: false, lang: "" }));
			const en = await run(files, "en");
			en.forEach((t, i) => { const p = partName(t); out[i].text = t; if (p) Object.assign(out[i], p, { lang: "en" }); });
			const left = out.map((o, i) => (o.name ? -1 : i)).filter(i => i >= 0);
			if (left.length) {
				const es = await run(left.map(i => files[i]), "es");
				es.forEach((t, k) => { const i = left[k], p = partName(t); if (p) Object.assign(out[i], p, { text: t, lang: "es" }); else if (!out[i].text) out[i].text = t; });
			}
			log("guide cues heard in " + ((Date.now() - t0) / 1000).toFixed(1) + " s: " + out.map(o => (o.name || "?") + " (" + o.text + ")").join(", "));
			return { ok: true, cues: out };
		} finally {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
		}
	}
	return { available: () => !!w, hear, where: w };
}

module.exports = { makeHear, findWhisper, wav16 };
