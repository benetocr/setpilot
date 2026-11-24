// A set that already has songs but no SetPilot tracks (made on another
// computer): SetPilot adds its tracks when Live connects, so the cues speak.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-auto2-"));
Object.assign(process.env, { HOME: home, SETPILOT_DATA: path.join(home, "data"), SETPILOT_PORT: "18834", SETPILOT_SKIP_SETUP: "1", SETPILOT_DOORBELL: "off" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
	const live = spawn("python3", [path.join(ROOT, "live/tests/run_mock_live.py")], { env: process.env });
	await sleep(300);
	const { startHost } = require("../host/main");
	const h = startHost({ log: () => {} });
	let bad = 0;
	try {
		for (let i = 0; i < 100 && !(h.status.autoPrepared); i++) await sleep(100);
		assert.ok(h.status.autoPrepared && h.status.autoPrepared.ok, "prepared on connect: " + JSON.stringify(h.status.autoPrepared));
		assert.ok(h.status.autoPrepared.done.includes("SetPilot Cues"), JSON.stringify(h.status.autoPrepared.done));
		await sleep(1500);
		assert.ok(h.status.setRoles.cues, JSON.stringify(h.status.setRoles));
		console.log("ok   a set with songs and no SetPilot tracks gets them when Live connects");
		const http = require("http");
		const get = p => new Promise((res, rej) => http.get({ host: "127.0.0.1", port: 18834, path: p }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on("error", rej));
		const hc = (await get("/health")).items, by = id => hc.find(x => x.id === id) || {};
		assert.strictEqual(by("live").ok, true, JSON.stringify(hc));
		assert.strictEqual(by("tracks").ok, true, JSON.stringify(by("tracks")));
		assert.strictEqual(by("plugin").ok, true);
		assert.strictEqual(by("bank").ok, true, JSON.stringify(by("bank")));
		console.log("ok   the system check sees Live, the tracks and the cue bank\n\nall passing");
	} catch (e) { bad++; console.log("FAIL " + e.message); }
	await h.stop();
	live.kill();
	process.exit(bad ? 1 : 0);
})();
