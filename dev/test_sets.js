// Saved setlists, end to end on the mock Live: import two songs from their
// Live Sets, change the key of one, save the setlist; then, in a new empty
// set, open it: both songs come back in order with the key as it was.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-sets-"));
const PORT = 18826;
Object.assign(process.env, { HOME: home, SETPILOT_DATA: path.join(home, "data"), SETPILOT_PORT: String(PORT), SETPILOT_SKIP_SETUP: "1", SETPILOT_DOORBELL: "off", SP_MOCK_EMPTY: "1", SETPILOT_AUTO_PREPARE: "0" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ host: "127.0.0.1", port: PORT, path: p }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
const post = (p, body) => new Promise((res, rej) => { const d = JSON.stringify(body); const q = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d) } }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }); q.on("error", rej); q.end(d); });

// a minimal MultiTracks-like Live Set: one Guide and one Drums stem, two locators
function makeSet(dir, title, bpm, beats) {
	fs.mkdirSync(path.join(dir, "Samples"), { recursive: true });
	const clip = name => {
		fs.writeFileSync(path.join(dir, "Samples", name + ".wav"), "RIFF");
		return `<AudioTrack Id="1"><Name><EffectiveName Value="${name}" /><UserName Value="${name}" /></Name><DeviceChain><MainSequencer><Sample><ArrangerAutomation><Events>` +
			`<AudioClip Id="0" Time="0"><CurrentStart Value="0" /><CurrentEnd Value="${beats}" /><IsWarped Value="true" />` +
			`<SampleRef><FileRef><RelativePath Value="Samples/${name}.wav" /><Name Value="${name}.wav" /></FileRef></SampleRef>` +
			`<WarpMarkers><WarpMarker Id="0" SecTime="0" BeatTime="0" /><WarpMarker Id="1" SecTime="${60 / bpm}" BeatTime="1" /></WarpMarkers></AudioClip>` +
			`</Events></ArrangerAutomation></Sample></MainSequencer></DeviceChain></AudioTrack>`;
	};
	const xml = `<?xml version="1.0"?><Ableton><LiveSet><Tracks>${clip("Guide")}${clip("Drums")}</Tracks>` +
		`<MasterTrack><DeviceChain><Mixer><Tempo><Manual Value="${bpm}" /></Tempo><TimeSignature><Manual Value="201" /></TimeSignature></Mixer></DeviceChain></MasterTrack>` +
		`<Locators><Locators><Locator Id="0"><Time Value="0" /><Name Value="Intro" /></Locator><Locator Id="1"><Time Value="16" /><Name Value="Verse" /></Locator></Locators></Locators>` +
		`</LiveSet></Ableton>`;
	const file = path.join(dir, title + ".als");
	fs.writeFileSync(file, zlib.gzipSync(xml));
	return file;
}

(async () => {
	const music = path.join(home, "Music");
	const a = makeSet(path.join(music, "Song A-Album-G-80.00bpm"), "Song A", 80, 32);
	const b = makeSet(path.join(music, "Song B-Album-D-120.00bpm"), "Song B", 120, 32);
	let live = spawn("python3", [path.join(ROOT, "live/tests/run_mock_live.py")], { env: process.env });
	await sleep(300);
	const { startHost } = require("../host/main");
	const h = startHost({ log: () => {} });
	const events = [];
	let bad = 0;
	const ok = m => console.log("ok   " + m);
	const listen = () => http.get({ host: "127.0.0.1", port: PORT, path: "/events" }, r => { r.setEncoding("utf8"); let ev = ""; r.on("data", d => { for (const line of d.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ") && (ev === "import" || ev === "setload")) events.push(Object.assign({ ev }, JSON.parse(line.slice(6)))); } }); });
	const waitImport = async () => { for (let i = 0; i < 400; i++) { if (events.some(e => e.ev === "import" && (e.kind === "done" || e.kind === "error"))) return; await sleep(100); } };
	try {
		for (let i = 0; i < 100; i++) { try { if ((await get("/state")).struct) break; } catch (e) { } await sleep(100); }
		listen();
		await sleep(300);
		assert.deepStrictEqual((await get("/sets")).sets, [], "nothing saved yet");
		for (const f of [a, b]) {
			events.length = 0;
			const r = await post("/import", { path: f });
			assert.ok(r.ok, "import accepted: " + JSON.stringify(r));
			await waitImport();
			assert.ok(events.some(e => e.kind === "done"), "imported " + f);
			await sleep(1200);
		}
		let st = await get("/state");
		assert.deepStrictEqual(st.struct.songs.map(s => s.name), ["Song A", "Song B"]);
		const bi = st.struct.songs.findIndex(s => s.name === "Song B");
		await post("/cmd", { cmd: "keyset", args: [bi, 2] });
		await sleep(1500);
		const sv = await post("/sets/save", { name: "Sunday" });
		assert.ok(sv.ok && sv.missing === 0, "saved: " + JSON.stringify(sv));
		const list = (await get("/sets")).sets;
		assert.strictEqual(list.length, 1);
		assert.deepStrictEqual(list[0].songs.map(s => s.name), ["Song A", "Song B"]);
		ok("a setlist is saved with where each song came from");
		assert.strictEqual((await post("/sets/open", { id: "sunday" })).error, "not_empty", "only into an empty set");

		// a new empty Live set
		live.kill();
		await sleep(500);
		live = spawn("python3", [path.join(ROOT, "live/tests/run_mock_live.py")], { env: process.env });
		for (let i = 0; i < 150; i++) { try { const s = await get("/state"); if (s.struct && s.struct.songs.length === 0) break; } catch (e) { } await sleep(100); }
		await sleep(1500);
		events.length = 0;
		const op = await post("/sets/open", { id: "sunday" });
		assert.ok(op.ok, "opening: " + JSON.stringify(op));
		for (let i = 0; i < 900 && !events.some(e => e.ev === "setload" && e.done); i++) await sleep(100);
		const fin = events.filter(e => e.ev === "setload" && e.done)[0];
		assert.ok(fin && !(fin.skipped || []).length, "opened: " + JSON.stringify(events.filter(e => e.ev === "setload")));
		await sleep(1500);
		st = await get("/state");
		assert.deepStrictEqual(st.struct.songs.map(s => s.name), ["Song A", "Song B"]);
		const sB = st.struct.songs.find(s => s.name === "Song B");
		assert.strictEqual(sB.semis, 2, "Song B keeps its key change: " + JSON.stringify(sB).slice(0, 300));
		ok("opening it in an empty set brings the songs back, in order, with their settings");
		console.log("\nall passing");
	} catch (e) { bad++; console.log("FAIL " + e.message); }
	await h.stop();
	live.kill();
	process.exit(bad ? 1 : 0);
})();
