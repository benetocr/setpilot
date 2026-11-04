// End to end: the real Python Remote Script (on the mock Live, with Live's
// ~100 ms tick) <-> TCP <-> the real app host (engine thread, mirror,
// dashboard server). Checks that a set loads, plays and stops, and measures
// how late the band comes in after a count-in, with and without doorbell.
//   node dev/e2e.js
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(port, p) {
	return new Promise((res, rej) => http.get({ host: "127.0.0.1", port, path: p }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on("error", rej));
}
function cmd(port, c, ...args) {
	return new Promise((res, rej) => {
		const body = JSON.stringify({ cmd: c, args });
		const r = http.request({ host: "127.0.0.1", port, path: "/cmd", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, x => { x.resume(); x.on("end", res); });
		r.on("error", rej); r.end(body);
	});
}
async function until(fn, ms = 8000, what = "condition") {
	const end = Date.now() + ms;
	while (Date.now() < end) { try { if (await fn()) return; } catch (e) { } await sleep(50); }
	throw new Error("timeout waiting for " + what);
}

async function run(mode, port) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-e2e-"));
	const bell = 18900 + Math.floor(Math.random() * 90);
	const env = Object.assign({}, process.env, { HOME: home, SETPILOT_DATA: path.join(home, "data"), SETPILOT_PORT: String(port), SETPILOT_SKIP_SETUP: "1" });
	const live = spawn("python3", [path.join(ROOT, "live/tests/run_mock_live.py"), "--tick", "100", ...(mode === "doorbell" ? ["--doorbell", String(bell)] : [])], { env });
	const mutes = [];
	let liveOut = "";
	live.stdout.on("data", d => { liveOut += d; let i; while ((i = liveOut.indexOf("\n")) >= 0) { const l = liveOut.slice(0, i); liveOut = liveOut.slice(i + 1); try { const o = JSON.parse(l); if (o.mute) mutes.push(o); } catch (e) { } } });
	live.stderr.on("data", d => process.stderr.write("[live] " + d));
	await sleep(300);
	const host = spawn("node", [path.join(ROOT, "host/main.js")], { env: Object.assign({}, env, { SETPILOT_DOORBELL: mode === "doorbell" ? "udp:" + bell : "off" }) });
	let hostLog = "";
	host.stdout.on("data", d => (hostLog += d));
	host.stderr.on("data", d => (hostLog += d));
	const out = { mode };
	try {
		await until(async () => { const s = await get(port, "/state"); return s.struct && s.struct.songs && s.struct.songs.length === 2; }, 10000, "the set");
		const s = await get(port, "/state");
		out.songs = s.struct.songs.map(x => x.name + " (" + x.sections.length + ")").join(", ");
		await until(() => /Live answers in/.test(hostLog), 8000, "calibration");
		out.latency = hostLog.match(/Live answers in (.*)/)[1];
		await cmd(port, "cuesource", 0);
		await cmd(port, "precount", 1);
		await cmd(port, "section", 0, 2, 0);          // Coro at 48
		await sleep(400);
		mutes.length = 0;
		await cmd(port, "play");
		await until(async () => (await get(port, "/state")).pos.t > 49, 10000, "the band to come in");
		const drumsIn = mutes.find(m => m.mute === "Drums" && m.v === 0 && m.playing);
		const tempo = 72;
		out.bandIn = drumsIn ? Math.round((drumsIn.t - 48) * 60000 / tempo) + " ms after the downbeat" : "not seen: " + JSON.stringify(mutes);
		out.countInMuted = mutes.some(m => m.mute === "Drums" && m.v === 1) ? "yes" : "no";
		await cmd(port, "stop");
		await until(async () => (await get(port, "/state")).pos.playing === 0, 3000, "stop");
		out.stopped = "yes";
	} catch (e) {
		out.error = e.message;
		out.log = hostLog.split("\n").slice(-15).join("\n");
	} finally {
		host.kill();
		live.kill();
	}
	return out;
}

(async () => {
	let bad = 0;
	for (const [mode, port] of [["tick", 18780], ["doorbell", 18790]]) {
		const r = await run(mode, port);
		console.log(JSON.stringify(r, null, 1));
		if (r.error) bad++;
	}
	process.exit(bad ? 1 : 0);
})();
