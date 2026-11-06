// Which audio interface Live plays through, and what each of its outputs is
// called, so the dashboard can show "Out 3 · Line Out 3" instead of a bare
// "Ext. Out 3".
//
// Live writes its output device to Log.txt ("Audio In Out: Output Device:
// Scarlett 18i20 (20 In, 20 Out)"); the channel names come from macOS
// (CoreAudio) through a small helper that ships inside the app.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function helperPath() {
	const cands = [];
	if (process.env.SETPILOT_AUDIO_HELPER) cands.push(process.env.SETPILOT_AUDIO_HELPER);
	if (process.resourcesPath) cands.push(path.join(process.resourcesPath, "bin", "sp-audio-outputs"));
	cands.push(path.join(__dirname, "..", "native-dist", "sp-audio-outputs"));
	return cands.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (e) { return false; } }) || null;
}

// the device named in the newest "Output Device:" line of Live's log
function liveOutputDevice(prefsDirs) {
	for (const p of prefsDirs || []) {
		let txt;
		try { txt = fs.readFileSync(path.join(p.dir, "Log.txt"), "utf8"); } catch (e) { continue; }
		const re = /Audio In Out: Output Device: (.+?) \((\d+) In, (\d+) Out\)/g;
		let m, last = null;
		while ((m = re.exec(txt))) last = { name: m[1], outputs: Number(m[3]) };
		if (last) return last;
	}
	return null;
}

function listDevices() {
	return new Promise(resolve => {
		const h = helperPath();
		if (!h || process.platform !== "darwin") return resolve([]);
		execFile(h, { timeout: 4000 }, (err, out) => {
			if (err) return resolve([]);
			try { resolve(JSON.parse(out).devices || []); } catch (e) { resolve([]); }
		});
	});
}

function makeAudioInfo({ prefsDirs, log = () => {} }) {
	let info = null, at = 0, busy = null;
	async function refresh() {
		const live = liveOutputDevice(typeof prefsDirs === "function" ? prefsDirs() : prefsDirs);
		const devs = await listDevices();
		let dev = live ? devs.find(d => d.name === live.name) : null;
		if (!dev && live) dev = devs.find(d => live.name.startsWith(d.name) || d.name.startsWith(live.name)) || null;
		info = {
			device: live ? live.name : (dev ? dev.name : ""),
			outputs: dev ? dev.outputs : (live ? live.outputs : 0),
			channels: dev ? dev.channels : [],
			known: !!dev
		};
		at = Date.now();
		return info;
	}
	return {
		// the last answer at once; a fresh one in the background now and then
		get() {
			if (!busy && Date.now() - at > 15000) busy = refresh().catch(e => log("audio devices:", e.message)).finally(() => { busy = null; });
			return info;
		},
		refresh
	};
}

module.exports = { makeAudioInfo, liveOutputDevice };
