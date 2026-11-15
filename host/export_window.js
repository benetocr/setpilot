// Live's Export window, driven for the user. Live comes to the front, "Select
// Material in Loop" (Cmd+Shift+L) takes the range SetPilot put on the loop
// brace, and Export Audio/Video (Cmd+Shift+R) opens on it. With auto, SetPilot
// also presses Export, names the file in the Save window, goes to the export
// folder and saves; then it waits for Live to finish and finds the file.
// macOS asks once for the permission to send keys (Privacy & Security >
// Accessibility).
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function osa(script, timeout = 15000) {
	return new Promise(resolve => {
		execFile("osascript", ["-e", script], { timeout }, (err, out, errOut) => {
			resolve({ ok: !err, out: String(out || "").trim(), err: String(errOut || (err && err.message) || "").trim() });
		});
	});
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = s => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const FIND = `set lp to missing value
	repeat with p in (every process whose background only is false)
		set nm to name of p
		if nm is "Live" or nm starts with "Ableton Live" then set lp to p
	end repeat`;

function denied(err) { return /not allowed|assistive|-1719|-25211|1002|-1743|not authori[sz]ed/i.test(err); }

// what a name can be typed as: plain letters, digits, spaces and dashes
function typeable(s) {
	return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 _.-]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "export";
}

function makeExportWindow({ log = () => {} } = {}) {
	// opt: { auto, name (the file's name, without extension), folder (where it goes) }
	// onState: "opening", "open", "saving", "rendering", "done" (with { files }), "noopen", "nofile", "closed", "denied", "nolive", "failed"
	return function open(onState, opt = {}) {
		let stopped = false, timer = null, name = "Live";
		const stop = () => { stopped = true; clearTimeout(timer); };
		const say = (st, extra) => { if (!stopped) onState(st, extra); };
		const wait = ms => new Promise(res => { timer = setTimeout(res, ms); });
		(async () => {
			if (process.platform !== "darwin") { say("failed"); return; }
			say("opening");
			const r = await osa(`tell application "System Events"
	${FIND}
	if lp is missing value then return "nolive"
	set frontmost of lp to true
	delay 0.6
	set n to count of windows of lp
	keystroke "l" using {command down, shift down}
	delay 0.5
	keystroke "r" using {command down, shift down}
	return (n as text) & "|" & (name of lp)
end tell`);
			if (stopped) return;
			if (!r.ok) { log("export window: " + r.err); say(denied(r.err) ? "denied" : "failed"); return; }
			if (r.out === "nolive") { say("nolive"); return; }
			const base = parseInt(r.out, 10) || 0;
			name = r.out.split("|")[1] || "Live";
			const proc = `(first process whose name is "${q(name)}")`;
			const count = async () => {
				const c = await osa(`tell application "System Events" to count windows of ${proc}`, 5000);
				return c.ok ? parseInt(c.out, 10) : NaN;
			};
			// the window shows up within a few seconds
			let seen = false;
			for (let i = 0; i < 16 && !stopped && !seen; i++) {
				await wait(600);
				const n = await count();
				if (n > base) seen = true;
			}
			if (stopped) return;
			if (!seen) { say("noopen"); return; }
			say("open");
			if (opt.auto && opt.folder && opt.name) {
				const file = typeable(opt.name);
				// MP3 on when Live says it is off, then Export
				await osa(`tell application "System Events"
	tell ${proc}
		set frontmost to true
		set w to front window
		try
			with timeout of 4 seconds
				set mp to first button of entire contents of w whose name is "Encode MP3"
				set v to value of mp
				if v is 0 or v is "0" or v is false or v is "Off" then click mp
			end timeout
		end try
		delay 0.3
		set clicked to false
		try
			with timeout of 3 seconds
				click (first button of entire contents of w whose name is "Export")
				set clicked to true
			end timeout
		on error
			set clicked to true
		end try
		if not clicked then key code 36
	end tell
end tell`, 12000);
				if (stopped) return;
				await wait(1300);
				say("saving");
				// the Save window: the name, the folder (Go to Folder), save
				const s2 = await osa(`tell application "System Events"
	tell ${proc}
		set frontmost to true
		keystroke "a" using command down
		keystroke "${q(file)}"
		delay 0.4
		keystroke "g" using {command down, shift down}
		delay 0.9
		keystroke "${q(opt.folder)}"
		delay 0.5
		key code 36
		delay 1.0
		key code 36
	end tell
end tell`, 15000);
				if (!s2.ok) log("export save: " + s2.err);
				say("rendering");
			}
			// over when Live is back to its usual windows for a couple of seconds (the progress window counts as open)
			let quiet = 0;
			const started = Date.now();
			while (!stopped && Date.now() - started < 45 * 60000) {
				await wait(700);
				const n = await count();
				if (isNaN(n)) continue;
				quiet = n <= base ? quiet + 1 : 0;
				if (quiet >= 3) break;
			}
			if (stopped) return;
			if (!(opt.auto && opt.folder && opt.name)) { say("closed"); return; }
			// the file Live wrote: name.mp3 (and name.aif or .wav when PCM is on too)
			const file = typeable(opt.name);
			let found = [];
			for (let i = 0; i < 10 && !stopped; i++) {
				try { found = fs.readdirSync(opt.folder).filter(f => f.startsWith(file + ".") && !/\.asd$/.test(f)); } catch (e) { found = []; }
				if (found.length) {
					// written to the end: the size holds still
					const sz = () => found.map(f => { try { return fs.statSync(path.join(opt.folder, f)).size; } catch (e) { return -1; } }).join(",");
					const a = sz();
					await wait(600);
					if (sz() === a) break;
				} else await wait(600);
			}
			if (stopped) return;
			say(found.length ? "done" : "nofile", { files: found.map(f => path.join(opt.folder, f)) });
		})().catch(e => { log("export window: " + e.message); say("failed"); });
		return { stop };
	};
}

function openAccessibilitySettings() {
	execFile("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], () => {});
}

function reveal(folder) { execFile("open", [folder], () => {}); }

module.exports = { makeExportWindow, openAccessibilitySettings, reveal, typeable };
