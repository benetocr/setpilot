// Live's Export window, opened for the user: Live comes to the front, "Select
// Material in Loop" (Cmd+Shift+L) takes the range SetPilot put on the loop
// brace, and Export Audio/Video (Cmd+Shift+R) opens on it. Then SetPilot
// watches Live's windows to know when the export is over. macOS asks once for
// the permission to send keys (Privacy & Security > Accessibility).
const { execFile } = require("child_process");

function osa(script, timeout = 15000) {
	return new Promise(resolve => {
		execFile("osascript", ["-e", script], { timeout }, (err, out, errOut) => {
			resolve({ ok: !err, out: String(out || "").trim(), err: String(errOut || (err && err.message) || "").trim() });
		});
	});
}

const FIND = `set lp to missing value
	repeat with p in (every process whose background only is false)
		set nm to name of p
		if nm is "Live" or nm starts with "Ableton Live" then set lp to p
	end repeat`;

function denied(err) { return /not allowed|assistive|-1719|-25211|1002|-1743|not authori[sz]ed/i.test(err); }

// onState: "opening", "open", "noopen" (the window didn't show), "closed", "denied", "nolive", "failed"
function makeExportWindow({ log = () => {} } = {}) {
	return function open(onState) {
		let stopped = false, timer = null, name = "Live";
		const stop = () => { stopped = true; clearTimeout(timer); };
		const say = st => { if (!stopped) onState(st); };
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
			const count = async () => {
				const c = await osa(`tell application "System Events" to count windows of (first process whose name is "${name.replace(/"/g, "")}")`, 5000);
				return c.ok ? parseInt(c.out, 10) : NaN;
			};
			// the window shows up within a few seconds
			let seen = false;
			for (let i = 0; i < 16 && !stopped && !seen; i++) {
				await new Promise(res => { timer = setTimeout(res, 600); });
				const n = await count();
				if (n > base) seen = true;
			}
			if (stopped) return;
			if (!seen) { say("noopen"); return; }
			say("open");
			// over when Live is back to its usual windows for a couple of seconds (the progress window counts as open)
			let quiet = 0;
			const started = Date.now();
			while (!stopped && Date.now() - started < 45 * 60000) {
				await new Promise(res => { timer = setTimeout(res, 700); });
				const n = await count();
				if (isNaN(n)) continue;
				quiet = n <= base ? quiet + 1 : 0;
				if (quiet >= 3) { say("closed"); return; }
			}
		})().catch(e => { log("export window: " + e.message); say("failed"); });
		return { stop };
	};
}

function openAccessibilitySettings() {
	execFile("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], () => {});
}

module.exports = { makeExportWindow, openAccessibilitySettings };
