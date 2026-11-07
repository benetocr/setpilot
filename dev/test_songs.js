// Songs in and out of the setlist through the real host and Remote Script on
// the mock Live: a click song (tempo and key, endless or with a length) and
// deleting a song, which takes its clips and locators out of Live.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-songs-"));
const PORT = 18826;
Object.assign(process.env, { HOME: home, SETPILOT_DATA: path.join(home, "data"), SETPILOT_PORT: String(PORT), SETPILOT_SKIP_SETUP: "1", SETPILOT_DOORBELL: "off" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ host: "127.0.0.1", port: PORT, path: p }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
const post = (p, body) => new Promise((res, rej) => { const d = JSON.stringify(body); const q = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d) } }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }); q.on("error", rej); q.end(d); });

(async () => {
	const live = spawn("python3", [path.join(ROOT, "live/tests/run_mock_live.py")], { env: process.env });
	let liveOut = "";
	live.stderr.on("data", d => (liveOut += d));
	live.stdout.on("data", d => (liveOut += d));
	await sleep(300);
	const { startHost } = require("../host/main");
	const logs = [];
	const h = startHost({ log: x => logs.push(String(x)) });
	const events = [];
	let bad = 0;
	const ok = m => console.log("ok   " + m);
	const dump = (a, b) => new Promise(res => { h.worker.once("message", function on(m) { if (m.clipsDump) res(m.clipsDump); else h.worker.once("message", on); }); h.worker.postMessage({ dumpClips: [a, b] }); });
	const waitImport = async () => { for (let i = 0; i < 300 && !events.some(e => e.kind === "done" || e.kind === "error"); i++) await sleep(100); const l = events[events.length - 1]; events.length = 0; return l; };
	const songsNow = async () => (await get("/state")).struct.songs;
	try {
		for (let i = 0; i < 100; i++) { try { if ((await get("/state")).struct.songs.length === 2) break; } catch (e) { } await sleep(100); }
		http.get({ host: "127.0.0.1", port: PORT, path: "/events" }, r => { r.setEncoding("utf8"); let ev = ""; r.on("data", d => { for (const line of d.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ") && ev === "import") events.push(JSON.parse(line.slice(6))); } }); });
		await sleep(300);

		// an endless click song
		let r = await post("/song", { action: "click", name: "Worship Click", bpm: 70, key: "D", bars: 0, pad: true });
		assert.ok(r.ok, JSON.stringify(r));
		let last = await waitImport();
		assert.ok(last && last.kind === "done" && last.a === "Worship Click", "added: " + JSON.stringify(last));
		await sleep(2000);
		let all = await songsNow();
		const c = all.find(x => x.name === "Worship Click");
		assert.ok(c, "in the set: " + all.map(x => x.name).join(", "));
		assert.strictEqual(c.bpm, 70);
		assert.strictEqual(c.key, "D");
		assert.deepStrictEqual(c.clk, { bars: 0, pad: 1 });
		assert.deepStrictEqual(c.sections.map(x => x.name), ["Click"]);
		assert.strictEqual(c.end - c.start, 16, "a 4-bar loop: " + (c.end - c.start));
		const room = await dump(c.start, c.end + 1);
		assert.ok(room.length === 1 && room[0].track === "SetPilot Click" && Math.abs(room[0].st - 492) < 0.01 && Math.abs(room[0].et - 496) < 0.01, "a bar of silence on SetPilot Click makes room: " + JSON.stringify(room));
		ok("a click song comes in with its tempo, key and one Click section (" + c.start + "-" + c.end + "), a bar of silence at its end");

		// playing it: tempo 70, and the section loops by itself
		const ci = all.indexOf(c);
		await post("/cmd", { cmd: "playsong", args: [ci] });
		let looped = false, tempo = 0;
		for (let i = 0; i < 40 && !looped; i++) { const p = (await get("/state")).pos; if (process.env.DBG) console.log(JSON.stringify([p.t,p.playing,p.song,p.sec,p.liveLoop,p.loopSong,p.tempo])); tempo = p.tempo; looped = p.playing && p.liveLoop && p.loopSong === ci; await sleep(100); }
		await post("/cmd", { cmd: "stop", args: [] });
		assert.ok(looped, "the endless click song loops");
		assert.ok(Math.abs(tempo - 70) < 0.05, "at its tempo: " + tempo);
		ok("playing it: its tempo, looping until the next song is called");
		await sleep(800);

		// one with a length
		r = await post("/song", { action: "click", name: "Worship Click", bpm: 128, bars: 8, pad: false });
		last = await waitImport();
		assert.ok(last && last.kind === "done" && last.a === "Worship Click 2", "a second one gets its own name: " + JSON.stringify(last));
		await sleep(2000);
		all = await songsNow();
		const c2 = all.find(x => x.name === "Worship Click 2");
		assert.ok(c2 && c2.end - c2.start === 32 && c2.clk.bars === 8 && c2.clk.pad === 0 && c2.key === "", "8 bars, no pad, no key: " + JSON.stringify(all.map(x => [x.name, x.start, x.end, x.clk, x.key])));
		ok("with a length: 8 bars and then it ends");

		// automation through the dashboard's route
		r = await post("/auto", { song: "Cielo Abierto", scope: "sec", i: 3, tempo: { bpm: 132, ramp: 2 }, key: { semis: 1 }, mix: { Drums: 1 } });
		assert.ok(r.ok, JSON.stringify(r));
		await sleep(800);
		const ca = (await songsNow()).find(x => x.name === "Cielo Abierto");
		assert.deepStrictEqual(ca.ev, { 3: { t: { bpm: 132, ramp: 2 }, k: { semis: 1 } } });
		assert.strictEqual(ca.auto[3].drums.m, 1);
		ok("automation set from the dashboard is kept on the song");

		// deleting a song takes its clips and locators out of Live
		const g = all.find(x => x.name === "Grande y Fiel");
		const before = (await dump(g.start, g.end)).length;
		assert.ok(before > 0, "the song has clips");
		r = await post("/song", { action: "delete", name: "Grande y Fiel" });
		assert.ok(r.ok, JSON.stringify(r));
		for (let i = 0; i < 100; i++) { if (!(await songsNow()).some(x => x.name === "Grande y Fiel")) break; await sleep(100); }
		await sleep(1000);
		all = await songsNow();
		assert.ok(!all.some(x => x.name === "Grande y Fiel"), "gone from the set: " + all.map(x => x.name).join(", "));
		assert.ok(all.some(x => x.name === "Cielo Abierto") && all.some(x => x.name === "Worship Click"), "the others stay");
		const after = await dump(g.start, g.end);
		assert.strictEqual(after.length, 0, "no clips left in its place: " + JSON.stringify(after));
		const st = await get("/state");
		assert.strictEqual(st.struct.order.length, all.length, "the setlist has what's left");
		ok("deleting a song takes it out of the setlist and its " + before + " clips and locators out of Live");

		// and deleting while Live plays is refused
		await post("/cmd", { cmd: "playsong", args: [all.findIndex(x => x.name === "Cielo Abierto")] });
		for (let i = 0; i < 40 && !(await get("/state")).pos.playing; i++) await sleep(100);
		r = await post("/song", { action: "delete", name: "Cielo Abierto" });
		await post("/cmd", { cmd: "stop", args: [] });
		assert.strictEqual(r.error, "playing");
		ok("while Live plays, nothing is deleted");
		console.log("\nall passing");
	} catch (e) { bad++; console.log("FAIL " + e.message + "\n" + logs.slice(-40).join("\n") + "\n" + liveOut.slice(-3000)); }
	await h.stop();
	live.kill();
	process.exit(bad ? 1 : 0);
})();
