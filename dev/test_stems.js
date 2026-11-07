// A folder of tracks with no Live Set: SetPilot finds it, names the tracks and
// the song from the file names, hears tempo, key, beat one and the parts (the
// same code the dashboard runs), and puts the song in Live on the bar grid.
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");
const D = require("../core/ui/stems_dsp.js");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-stems-"));
const PORT = 18827;
Object.assign(process.env, { HOME: home, SETPILOT_DATA: path.join(home, "data"), SETPILOT_PORT: String(PORT), SETPILOT_SKIP_SETUP: "1", SETPILOT_DOORBELL: "off", SP_MOCK_EMPTY: "1" });
const DIR = path.join(home, "Music", "Grace Song - G - The Band 72bpm");
execFileSync("node", [path.join(__dirname, "gen_stems.js"), DIR]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ host: "127.0.0.1", port: PORT, path: p }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
const post = (p, body) => new Promise((res, rej) => { const d = JSON.stringify(body); const q = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d) } }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }); q.on("error", rej); q.end(d); });
function readWav(f) { const b = fs.readFileSync(f), n = (b.length - 44) / 2, x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768; return x; }

(async () => {
	const live = spawn("python3", [path.join(ROOT, "live/tests/run_mock_live.py")], { env: process.env });
	await sleep(300);
	const { startHost } = require("../host/main");
	const h = startHost({ log: () => {} });
	let bad = 0;
	const ok = m => console.log("ok   " + m);
	try {
		for (let i = 0; i < 100 && !(h.status.autoPrepared); i++) await sleep(100);
		await sleep(1500);
		const files = fs.readdirSync(DIR).map(n => { const st = fs.statSync(path.join(DIR, n)); return { name: n, size: st.size, mtime: st.mtimeMs, rel: n }; });
		const f = await post("/stems/find", { folder: path.basename(DIR), files });
		assert.ok(f.ok, JSON.stringify(f));
		assert.strictEqual(f.title, "Grace Song");
		assert.strictEqual(f.key, "G");
		assert.strictEqual(f.bpm, 72);
		const byTrack = Object.fromEntries(f.files.map(x => [x.track, x.role]));
		assert.deepStrictEqual(byTrack, { Bass: "bass", Click: "click", Drums: "drums", Guide: "guide", Keys: "keys", "Lead Vox": "vox" });
		ok("the folder is found by its files; song name, key, tempo and each track's name and role come from the names");

		// what the dashboard hears
		const SR = 22050, x = Object.fromEntries(f.files.map(t => [t.track, readWav(t.path)]));
		const ct = D.tempoFromClick(D.clickOnsets(x.Click, SR));
		assert.strictEqual(ct.bpm, 72);
		assert.ok(Math.abs(ct.downbeat - 0.5) < 0.01, ct.downbeat);
		const bs = 4 * 60 / 72, nb = Math.ceil((x.Click.length / SR - ct.downbeat) / bs);
		const cues = D.guideBounds(D.envelope(x.Guide, SR, 100), 100, ct.downbeat, bs, nb);
		assert.deepStrictEqual(cues.map(b => b + 1), [2, 6, 14, 22, 30, 38, 42, 50]);
		ok("heard: 72 BPM, beat one at 0.5 s, the parts where the guide calls them");

		const parts = [["Count In", 1], ["Intro", 2], ["Verse 1", 6], ["Chorus", 14], ["Verse 2", 22], ["Chorus", 30], ["Bridge", 38], ["Chorus", 42], ["Outro", 50]];
		const r = await post("/stems/create", { title: f.title, key: f.key, bpm: 72, meter: "4/4", downbeat: ct.downbeat,
			sections: parts.map(p => ({ name: p[0], bar: p[1] })), tracks: f.files.map(t => ({ name: t.track, path: t.path, role: t.role, dur: x[t.track].length / SR, size: fs.statSync(t.path).size })) });
		assert.ok(r.ok, JSON.stringify(r));
		let song = null;
		for (let i = 0; i < 300 && !song; i++) { await sleep(200); song = (await get("/state")).struct.songs.find(s => s.name === "Grace Song" && s.sections.length === 9); }
		assert.ok(song, "the song is in the set");
		assert.strictEqual(song.bpm, 72);
		assert.strictEqual(song.key, "G");
		assert.deepStrictEqual(song.sections.map(s => [s.name, s.start - song.start]), parts.map(p => [p[0], (p[1] - 1) * 4]));
		ok("in Live: the song's name, tempo and key, and every part on its bar (Count In on the very first beat)");
		const clips = await new Promise(res => { h.worker.once("message", function on(m) { if (m.clipsDump) res(m.clipsDump); else h.worker.once("message", on); }); h.worker.postMessage({ dumpClips: [song.start, song.end + 64] }); });
		assert.strictEqual(clips.length, 6, JSON.stringify(clips));
		assert.ok(clips.some(c => c.track === "SetPilot Click"), "the click stem on SetPilot Click");
		assert.ok(clips.every(c => Math.abs(c.st - song.start) < 0.01), "every track starts with the song");
		ok("the six tracks are in, the click on SetPilot Click");
		console.log("\nall passing");
	} catch (e) { bad++; console.log("FAIL " + e.message); }
	await h.stop();
	live.kill();
	process.exit(bad ? 1 : 0);
})();
