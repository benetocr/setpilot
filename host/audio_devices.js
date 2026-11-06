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
function tail(file, bytes) {
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size, n = Math.min(size, bytes), buf = Buffer.alloc(n);
		fs.readSync(fd, buf, 0, n, size - n);
		return buf.toString("utf8");
	} finally { fs.closeSync(fd); }
}

function liveOutputDevice(prefsDirs) {
	for (const p of prefsDirs || []) {
		let txt;
		try { txt = tail(path.join(p.dir, "Log.txt"), 512 * 1024); } catch (e) { continue; }
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

function makeAudioInfo({ prefsDirs, log = () => {}, onChange = null }) {
	let info = null, at = 0, busy = null, lastLive = null;
	const dirs = () => (typeof prefsDirs === "function" ? prefsDirs() : prefsDirs);
	// a new interface chosen in Live's settings: look again and tell the app
	if (onChange) setInterval(() => {
		const d = liveOutputDevice(dirs());
		const key = d ? d.name + "|" + d.outputs : "";
		if (lastLive !== null && key !== lastLive) refresh().then(i => { log("audio interface now:", i.device || "none"); onChange(i); }).catch(() => {});
		lastLive = key;
	}, 3000).unref();
	async function refresh() {
		const live = liveOutputDevice(dirs());
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
