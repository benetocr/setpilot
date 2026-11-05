// "Prepare this set": against the real Remote Script on the mock Live, through
// the real host. Adds SetPilot Cues/Click/Tail tracks with SetPilot Audio in
// the right role, and SetPilot Audio on the Guide.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-prep-"));
Object.assign(process.env, { HOME: home, SETPILOT_DATA: path.join(home, "data"), SETPILOT_PORT: "18810", SETPILOT_SKIP_SETUP: "1", SETPILOT_DOORBELL: "off" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
	const live = spawn("python3", [path.join(ROOT, "live/tests/run_mock_live.py")], { env: process.env });
	await sleep(300);
	const { startHost } = require("../host/main");
	const h = startHost({ log: () => {} });
	let bad = 0;
	try {
		for (let i = 0; i < 100 && !(h.status.setRoles); i++) await sleep(100);
		assert.deepStrictEqual(h.status.setRoles, {}, "no SetPilot Audio yet");
		const r = await h.prepareSet();
		assert.ok(r.ok, r.err);
		assert.deepStrictEqual(r.done, ["SetPilot Cues", "SetPilot Click", "SetPilot Tail", "Guide (Guide)"]);
		await sleep(1500);
		assert.deepStrictEqual(Object.keys(h.status.setRoles).sort(), ["click", "cues", "guide", "tail"]);
		const again = await h.prepareSet();
		assert.deepStrictEqual(again.done, [], "second time: nothing to do");
		console.log("ok   prepare set adds the tracks and plugins once\n\nall passing");
	} catch (e) { bad++; console.log("FAIL " + e.message); }
	await h.stop();
	live.kill();
	process.exit(bad ? 1 : 0);
})();
