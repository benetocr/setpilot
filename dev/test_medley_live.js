// A medley built through the real host and the real Remote Script on the mock
// Live: the chosen sections are copied to a new song at the end, each part in
// its key, with locators, a bridge, and the medley's tempo per part.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-med-"));
const PORT = 18821;
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
		http.get({ host: "127.0.0.1", port: PORT, path: "/events" }, r => { r.setEncoding("utf8"); let ev = ""; r.on("data", d => { for (const line of d.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ") && ev === "import") events.push(JSON.parse(line.slice(6))); } }); });
		await sleep(300);
		const medley = { id: "mtest", name: "Medley Test", key: "A",
			parts: [{ song: "Grande y Fiel", secs: [1, 2], semis: 2, bpm: 72, key: "A" }, { song: "Cielo Abierto", secs: [3, 5], semis: -5, bpm: 128, key: "A" }],
			seams: [{ type: "pivot" }] };
		const r = await post("/medley", { action: "build", at: 0, medley });
		assert.ok(r.ok, "accepted: " + JSON.stringify(r));
		for (let i = 0; i < 400 && !events.some(e => e.kind === "done" || e.kind === "error"); i++) await sleep(100);
		const last = events[events.length - 1];
		assert.ok(last && last.kind === "done", "build finished: " + JSON.stringify(events.slice(-3)) + "\n" + logs.filter(x => /medley|error/i.test(x)).slice(-10).join("\n"));
		assert.strictEqual(last.b, last.c, "every copied clip checked: " + JSON.stringify(last) + "\n" + logs.filter(x => /medley check/.test(x)).join("\n"));
		ok("the build runs through and every copied clip is where and as long as planned (" + last.c + " clips)");
		await sleep(2000);
		const st = await get("/state");
		const s = st.struct.songs.find(x => x.name === "Medley Test");
		assert.ok(s, "the medley is a song: " + st.struct.songs.map(x => x.name).join(", "));
		assert.strictEqual(s.start, 480);
		const secs = s.sections.map(x => x.name + "@" + x.start).join(" ");
		assert.strictEqual(secs, "Count Off@480 Verso 1@488 Coro@520 Transition@552 Coro@560 Puente@592", secs);
		assert.strictEqual(s.bpm, 72);
		assert.strictEqual(s.key, "A");
		ok("its locators: " + secs);
		assert.ok(s.med && s.med.parts.length === 2 && s.med.seams[0].type === "pivot", "its medley plan is kept: " + JSON.stringify(s.med));
		assert.deepStrictEqual(s.med.parts.map(p => [p.a, p.b, p.bpm, p.semis]), [[8, 72, 72, 2], [80, 144, 128, -5]]);
		ok("its parts and tempos are kept for playing it");
		assert.strictEqual(st.struct.order[0], st.struct.songs.indexOf(s), "it went first in the setlist, where the wizard put it");
		ok("it sits in the setlist where the wizard asked");
		// what Live has now: ask the mock through the host's mirror
		const clips = await new Promise(res => { h.worker.once("message", function on(m) { if (m.clipsDump) res(m.clipsDump); else h.worker.once("message", on); }); h.worker.postMessage({ dumpClips: [480, 700] }); });
		const want = [["Drums", 488, 552, 0], ["Drums", 560, 592, 0], ["Drums", 592, 624, 0], ["Keys", 488, 552, 2], ["Keys", 560, 592, -5], ["Keys", 592, 624, -5], ["Bass", 488, 552, 2], ["Bass", 560, 592, -5], ["Bass", 592, 624, -5]];
		for (const w of want) assert.ok(clips.some(c => c.track === w[0] && Math.abs(c.st - w[1]) < 0.01 && Math.abs(c.et - w[2]) < 0.01 && c.pitch === w[3]), "clip " + w.join(" ") + " in " + JSON.stringify(clips));
		assert.ok(!clips.some(c => c.track === "Guide"), "the guide's words stay in their own song");
		ok("each part's clips are trimmed to its sections and pitched to the medley key; drums keep their pitch");
		// playing it: prepared at its "Coro" before the bridge, the tempo is the part's;
		// in the bridge (a pivot) it is already the next part's
		const si = st.struct.songs.indexOf(s);
		await post("/cmd", { cmd: "select", args: [si] });
		await sleep(400);
		await post("/cmd", { cmd: "section", args: [si, 2, 0] });
		await sleep(400);
		await post("/cmd", { cmd: "play", args: [] });
		let seen72 = false, seen128 = false;
		for (let i = 0; i < 150 && !seen128; i++) {
			const p = (await get("/state")).pos;
			if (p.playing && Math.abs(p.tempo - 72) < 0.05 && p.t < 552) seen72 = true;
			if (p.playing && Math.abs(p.tempo - 128) < 0.05 && p.t >= 552) seen128 = true;
			if (i === 25) await post("/cmd", { cmd: "section", args: [si, 3, 1] });   // jump into the bridge now
			if (process.env.DBG) console.log(p.t, p.tempo, p.playing, p.song, p.sec);
			await sleep(100);
		}
		await post("/cmd", { cmd: "stop", args: [] });
		await sleep(600);
		// going into the next song, the cue says its name first (before the section's cue)
		await post("/cmd", { cmd: "section", args: [si, 2, 0] });
		for (let i = 0; i < 50; i++) { const p = (await get("/state")).pos; if (!p.playing && p.song === si && p.sec === 2 && Math.abs(p.t - 520) < 0.01) break; await sleep(100); }
		await sleep(300);
		await post("/cmd", { cmd: "play", args: [] });
		const texts = new Set();
		let annAt = -1, secAt = -1;
		for (let i = 0; i < 400; i++) {
			const st3 = await get("/state"), c = st3.cue;
			if (c) texts.add(JSON.stringify(c));
			if (c && /Cielo Abierto/.test(c.text) && annAt < 0) annAt = st3.pos.t;
			if (c && c.text === "Transition" && secAt < 0 && annAt >= 0) { secAt = st3.pos.t; break; }
			await sleep(100);
		}
		await post("/cmd", { cmd: "stop", args: [] });
		assert.ok([...texts].some(x => /Cielo Abierto/.test(x)), "the plan names the next song: " + [...texts].join(" "));
		assert.ok(annAt >= 519 && secAt > 547 && secAt < 549, "the song first, then the section: " + annAt + " / " + secAt);
		ok("going into another song, the plan names it first and the section cue comes after (" + annAt + " then " + secAt + ")");
		await sleep(600);
		// playing one song and asking for a section of another: that song's name first
		const gi = st.struct.songs.findIndex(x => x.name === "Grande y Fiel"), ci = st.struct.songs.findIndex(x => x.name === "Cielo Abierto");
		await post("/cmd", { cmd: "section", args: [ci, 0, 0] });
		for (let i = 0; i < 50; i++) { const p = (await get("/state")).pos; if (!p.playing && p.song === ci && p.sec === 0) break; await sleep(100); }
		await sleep(300);
		await post("/cmd", { cmd: "play", args: [] });
		await sleep(600);
		await post("/cmd", { cmd: "section", args: [gi, 2, 0] });
		const seq = [];
		for (let i = 0; i < 300; i++) {
			const c = (await get("/state")).cue;
			if (c && c.text && seq[seq.length - 1] !== c.text) seq.push(c.text);
			if (seq.length >= 2 && /Grande y Fiel/.test(seq[seq.length - 2])) break;
			await sleep(100);
		}
		await post("/cmd", { cmd: "stop", args: [] });
		const ai = seq.findIndex(x => /Grande y Fiel/.test(x));
		assert.ok(ai >= 0 && seq[ai + 1] && !/Grande y Fiel/.test(seq[ai + 1]), "the other song is named, then its section: " + JSON.stringify(seq));
		ok("jumping from one song to a section of another names that song first: " + seq.join(" then "));
		assert.ok(seen72 && seen128, "tempo per part: 72 in the first, 128 from the bridge on (" + seen72 + "," + seen128 + ")");
		ok("playing it follows each part's tempo");
		await sleep(500);
		// built again with one part less: the old copy goes away, the new one takes its place
		events.length = 0;
		medley.parts[1].secs = [3];
		await post("/medley", { action: "build", at: 0, medley });
		for (let i = 0; i < 400 && !events.some(e => e.kind === "done" || e.kind === "error"); i++) await sleep(100);
		await sleep(2000);
		const st2 = await get("/state");
		const all = st2.struct.songs.filter(x => x.name === "Medley Test");
		assert.strictEqual(all.length, 1, "one medley song");
		assert.strictEqual(all[0].sections.map(x => x.name).join(","), "Count Off,Verso 1,Coro,Transition,Coro");
		const clips2 = await new Promise(res => { h.worker.once("message", function on(m) { if (m.clipsDump) res(m.clipsDump); else h.worker.once("message", on); }); h.worker.postMessage({ dumpClips: [470, 900] }); });
		assert.ok(!clips2.some(c => c.st >= 591), "nothing left of the old build: " + JSON.stringify(clips2.filter(c => c.st >= 591)));
		ok("rebuilding replaces the old medley in place of a duplicate");
		console.log("\nall passing");
	} catch (e) { bad++; console.log("FAIL " + e.message); }
	await h.stop();
	live.kill();
	process.exit(bad ? 1 : 0);
})();
