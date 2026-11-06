// A new, empty set: SetPilot adds its Cues, Click and Tail tracks by itself
// when Live connects, and SetPilot Audio on the Guide when the first song
// comes in. Nothing to press.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-auto-"));
const PORT = 18824;
Object.assign(process.env, { HOME: home, SETPILOT_DATA: path.join(home, "data"), SETPILOT_PORT: String(PORT), SETPILOT_SKIP_SETUP: "1", SETPILOT_DOORBELL: "off", SP_MOCK_EMPTY: "1" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ host: "127.0.0.1", port: PORT, path: p }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));

(async () => {
	const live = spawn("python3", [path.join(ROOT, "live/tests/run_mock_live.py")], { env: process.env });
	await sleep(300);
	const { startHost } = require("../host/main");
	const h = startHost({ log: () => {} });
	const events = [];
	let bad = 0;
	const ok = m => console.log("ok   " + m);
	try {
		for (let i = 0; i < 100 && !(h.status.autoPrepared); i++) await sleep(100);
		assert.ok(h.status.autoPrepared && h.status.autoPrepared.ok, "prepared on connect: " + JSON.stringify(h.status.autoPrepared));
		assert.deepStrictEqual(h.status.autoPrepared.done, ["SetPilot Cues", "SetPilot Click", "SetPilot Crossfade"]);
		await sleep(1500);
		assert.deepStrictEqual(Object.keys(h.status.setRoles).sort(), ["click", "cues", "tail"]);
		ok("an empty set gets its SetPilot tracks as soon as Live connects");
		http.get({ host: "127.0.0.1", port: PORT, path: "/events" }, r => { r.setEncoding("utf8"); let ev = ""; r.on("data", d => { for (const line of d.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ") && ev === "import") events.push(JSON.parse(line.slice(6))); } }); });
		await sleep(300);
		h.status.autoPrepared = null;
		const plan = {
			title: "Do It Again", key: "Bb", bpm: 86, meter: "4/4", gap: 4, end: 64,
			locators: [{ time: 0, name: "Intro" }, { time: 32, name: "Verse 1" }],
			tracks: [
				{ name: "Guide", clips: [{ time: 0, file: "/x/Guide.wav", startBeat: 0, length: 64, markers: null }] },
				{ name: "Drums", clips: [{ time: 0, file: "/x/Drums.wav", startBeat: 0, length: 64, markers: null }] },
				{ name: "Click Track", clips: [{ time: 0, file: "/x/Click.wav", startBeat: 0, length: 64, markers: null }] }
			]
		};
		h.worker.postMessage({ setDict: ["setpilot_import", plan] });
		h.worker.postMessage({ send: ["importplan", []] });
		for (let i = 0; i < 300 && !events.some(e => e.kind === "done" || e.kind === "error"); i++) await sleep(100);
		assert.ok(events.some(e => e.kind === "done"), "import finished: " + JSON.stringify(events.slice(-2)));
		for (let i = 0; i < 60 && !(h.status.autoPrepared); i++) await sleep(100);
		assert.ok(h.status.autoPrepared && h.status.autoPrepared.ok, "prepared after the import: " + JSON.stringify(h.status.autoPrepared));
		assert.deepStrictEqual(h.status.autoPrepared.done, ["Guide (Guide)"]);
		await sleep(1500);
		assert.deepStrictEqual(Object.keys(h.status.setRoles).sort(), ["click", "cues", "guide", "tail"]);
		ok("the first song's Guide gets SetPilot Audio by itself");
		const clips = await new Promise(res => { h.worker.once("message", function on(m) { if (m.clipsDump) res(m.clipsDump); else h.worker.once("message", on); }); h.worker.postMessage({ dumpClips: [0, 1000] }); });
		assert.ok(!clips.some(c => /^Click Track$/.test(c.track)), "no second click track: " + JSON.stringify(clips.map(c => c.track)));
		assert.ok(clips.some(c => c.track === "SetPilot Click"), "the song's click stem is on SetPilot Click: " + JSON.stringify(clips.map(c => c.track)));
		ok("one click track: the song's click stem lands on SetPilot Click");
		console.log("\nall passing");
	} catch (e) { bad++; console.log("FAIL " + e.message); }
	await h.stop();
	live.kill();
	process.exit(bad ? 1 : 0);
})();
