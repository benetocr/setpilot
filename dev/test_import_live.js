// Import through the real host and the real Remote Script on the mock Live
// (Live's ~100 ms tick, late notifications): the song must appear with its
// locators named and the dashboard must hear "done".
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-imp-"));
const PORT = 18820;
Object.assign(process.env, { HOME: home, SETPILOT_DATA: path.join(home, "data"), SETPILOT_PORT: String(PORT), SETPILOT_SKIP_SETUP: "1", SETPILOT_DOORBELL: "off" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ host: "127.0.0.1", port: PORT, path: p }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));

(async () => {
	const live = spawn("python3", [path.join(ROOT, "live/tests/run_mock_live.py")], { env: process.env });
	await sleep(300);
	const { startHost } = require("../host/main");
	const h = startHost({ log: () => {} });
	const events = [];
	let bad = 0;
	try {
		for (let i = 0; i < 100; i++) { try { if ((await get("/state")).struct.songs.length === 2) break; } catch (e) { } await sleep(100); }
		http.get({ host: "127.0.0.1", port: PORT, path: "/events" }, r => { r.setEncoding("utf8"); let ev = ""; r.on("data", d => { for (const line of d.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ") && ev === "import") events.push(JSON.parse(line.slice(6))); } }); });
		const plan = {
			title: "Do It Again", key: "Bb", bpm: 86, meter: "4/4", gap: 4, end: 140,
			locators: [{ time: 0, name: "Intro" }, { time: 32, name: "Verse 1" }],
			tracks: [
				{ name: "Drums", clips: [{ time: 0, file: "/x/Drums.wav", startBeat: 0, length: 140, markers: [[0, 0], [60 / 86, 1]] }] },
				{ name: "Keys", clips: [{ time: 0, file: "/x/Keys.wav", startBeat: 0, length: 140, markers: null }] }
			]
		};
		h.worker.postMessage({ setDict: ["setpilot_import", plan] });
		h.worker.postMessage({ send: ["importplan", []] });
		for (let i = 0; i < 300 && !events.some(e => e.kind === "done" || e.kind === "error"); i++) await sleep(100);
		const last = events[events.length - 1];
		assert.ok(last && last.kind === "done", "import finished: " + JSON.stringify(events.slice(-3)));
		await sleep(1500);
		const st = await get("/state");
		const s = st.struct.songs.find(x => x.name === "Do It Again");
		assert.ok(s, "song is there: " + st.struct.songs.map(x => x.name).join(", "));
		assert.ok(s.sections.some(x => x.name === "Verse 1"), "Verse 1 locator named: " + s.sections.map(x => x.name).join(","));
		console.log("ok   import through the Remote Script names the song and its locators and reports done\n\nall passing");
	} catch (e) { bad++; console.log("FAIL " + e.message); }
	await h.stop();
	live.kill();
	process.exit(bad ? 1 : 0);
})();
