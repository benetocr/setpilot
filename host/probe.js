// Safe check of the bridge on a real Live: connects, reads the set, measures
// how fast Live answers with and without the MIDI doorbell, and leaves.
// Changes nothing in the set.
//   node host/probe.js
const fs = require("fs");
const path = require("path");
const { LiveLink } = require("./live_link");
const { makeDoorbell } = require("./doorbell");

const out = { at: new Date().toISOString() };
const log = m => console.log(m);

async function main() {
	const bell = makeDoorbell(undefined, m => (out.doorbellNote = m));
	out.doorbell = bell ? bell.kind : "none";
	let ring = null;
	const link = new LiveLink({ doorbell: () => ring && ring(), log }).start();
	const t0 = Date.now();
	const snap = await new Promise((resolve, reject) => {
		const to = setTimeout(() => reject(new Error("Live was not found: is SetPilot chosen as a Control Surface?")), 15000);
		link.on("message", m => { if (m.t === "snap") { clearTimeout(to); resolve(m); } });
	});
	out.connectMs = Date.now() - t0;
	out.live = link.info && link.info.live;
	const kinds = {};
	for (const o of Object.values(snap.o)) kinds[o.k] = (kinds[o.k] || 0) + 1;
	out.objects = kinds;
	out.snapshotKB = Math.round(JSON.stringify(snap).length / 1024);
	out.withoutDoorbell = await link.measure(20);
	if (bell) {
		ring = bell.ring;
		await new Promise(r => setTimeout(r, 1500));   // give Live a moment to see the new MIDI port
		out.withDoorbell = await link.measure(20);
	}
	// --hold N: keep the MIDI port open N seconds, measuring every 5 s, so
	// Live can be pointed at it and the doorbell checked
	const hold = Number((process.argv.find(a => a.startsWith("--hold=")) || "=0").split("=")[1]);
	if (bell && hold) {
		out.hold = [];
		const end = Date.now() + hold * 1000;
		while (Date.now() < end) {
			const m = await link.measure(10);
			out.hold.push({ t: Math.round((Date.now() - t0) / 1000), p50: m && m.p50, p95: m && m.p95, doorbells: m && m.live && m.live.doorbells });
			fs.writeFileSync(path.join(__dirname, "..", "probe-result.json"), JSON.stringify(out, null, 2));
			console.log(JSON.stringify(out.hold[out.hold.length - 1]));
			await new Promise(r => setTimeout(r, 5000));
		}
	}
	let times = 0;
	link.on("message", m => { if (m.t === "time") times++; });
	await new Promise(r => setTimeout(r, 2000));
	out.positionMsgsPerSec = times / 2;
	link.stop();
	if (bell) bell.close();
	console.log(JSON.stringify(out, null, 2));
	const file = path.join(__dirname, "..", "probe-result.json");
	fs.writeFileSync(file, JSON.stringify(out, null, 2));
	console.log("\nGuardado en " + file);
	process.exit(0);
}

main().catch(e => { console.log("ERROR: " + e.message); process.exit(1); });
