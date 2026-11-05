// Checks the zero-touch installer against fake Mac and Windows folders.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require("../installer/setup");

let failures = 0;
function test(name, fn) { try { fn(); console.log("ok   " + name); } catch (e) { failures++; console.log("FAIL " + name + "\n     " + e.message); } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sp-setup-"));
const put = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };

function mac({ customLib, selected } = {}) {
	const home = tmp(), apps = path.join(home, "Applications");
	put(path.join(apps, "Ableton Live 12 Suite.app", "Contents", "Info.plist"), "<plist><dict><key>CFBundleShortVersionString</key>\n<string>12.1.5</string></dict></plist>");
	put(path.join(apps, "Ableton Live 11 Standard.app", "Contents", "Info.plist"), "<plist><dict><key>CFBundleShortVersionString</key><string>11.3.4</string></dict></plist>");
	const prefs = path.join(home, "Library", "Preferences", "Ableton", "Live 12.1.5");
	fs.mkdirSync(prefs, { recursive: true });
	fs.mkdirSync(path.join(home, "Music", "Ableton", "User Library"), { recursive: true });
	if (customLib) {
		fs.mkdirSync(customLib, { recursive: true });
		put(path.join(prefs, "Library.cfg"), `<?xml version="1.0"?><Ableton><ContentLibrary><UserLibrary>\n\t<LibraryProject Id="0">\n\t\t<ProjectLocation />\n\t\t<ProjectName Value="${path.basename(customLib)}" />\n\t\t<ProjectPath Value="${path.dirname(customLib)}" />\n\t</LibraryProject>\n</UserLibrary></ContentLibrary></Ableton>`);
	}
	put(path.join(prefs, "Preferences.cfg"), Buffer.concat([Buffer.from([0, 1, 2]), selected ? Buffer.from("SetPilot", "utf16le") : Buffer.from("Push2", "utf16le"), Buffer.from([9])]));
	return { platform: "darwin", home, apps: [apps], running: false };
}

test("finds Live, newest first, with edition and version", () => {
	const o = mac();
	const live = S.findLive(o);
	assert.deepStrictEqual(live.map(l => l.version), ["12.1.5", "11.3.4"]);
	assert.strictEqual(live[0].edition, "Suite");
});

test("installs the script into the default User Library and only once", () => {
	const o = mac();
	const r1 = S.setup(o);
	const dir = path.join(o.home, "Music", "Ableton", "User Library", "Remote Scripts", "SetPilot");
	assert.ok(fs.existsSync(path.join(dir, "__init__.py")));
	assert.ok(fs.existsSync(path.join(dir, "spec.json")));
	assert.strictEqual(fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim(), S.sourceHash());
	assert.strictEqual(r1.installed[0].changed, true);
	const r2 = S.setup(o);
	assert.strictEqual(r2.installed[0].changed, false, "second run leaves it alone");
	assert.ok(!fs.existsSync(dir + ".installing") && !fs.existsSync(dir + ".old"));
});

test("an older copy is replaced whole", () => {
	const o = mac();
	const dir = path.join(o.home, "Music", "Ableton", "User Library", "Remote Scripts", "SetPilot");
	put(path.join(dir, "VERSION"), "old\n");
	put(path.join(dir, "stale.py"), "x");
	const r = S.setup(o);
	assert.strictEqual(r.installed[0].changed, true);
	assert.ok(!fs.existsSync(path.join(dir, "stale.py")));
});

test("a User Library moved elsewhere is followed", () => {
	const lib = path.join(tmp(), "Musica", "Mi User Library");
	const o = mac({ customLib: lib });
	S.setup(o);
	assert.ok(fs.existsSync(path.join(lib, "Remote Scripts", "SetPilot", "core.py")));
});

test("knows whether Live already uses the SetPilot surface", () => {
	assert.strictEqual(S.setup(mac({ selected: true })).selected, true);
	const r = S.setup(mac({ selected: false }));
	assert.strictEqual(r.selected, false);
	assert.ok(r.steps.some(s => s.id === "auto-select"));
});

test("asks for one restart when the script changed while Live runs", () => {
	const o = Object.assign(mac({ selected: true }), { running: true });
	assert.ok(S.setup(o).steps.some(s => s.id === "restart-live"));
	assert.ok(!S.setup(o).steps.some(s => s.id === "restart-live"), "not again once installed");
});

test("Windows: Live in ProgramData, prefs in AppData, library in Documents", () => {
	const home = tmp(), pd = path.join(home, "ProgramData"), ad = path.join(home, "AppData", "Roaming");
	put(path.join(pd, "Ableton", "Live 12 Suite", "Program", "Ableton Live 12 Suite.exe"), "");
	fs.mkdirSync(path.join(ad, "Ableton", "Live 12.1.5", "Preferences"), { recursive: true });
	const o = { platform: "win32", home, appdata: ad, programdata: pd, running: false };
	const r = S.setup(o);
	assert.strictEqual(r.live[0].edition, "Suite");
	assert.ok(fs.existsSync(path.join(home, "Documents", "Ableton", "User Library", "Remote Scripts", "SetPilot", "surface.py")));
});

test("Live's log tells which slot uses SetPilot and its MIDI input", () => {
	const o = mac();
	const prefs = path.join(o.home, "Library", "Preferences", "Ableton", "Live 12.1.5");
	put(path.join(prefs, "Log.txt"), 'x\n  MidiRemoteScript 1 [Control Surface="Push2" Input="None" Output="None"]\n  MidiRemoteScript 2 [Control Surface="None" Input="None" Output="None"]\nlater\n  MidiRemoteScript 1 [Control Surface="Push2" Input="None" Output="None"]\n  MidiRemoteScript 2 [Control Surface="SetPilot" Input="SetPilot Bridge" Output="None"]\n');
	assert.deepStrictEqual(S.surfaceState(o), { selected: true, slot: 2, input: "SetPilot Bridge" });
});

test("Library.cfg parsing (Live 12: folder and name apart)", () => {
	assert.strictEqual(S.userLibraryFromCfg('<UserLibrary>\n<LibraryProject Id="0">\n<ProjectLocation />\n<ProjectName Value="User Library" />\n<ProjectPath Value="/Users/elvin/Music/Ableton" />\n</LibraryProject></UserLibrary>'), "/Users/elvin/Music/Ableton/User Library");
	assert.strictEqual(S.userLibraryFromCfg("nothing"), null);
});

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
