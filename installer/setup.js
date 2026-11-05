// Zero-touch setup: finds Ableton Live and its User Library, installs (or
// updates) the SetPilot Remote Script there, and reports what is left, if
// anything, in plain words. Run by the app on every start; it only writes
// when something is missing or outdated.
//
//   node installer/setup.js            install if needed, print the status
//   node installer/setup.js --check    print the status only

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SCRIPT_SRC = path.join(__dirname, "..", "live", "SetPilot");
const SCRIPT_NAME = "SetPilot";

function env(o = {}) {
	return { platform: o.platform || process.platform, home: o.home || os.homedir(), appdata: o.appdata || process.env.APPDATA, programdata: o.programdata || process.env.ProgramData || "C:\\ProgramData", apps: o.apps };
}

const exists = p => { try { fs.accessSync(p); return true; } catch (e) { return false; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const ls = p => { try { return fs.readdirSync(p); } catch (e) { return []; } };

function versionKey(v) {
	const m = String(v).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
	return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3] || 0) : 0;
}

// ---------------------------------------------------------------- Live itself
function findLive(o) {
	const e = env(o), out = [];
	if (e.platform === "darwin") {
		for (const dir of e.apps || ["/Applications", path.join(e.home, "Applications")]) {
			for (const n of ls(dir)) {
				if (!/^Ableton Live.*\.app$/.test(n)) continue;
				const app = path.join(dir, n);
				let version = (n.match(/Live (\d+)/) || [])[1] || "";
				try {
					const plist = fs.readFileSync(path.join(app, "Contents", "Info.plist"), "utf8");
					const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
					if (m) version = m[1].trim();
				} catch (err) { }
				out.push({ path: app, version, edition: (n.match(/(Suite|Standard|Intro|Lite|Trial)/) || [])[1] || "" });
			}
		}
	} else if (e.platform === "win32") {
		const base = path.join(e.programdata, "Ableton");
		for (const n of ls(base)) {
			if (!/^Live \d/.test(n)) continue;
			const prog = path.join(base, n, "Program");
			const exe = ls(prog).find(f => /^Ableton Live.*\.exe$/i.test(f));
			if (exe) out.push({ path: path.join(prog, exe), version: (n.match(/Live ([\d.]+)/) || [])[1] || "", edition: (n.match(/(Suite|Standard|Intro|Lite|Trial)/) || [])[1] || "" });
		}
	}
	return out.sort((a, b) => versionKey(b.version) - versionKey(a.version));
}

// Live keeps one preferences folder per version ("Live 12.1.5")
function prefsDirs(o) {
	const e = env(o);
	const base = e.platform === "darwin" ? path.join(e.home, "Library", "Preferences", "Ableton")
		: e.platform === "win32" ? path.join(e.appdata || path.join(e.home, "AppData", "Roaming"), "Ableton") : null;
	if (!base) return [];
	return ls(base).filter(n => /^Live \d/.test(n))
		.map(n => ({ version: n.slice(5), dir: e.platform === "win32" ? path.join(base, n, "Preferences") : path.join(base, n) }))
		.filter(p => isDir(p.dir))
		.sort((a, b) => versionKey(b.version) - versionKey(a.version));
}

// ---------------------------------------------------------------- User Library
function defaultUserLibrary(o) {
	const e = env(o);
	return e.platform === "win32" ? path.join(e.home, "Documents", "Ableton", "User Library") : path.join(e.home, "Music", "Ableton", "User Library");
}

// Library.cfg names the User Library when the user moved it. Live 12 writes
// the parent folder and the name apart:
//   <ProjectName Value="User Library" /> <ProjectPath Value="/Users/x/Music/Ableton" />
function userLibraryFromCfg(cfgText) {
	const block = (cfgText.match(/<UserLibrary>([\s\S]*?)<\/UserLibrary>/) || [])[1];
	if (!block) return null;
	const val = tag => (block.match(new RegExp("<" + tag + "\\s+Value=\"([^\"]*)\"")) || [])[1];
	const dir = val("ProjectPath"), name = val("ProjectName");
	if (dir && name) return path.join(dir, name);
	if (dir) return dir;
	return null;
}

function findUserLibraries(o) {
	const found = [];
	for (const p of prefsDirs(o)) {
		try {
			const lib = userLibraryFromCfg(fs.readFileSync(path.join(p.dir, "Library.cfg"), "utf8"));
			if (lib && isDir(lib) && !found.includes(lib)) found.push(lib);
		} catch (e) { }
	}
	const def = defaultUserLibrary(o);
	if (!found.includes(def) && (isDir(def) || !found.length)) found.push(def);
	return found;
}

// ---------------------------------------------------------------- the script
// only the script itself: the folder may also hold its log and self-check
function sourceFiles() {
	return ls(SCRIPT_SRC).filter(f => /\.py$/.test(f) || f === "spec.json").sort();
}

