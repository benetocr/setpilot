// A medley with a tempo ramp over the bars the wizard chose, and a hold: one
// bar that goes round with click and pad until the MD releases it.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-medh-"));
const PORT = 18829;
Object.assign(process.env, { HOME: home, SETPILOT_DATA: path.join(home, "data"), SETPILOT_PORT: String(PORT), SETPILOT_SKIP_SETUP: "1", SETPILOT_DOORBELL: "off" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ host: "127.0.0.1", port: PORT, path: p }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
const post = (p, body) => new Promise((res, rej) => { const d = JSON.stringify(body); const q = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d) } }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }); q.on("error", rej); q.end(d); });

(async () => {
	const live = spawn("python3", [path.join(ROOT, "live/tests/run_mock_live.py")], { env: process.env });
	let liveOut = "";
	live.stderr.on("data", d => (liveOut += d));
	await sleep(300);
	const { startHost } = require("../host/main");
	const logs = [];
	const h = startHost({ log: x => logs.push(String(x)) });
	const events = [];
	let bad = 0;
	const ok = m => console.log("ok   " + m);
	try {
		for (let i = 0; i < 100; i++) { try { if ((await get("/state")).struct.songs.length === 2) break; } catch (e) { } await sleep(100); }
		const st0 = await get("/state");
		http.get({ host: "127.0.0.1", port: PORT, path: "/events" }, r => { r.setEncoding("utf8"); let ev = ""; r.on("data", d => { for (const line of d.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ") && ev === "import") events.push(JSON.parse(line.slice(6))); } }); });
		await sleep(300);
		const medley = { id: "mh", name: "Hold Medley", key: "G",
			parts: [{ song: "Grande y Fiel", secs: [0], semis: 0, bpm: 72, key: "G" }, { song: "Cielo Abierto", secs: [0], semis: 0, bpm: 128, key: "G" }, { song: "Grande y Fiel", secs: [7], semis: 0, bpm: 72, key: "G" }],
			seams: [{ type: "ramp", bars: 2 }, { type: "hold" }] };
		assert.ok((await post("/medley", { action: "build", at: 0, medley })).ok);
		for (let i = 0; i < 400 && !events.some(e => e.kind === "done" || e.kind === "error"); i++) await sleep(100);
		assert.ok(events.some(e => e.kind === "done"), JSON.stringify(events.slice(-2)));
		await sleep(2000);
		const st = await get("/state");
		const s = st.struct.songs.find(x => x.name === "Hold Medley"), si = st.struct.songs.indexOf(s);
		assert.deepStrictEqual(s.med.seams.map(x => [x.type, x.bars || 0, x.len]), [["ramp", 2, 0], ["hold", 0, 4]]);
		assert.deepStrictEqual(s.sections.map(x => x.name), ["Count Off", "Intro", "Intro", "Transition", "Final"]);
		ok("the ramp keeps its bars; the hold is a bar of its own");
		const S = s.start;
		await post("/cmd", { cmd: "select", args: [si] });
		await sleep(400);
		await post("/cmd", { cmd: "section", args: [si, 1, 0] });
		await sleep(600);
		await post("/cmd", { cmd: "play", args: [] });
		let flat = null, mid = null, p;
		for (let i = 0; i < 400; i++) {
			p = (await get("/state")).pos;
			if (p.playing && p.t > S + 12 && p.t < S + 15) flat = p.tempo;
			if (p.playing && p.t > S + 19.5 && p.t < S + 20.5) mid = p.tempo;
			if (p.t > S + 25) break;
			await sleep(50);
		}
		assert.strictEqual(flat, 72, "flat until two bars before the next part");
		assert.ok(mid > 85 && mid < 115, "half way through the two bars: " + mid);
		ok("the tempo ramps over the two bars chosen");
		for (let i = 0; i < 400; i++) { p = (await get("/state")).pos; if (p.t >= S + 40.3) break; await sleep(50); }
		await sleep(4000);
		p = (await get("/state")).pos;
		assert.ok(p.playing && p.t >= S + 40 && p.t < S + 44, "still in the hold bar: " + p.t);
		assert.strictEqual(p.under, 1, "the hold shows as one to release");
		assert.strictEqual(p.liveLoop, 1);
		ok("the hold goes round with the band out");
		await post("/cmd", { cmd: "underscore", args: [] });
		let into = null;
		for (let i = 0; i < 200; i++) { p = (await get("/state")).pos; if (p.t >= S + 44.3) { into = p; break; } await sleep(50); }
		assert.ok(into, "released into the next part");
		assert.strictEqual(into.liveLoop, 0);
		assert.strictEqual(into.under, 0);
		ok("released, it goes on into the next part");
		await post("/cmd", { cmd: "stop", args: [] });
		console.log("\nall passing");
	} catch (e) { bad++; console.log("FAIL " + e.message + "\n" + logs.slice(-15).join("\n") + "\n" + liveOut.slice(-1500) + "\n" + (() => { try { return require("fs").readdirSync(path.join(home, "data")).map(f => f + ": " + (f.endsWith(".log") ? require("fs").readFileSync(path.join(home, "data", f), "utf8").split("\n").filter(l => !/voice failed/.test(l)).slice(-12).join("\n") : "")).join("\n"); } catch (e) { return e.message; } })()); }
	await h.stop();
	live.kill();
	process.exit(bad ? 1 : 0);
})();
