// End to end with plugins: the mock Live has SetPilot Audio on three tracks;
// fake plugins connect to the app like the real one (hello with their role)
// and we check what they are told.
//   node dev/e2e_plugins.js
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = 18800;
const get = p => new Promise((res, rej) => http.get({ host: "127.0.0.1", port, path: p }, r => { let b = ""; r.on("data", c => (b += c)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
const cmd = (c, ...args) => new Promise((res, rej) => { const body = JSON.stringify({ cmd: c, args }); const r = http.request({ host: "127.0.0.1", port, path: "/cmd", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, x => { x.resume(); x.on("end", res); }); r.on("error", rej); r.end(body); });
async function until(fn, ms = 8000, what = "condition") { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch (e) { } await sleep(50); } throw new Error("timeout: " + what); }

function fakePlugin(home, role) {
	const p = { role, got: [] };
	const info = JSON.parse(fs.readFileSync(path.join(home, ".setpilot", "app.json"), "utf8"));
	const s = net.createConnection({ host: "127.0.0.1", port: info.plugins });
	let buf = "";
	s.setEncoding("utf8");
	s.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { p.got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
	s.write(JSON.stringify({ t: "hello", role, sr: 48000, v: 1 }) + "\n");
	p.sock = s;
	return p;
}

(async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "sp-plug-"));
	const env = Object.assign({}, process.env, { HOME: home, SETPILOT_DATA: path.join(home, "data"), SETPILOT_PORT: String(port), SETPILOT_SKIP_SETUP: "1", SETPILOT_DOORBELL: "off" });
	const live = spawn("python3", [path.join(ROOT, "live/tests/run_mock_live.py"), "--plugins"], { env });
	await sleep(300);
	const host = spawn("node", [path.join(ROOT, "host/main.js")], { env });
	let log = "";
	host.stdout.on("data", d => (log += d)); host.stderr.on("data", d => (log += d));
	let bad = 0;
	const check = (name, fn) => { try { fn(); console.log("ok   " + name); } catch (e) { bad++; console.log("FAIL " + name + "\n     " + e.message); } };
	try {
		await until(async () => (await get("/state")).struct.songs.length === 2, 10000, "the set");
		await until(() => fs.existsSync(path.join(home, ".setpilot", "app.json")) && JSON.parse(fs.readFileSync(path.join(home, ".setpilot", "app.json"))).plugins, 5000, "plugin port");
		const P = { cues: fakePlugin(home, "cues"), guide: fakePlugin(home, "guide"), click: fakePlugin(home, "click") };
		await until(() => /plugins: .*cues/.test(log) && /guide/.test(log), 5000, "plugins seen");
		await sleep(4000);   // engine pings every 3 s
		const st = await get("/state");
		const elog = () => { try { return fs.readFileSync(path.join(home, "data", "setpilot.log"), "utf8"); } catch (e) { return ""; } };
		check("engine found the guide and click plugins on their tracks", () => { const l = elog(); assert.ok(/guide gate on track/.test(l) && /click on track/.test(l), l.split("\n").filter(x => /track|voice/.test(x)).join("\n")); });
		check("cues plugin counts as the voice player", () => assert.ok(/voice player present/.test(elog())));
		check("click plugin gets the click settings", () => assert.ok(P.click.got.some(m => m.t === "click" && m.p && m.p.beats === 4), JSON.stringify(P.click.got.slice(-2))));
		check("engine knows the click plugin's track (song click muted in favor of ours)", () => {
			const click = (st.mixer.tracks || st.mixer).find(x => x.name === "Click");
			assert.ok(click, "Click track in mixer");
		});
		await cmd("cuesource", 0);
		await cmd("precount", 1);
		await cmd("section", 0, 2, 0);
		await sleep(400);
		await cmd("play");
		await until(async () => (await get("/state")).pos.t > 50, 12000, "playing past the chorus");
		check("guide plugin gets gate commands", () => assert.ok(P.guide.got.some(m => m.t === "gatenow" || m.t === "gatearm"), JSON.stringify(P.guide.got)));
		check("cues plugin is armed with a beat", () => assert.ok(P.cues.got.some(m => (m.t === "arm" && m.beat > 0) || m.t === "play" || m.t === "disarm"), JSON.stringify(P.cues.got)));
		check("a cue armed for a section start lands before it", () => {
			const arms = P.cues.got.filter(m => m.t === "arm");
			assert.ok(arms.every(a => a.beat < 1e9));
		});
		await cmd("stop");
		// role change: the click plugin becomes a tail player
		P.click.sock.write(JSON.stringify({ t: "hello", role: "tail" }) + "\n");
		await until(() => /plugins: .*tail/.test(log), 3000, "role change seen");
		check("role change is noticed", () => assert.ok(/plugins: .*tail/.test(log)));
	} catch (e) { bad++; console.log("FAIL " + e.message + "\n" + log.split("\n").slice(-15).join("\n")); }
	host.kill(); live.kill();
	console.log(bad ? `\n${bad} failing` : "\nall passing");
	process.exit(bad ? 1 : 0);
})();