function sourceHash() {
	const h = crypto.createHash("sha1");
	for (const f of sourceFiles()) { h.update(f); h.update(fs.readFileSync(path.join(SCRIPT_SRC, f))); }
	return h.digest("hex").slice(0, 12);
}

function installedHash(dir) {
	try { return fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim(); } catch (e) { return null; }
}

function installScript(userLibrary) {
	const dir = path.join(userLibrary, "Remote Scripts", SCRIPT_NAME);
	const want = sourceHash();
	if (installedHash(dir) === want) return { dir, changed: false };
	const tmp = dir + ".installing";
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.mkdirSync(tmp, { recursive: true });
	for (const f of sourceFiles()) fs.copyFileSync(path.join(SCRIPT_SRC, f), path.join(tmp, f));
	fs.writeFileSync(path.join(tmp, "VERSION"), want + "\n");
	// swap in one step so Live never sees half a script
	const old = dir + ".old";
	fs.rmSync(old, { recursive: true, force: true });
	if (exists(dir)) fs.renameSync(dir, old);
	fs.renameSync(tmp, dir);
	fs.rmSync(old, { recursive: true, force: true });
	return { dir, changed: true };
}

// ---------------------------------------------------------------- is it selected?
// Live writes its control surface slots to Log.txt in plain text on every
// start and settings change:
//   MidiRemoteScript 2 [Control Surface="SetPilot" Input="SetPilot Bridge" ...]
// The last such block is the current state. Preferences.cfg (binary) is the
// fallback.
function surfaceState(o) {
	const p = prefsDirs(o)[0];
	if (!p) return { selected: null };
	try {
		const log = fs.readFileSync(path.join(p.dir, "Log.txt"), "utf8");
		const re = /MidiRemoteScript (\d+) \[Control Surface="([^"]*)" Input="([^"]*)" Output="([^"]*)"\]/g;
		const slots = {};
		let m;
		while ((m = re.exec(log))) slots[m[1]] = { surface: m[2], input: m[3], output: m[4] };
		const mine = Object.entries(slots).find(([, v]) => v.surface === SCRIPT_NAME);
		if (Object.keys(slots).length) return { selected: !!mine, slot: mine ? Number(mine[0]) : null, input: mine ? mine[1].input : null };
	} catch (e) { }
	try {
		const buf = fs.readFileSync(path.join(p.dir, "Preferences.cfg"));
		return { selected: buf.includes(Buffer.from(SCRIPT_NAME, "latin1")) || buf.includes(Buffer.from(SCRIPT_NAME, "utf16le")) };
	} catch (e) { return { selected: null }; }
}

function surfaceSelected(o) { return surfaceState(o).selected; }

function liveRunning(o) {
	const e = env(o);
	try {
		if (e.platform === "darwin") return /Ableton Live/.test(execFileSync("pgrep", ["-lf", "Ableton Live"], { encoding: "utf8" }));
		if (e.platform === "win32") return /Ableton Live/i.test(execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" }));
	} catch (err) { return false; }
	return false;
}

// ---------------------------------------------------------------- all of it
function setup(o = {}) {
	const live = findLive(o);
	const libs = findUserLibraries(o);
	const surf = surfaceState(o);
	const res = { live, userLibraries: libs, installed: [], selected: surf.selected, surface: surf, running: o.running != null ? o.running : liveRunning(o), steps: [] };
	if (!o.checkOnly) {
		for (const lib of libs) {
			try {
				fs.mkdirSync(lib, { recursive: true });
				const r = installScript(lib);
				res.installed.push(r);
			} catch (e) { res.steps.push({ id: "install-failed", text: "Could not copy the SetPilot script into " + lib + ": " + e.message }); }
		}
	}
	const changed = res.installed.some(r => r.changed);
	if (!live.length && (o.platform || process.platform) !== "linux") res.steps.push({ id: "no-live", text: "Ableton Live was not found on this computer." });
	if (changed && res.running) res.steps.push({ id: "restart-live", text: "Restart Live once so it loads SetPilot." });
	if (res.selected && surf.input && surf.input !== "SetPilot Bridge") res.steps.push({ id: "input", text: "SetPilot is selected but its MIDI input is " + surf.input + "; choose SetPilot Bridge for the fastest response." });
	if (res.selected === false) res.steps.push({ id: "auto-select", text: "Live will pick SetPilot by itself when it starts. If it does not, choose SetPilot under Settings > Link, Tempo & MIDI > Control Surface." });
	return res;
}

module.exports = { setup, findLive, prefsDirs, findUserLibraries, userLibraryFromCfg, installScript, surfaceSelected, surfaceState, sourceHash, defaultUserLibrary };

if (require.main === module) {
	const r = setup({ checkOnly: process.argv.includes("--check") });
	console.log(JSON.stringify(r, null, 2));
}
