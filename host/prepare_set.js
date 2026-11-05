// One click to make a set ready for SetPilot's sound: a track for the cue
// voice, one for the click and one for the tail, each with SetPilot Audio set
// to its role, and SetPilot Audio on the song's Guide track as its gate.
// Uses the same LiveAPI calls as the engine (blocking ones: this is not
// during playback).

const TRACKS = [
	{ role: "cues", name: "SetPilot Cues" },
	{ role: "click", name: "SetPilot Click" },
	{ role: "tail", name: "SetPilot Tail" }
];
const ROLE_INDEX = { click: 0, cues: 1, guide: 2, tail: 3 };
const GUIDE_RE = /^(guide|gu[ií]a|cues?|voice ?cues?|vocal ?cues?)\b/i;

function prepareSet({ mirror, router, log = () => {} }) {
	const song = () => mirror.objs.get(mirror.roots.song);
	const tracks = () => (song().p.tracks || []).map(r => r.$);
	const have = router.roleTracks();
	const done = [];

	function setRole(devId, role) {
		const dev = mirror.objs.get(devId);
		const pref = ((dev && dev.p.parameters) || []).find(r => { const p = mirror.objs.get(r.$); return p && p.p.name === "SetPilot Role"; });
		if (!pref) throw new Error("SetPilot Audio has no role parameter");
		const id = pref.$, want = ROLE_INDEX[role];
		const max = Number(mirror.get(id, "max"));
		// Live gives plug-in choices either as steps (0..3) or as 0..1
		for (const v of max > 1.5 ? [want, want / 3] : [want / 3, want]) {
			mirror.call(id, "set_value", [v], { sync: true });
			if (String(mirror.get(id, "display")).toLowerCase() === role) return;
		}
		log("could not confirm the role of the new SetPilot Audio: " + mirror.get(id, "display"));
	}

	const isOurs = id => /^SetPilot/.test(String((mirror.objs.get(id) || { p: {} }).p.name));
	const devicesOf = trackId => (mirror.get(trackId, "devices") || []).map(r => r.$);

	function addPlugin(trackId, role) {
		const before = new Set(devicesOf(trackId));
		let dev = mirror.call(trackId, "insert_plugin", ["SetPilot Audio", "VST3"], { sync: true });
		let id = dev && dev.$;
		// Live adds the device a moment after loading it: ask again until it is there
		const until = Date.now() + 5000;
		while (id == null && Date.now() < until) {
			const r = mirror.request({ t: "get", id: trackId, p: "devices" });   // also brings in what changed
			const now = (r && r.ok && r.v || []).map(x => x.$);
			id = now.find(x => !before.has(x) && isOurs(x));
			if (id == null) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
		}
		if (id == null) throw new Error("SetPilot Audio did not appear on the track (is it enabled in Live's Plug-Ins settings?)");
		setRole(id, role);
	}

	for (const t of TRACKS) {
		if (have[t.role]) continue;
		const before = new Set(tracks());
		mirror.call(mirror.roots.song, "create_audio_track", [-1], { sync: true });
		const id = tracks().find(x => !before.has(x));
		if (!id) throw new Error("could not create the " + t.name + " track");
		mirror.set(id, "name", t.name);
		addPlugin(id, t.role);
		done.push(t.name);
	}
	if (!have.guide) {
		const guide = tracks().find(id => GUIDE_RE.test(String(mirror.get(id, "name"))));
		if (guide) { addPlugin(guide, "guide"); done.push("Guide (" + mirror.get(guide, "name") + ")"); }
	}
	return done;
}

module.exports = { prepareSet };
