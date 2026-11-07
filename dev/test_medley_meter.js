// A medley from a 4/4 song into a 6/8 one: each part keeps its time signature,
// and the count before the 6/8 part is already in 6/8 (two of its bars), with
// SetPilot's click counting it from where those bars start.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-medm-"));
const PORT = 18828;
Object.assign(process.env, { HOME: home, SETPILOT_DATA: path.join(home, "data"), SETPILOT_PORT: String(PORT), SETPILOT_SKIP_SETUP: "1", SETPILOT_DOORBELL: "off", SP_MOCK_68: "1" });
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
		assert.strictEqual(st0.struct.songs[1].meter, "6/8");
		http.get({ host: "127.0.0.1", port: PORT, path: "/events" }, r => { r.setEncoding("utf8"); let ev = ""; r.on("data", d => { for (const line of d.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ") && ev === "import") events.push(JSON.parse(line.slice(6))); } }); });
		await sleep(300);
		const medley = { id: "m68", name: "Six Eight", key: "G",
			parts: [{ song: "Grande y Fiel", secs: [3], semis: 0, bpm: 160, key: "G" }, { song: "Cielo Abierto", secs: [4], semis: 0, bpm: 160, key: "G" }],
			seams: [{ type: "count" }] };
		assert.ok((await post("/medley", { action: "build", at: 0, medley })).ok);
		for (let i = 0; i < 400 && !events.some(e => e.kind === "done" || e.kind === "error"); i++) await sleep(100);
		assert.ok(events.some(e => e.kind === "done"), JSON.stringify(events.slice(-2)));
		await sleep(2000);
		const st = await get("/state");
		const s = st.struct.songs.find(x => x.name === "Six Eight"), si = st.struct.songs.indexOf(s);
		assert.deepStrictEqual(s.med.parts.map(p => p.meter), ["4/4", "6/8"]);
		const sm = s.med.seams[0];
		assert.strictEqual(sm.meter, "6/8");
		assert.strictEqual(sm.len, 6, "two bars of 6/8 (3 beats each)");
		ok("the parts keep their time signatures; the count before the 6/8 part is two bars of 6/8");

		// play into the count: 4/4 before it, 6/8 from its first beat on, click counted from there
		const tr = s.sections.find(x => x.name === "Transition");
		assert.ok(Math.abs(tr.start - (s.start + sm.at)) < 0.01);
		await post("/cmd", { cmd: "select", args: [si] });
		await sleep(400);
		await post("/cmd", { cmd: "section", args: [si, s.sections.indexOf(tr) - 1, 0] });
		await sleep(600);
		await post("/cmd", { cmd: "play", args: [] });
		let before = null, after = null, p;
		for (let i = 0; i < 900; i++) {
			p = (await get("/state")).pos;
			if (p.playing && p.t > tr.start - 4 && p.t < tr.start - 1) before = [p.sigNum, p.sigDen];
			if (p.playing && p.t > tr.start + 0.5) { after = [p.sigNum, p.sigDen]; break; }
			await sleep(50);
		}
		await post("/cmd", { cmd: "stop", args: [] });
		assert.deepStrictEqual(before, [4, 4], "4/4 while the first part plays (last pos " + JSON.stringify(p && [p.t, p.playing, p.sigNum]) + ")");
		assert.deepStrictEqual(after, [6, 8], "6/8 from the count on");
		ok("Live goes into 6/8 as the count starts");
		console.log("\nall passing");
	} catch (e) { bad++; console.log("FAIL " + e.message + "\n" + logs.slice(-15).join("\n") + "\n" + liveOut.slice(-1500) + "\n" + (() => { try { return require("fs").readdirSync(path.join(home, "data")).map(f => f + ": " + (f.endsWith(".log") ? require("fs").readFileSync(path.join(home, "data", f), "utf8").split("\n").filter(l => !/voice failed/.test(l)).slice(-12).join("\n") : "")).join("\n"); } catch (e) { return e.message; } })()); }
	await h.stop();
	live.kill();
	process.exit(bad ? 1 : 0);
})();
