// Export: the arrangement with its automation is printed after the end of the
// set (sections in order, the tempo of each written into its clips, its key,
// without the tracks muted there), Live's Export window is opened on that
// range, and when it closes the print goes away and the set is as before.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-xp-"));
const PORT = 18831;
Object.assign(process.env, { HOME: home, SETPILOT_DATA: path.join(home, "data"), SETPILOT_PORT: String(PORT), SETPILOT_SKIP_SETUP: "1", SETPILOT_DOORBELL: "off", SP_MOCK_DUMP: path.join(home, "dump.json"), SP_MOCK_MARKERS: "1" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ host: "127.0.0.1", port: PORT, path: p }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
const post = (p, body) => new Promise((res, rej) => { const d = JSON.stringify(body); const q = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d) } }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }); q.on("error", rej); q.end(d); });
const dumpLive = async () => { const f = process.env.SP_MOCK_DUMP; try { fs.unlinkSync(f); } catch (e) { } fs.writeFileSync(f + ".req", "1"); for (let i = 0; i < 50; i++) { await sleep(50); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")); } throw new Error("no dump"); };
const engineLog = () => { try { return fs.readFileSync(path.join(home, "data", "setpilot.log"), "utf8"); } catch (e) { return ""; } };

(async () => {
	const live = spawn("python3", [path.join(ROOT, "live/tests/run_mock_live.py")], { env: process.env });
	let liveOut = "";
	live.stderr.on("data", d => (liveOut += d));
	await sleep(300);
	const { startHost } = require("../host/main");
	const maxApi = require("../host/maxapi_shim");
	const logs = [];
	const h = startHost({ log: x => logs.push(String(x)) });
	// Live's window, as macOS would report it: it opens, then closes after the render
	let closeIt = null;
	maxApi.exportOpen = onState => {
		let stopped = false;
		setTimeout(() => !stopped && onState("opening"), 50);
		setTimeout(() => !stopped && onState("open"), 150);
		closeIt = () => !stopped && onState("closed");
		return { stop: () => { stopped = true; } };
	};
	const events = [];
	let bad = 0;
	const ok = m => console.log("ok   " + m);
	const waitFor = async (phase, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (events.some(e => e.phase === phase)) return true; await sleep(100); } return false; };
	try {
		for (let i = 0; i < 100; i++) { try { if ((await get("/state")).struct.songs.length === 2) break; } catch (e) { } await sleep(100); }
		http.get({ host: "127.0.0.1", port: PORT, path: "/events" }, r => { r.setEncoding("utf8"); let ev = ""; r.on("data", d => { for (const line of d.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ") && ev === "export") events.push(JSON.parse(line.slice(6))); } }); });
		await sleep(300);
		const song = "Grande y Fiel";
		// Coro (section 2) twice as fast and two semitones up; Verso 2 back to normal; no bass in the Puente
		assert.ok((await post("/auto", { song, scope: "sec", i: 2, tempo: { bpm: 144, ramp: 0 }, key: { semis: 2 } })).ok);
		assert.ok((await post("/auto", { song, scope: "sec", i: 3, tempo: { bpm: 72, ramp: 0 }, key: { orig: 1 } })).ok);
		assert.ok((await post("/auto", { song, scope: "sec", i: 5, mix: { Bass: 1 } })).ok);
		await sleep(400);
		const before = (await get("/state")).pos;

		assert.ok((await post("/export", { action: "start", what: "song", song, guide: false, click: false })).ok);
		assert.ok(await waitFor("open"), "the export window opens: " + JSON.stringify(events.slice(-3)));
		const line = engineLog().split("\n").find(l => /export Grande y Fiel:/.test(l)) || "";
		// 8 sections x 3 stems, less the bass in the Puente; 16+32+16+32*4+24 = 216 beats = 54 bars
		assert.ok(/23 clips printed/.test(line), line);
		assert.ok(/54 bars at 72 bpm/.test(line), line);
		const ready = events.find(e => e.phase === "ready");
		assert.strictEqual(+ready.b, 54);
		assert.strictEqual(+ready.c, 180, "54 bars at 72 bpm last 3 minutes");
		const at = (await get("/state")).pos;
		assert.ok(at.t > 464, "the playhead on the print, after the set: " + at.t);
		assert.strictEqual(Math.round(at.tempo), 72);
		assert.ok(!/warp markers refused/.test(engineLog()), "every warp marker of the fast Coro moved");
		const lv = await dumpLive(), P = 480, tr = n => lv.tracks.find(t => t.name === n).clips.filter(c => c.start >= P - 0.01).sort((a, b) => a.start - b.start);
		assert.strictEqual(lv.loop_start, P);
		assert.strictEqual(lv.loop_length, 216, "the loop brace covers the print");
		const drums = tr("Drums"), bass = tr("Bass"), keys = tr("Keys");
		assert.deepStrictEqual(drums.map(c => [c.start, c.end]), [[480, 496], [496, 528], [528, 544], [544, 576], [576, 608], [608, 640], [640, 672], [672, 696]]);
		assert.strictEqual(bass.length, 7, "no bass in the Puente");
		assert.ok(!bass.some(c => c.start === 608));
		assert.deepStrictEqual(keys.map(c => c.pitch), [0, 0, 2, 0, 0, 0, 0, 0], "the Coro two semitones up");
		assert.strictEqual(drums[2].pitch, 0, "drums keep their pitch");
		// the fast Coro: its 32 beats of audio fill 16, from where the section starts in the file (beat 48)
		const fast = drums[2], m48 = fast.markers.find(m => Math.abs(m[0] - 48) < 0.01), mEnd = fast.markers.find(m => Math.abs(m[0] - 64) < 0.01);
		assert.ok(m48 && mEnd, JSON.stringify(fast));
		assert.ok(Math.abs((mEnd[1] - m48[1]) - 32 * 0.8) < 0.01, "16 beats now hold the audio of 32: " + JSON.stringify(fast.markers));
		assert.deepStrictEqual([fast.ls, fast.le], [48, 64]);
		ok("the arrangement is printed after the set with its tempo, key and mutes, and the window opens on it");

		closeIt();
		assert.ok(await waitFor("clean"), "cleaned after the window closed");
		await sleep(600);
		const after = (await get("/state")).pos;
		assert.ok(/export closed: print removed/.test(engineLog()));
		assert.strictEqual(Math.round(after.tempo), Math.round(before.tempo));
		assert.ok(Math.abs(after.t - before.t) < 0.01, "playhead back: " + after.t + " vs " + before.t);
		assert.strictEqual((await get("/state")).struct.songs.length, 2);
		ok("when the window closes the print goes away and the set is as before");

		// playing: no export
		events.length = 0;
		await post("/cmd", { cmd: "play", args: [] });
		await sleep(400);
		await post("/export", { action: "start", what: "set" });
		assert.ok(await waitFor("error", 5000));
		assert.strictEqual(events.find(e => e.phase === "error").a, "playing");
		await post("/cmd", { cmd: "stop", args: [] });
		ok("no export while playing");

		// the whole setlist: both songs, the second (128 bpm) fitted to the first one's tempo
		await sleep(600);
		events.length = 0;
		assert.ok((await post("/export", { action: "start", what: "set", guide: true, click: true })).ok);
		assert.ok(await waitFor("open"), JSON.stringify(events.slice(-3)));
		const sl = engineLog().split("\n").filter(l => /export Setlist:/.test(l)).pop() || "";
		assert.ok(/2 song\(s\)/.test(sl) && /at 72 bpm/.test(sl), sl);
		// 216 beats, a bar of silence, then Cielo Abierto's 208 beats at 72/128
		const lv2 = await dumpLive();
		assert.ok(Math.abs(lv2.loop_length - (216 + 4 + 208 * 72 / 128)) < 0.01, "loop " + lv2.loop_length);
		closeIt();
		assert.ok(await waitFor("clean"));
		ok("the setlist prints song after song at one tempo");
		console.log("\nall passing");
	} catch (e) { bad++; console.log("FAIL " + e.message + "\n" + logs.slice(-15).join("\n") + "\n" + liveOut.slice(-1500) + "\n" + engineLog().split("\n").slice(-25).join("\n")); }
	if (process.env.XP_KEEP) console.log(engineLog().split("\n").filter(l => /export|warp|duplicate|clip end/.test(l)).join("\n"));
	await h.stop();
	live.kill();
	process.exit(bad ? 1 : 0);
})();
