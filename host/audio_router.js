// Turns what the engine says to its Max audio devices into messages for the
// SetPilot Audio plugins, and answers the engine's "are you there?" pings for
// them. Runs on the engine thread, next to the mirror, because finding which
// track a plugin sits on needs Live's state.
//
// Max (old)                                   plugin role / message
//   outlet 1: cueidx, cuearm b b u, play,     cues:  preload, arm, disarm, play
//             preload idx path
//   setpilot_gate: gateval, gatearm, gatenow  guide: gatearm, gatenow
//   setpilot_click: param k v                 click: click {all params}
//   setpilot_tail: load, play, stop           tail:  tailload, tailplay, tailstop

const ROLE_OF = { setpilot_gate: "guide", setpilot_click: "click", setpilot_tail: "tail" };
const HELLO_OF = { guide: "gatehello", click: "clickhello", tail: "tailhello" };
const ROLE_NAMES = { click: "Click", cues: "Cues", guide: "Guide", tail: "Tail" };

class AudioRouter {
	// send(role, msg) to plugins; reply(cmd, args) to the engine (later, not inside its tick)
	constructor({ mirror, send, reply, log = () => {}, pads = null }) {
		this.mirror = mirror;
		this.pads = pads;    // { dir, list: [{ root, file, length }] }: the recorded pads, one per key
		this.send = send;
		this.reply = reply;
		this.log = log;
		this.connected = {};
		this.state = { cueIdx: 0, preload: {}, arm: null, gateVal: 1, gate: null, click: {}, tailPath: null };
	}

	// role -> track id, from the devices Live reports: a device whose name
	// starts with "SetPilot" and whose "SetPilot Role" parameter shows the role
	roleTracks() {
		const m = this.mirror, out = {};
		const song = m.objs.get(m.roots.song);
		if (!song) return out;
		for (const tref of song.p.tracks || []) {
			const tr = m.objs.get(tref.$);
			for (const dref of (tr && tr.p.devices) || []) {
				const dev = m.objs.get(dref.$);
				if (!dev || !/^SetPilot/.test(String(dev.p.name))) continue;
				for (const pref of dev.p.parameters || []) {
					const prm = m.objs.get(pref.$);
					if (!prm || prm.p.name !== "SetPilot Role") continue;
					const role = String(prm.p.display || "").toLowerCase();
					if (ROLE_NAMES[role] && !out[role]) out[role] = tref.$;
				}
			}
		}
		return out;
	}

	beatOf(b, bb, u) {
		b = Number(b); bb = Number(bb); u = Number(u);
		if (b >= 9999) return 1e12;
		const song = this.mirror.objs.get(this.mirror.roots.song);
		const num = (song && song.p.signature_numerator) || 4, den = (song && song.p.signature_denominator) || 4;
		return (b - 1) * num * 4 / den + (bb - 1) * 4 / den + u / 480;
	}

	// ------------------------------------------------------------ from the engine
	outlet1(args) {
		const [m, ...r] = args, s = this.state;
		if (m === "cueidx") s.cueIdx = Number(r[0]);
		else if (m === "cuearm") {
			const beat = this.beatOf(r[0], r[1], r[2]);
			s.arm = beat >= 1e12 ? null : { idx: s.cueIdx, beat };
			this.send("cues", s.arm ? { t: "arm", idx: s.arm.idx, beat } : { t: "disarm" });
		} else if (m === "play") this.send("cues", { t: "play", idx: Number(r[0]) });
		else if (m === "preload") {
			s.preload[Number(r[0])] = String(r[1]);
			this.send("cues", { t: "preload", idx: Number(r[0]), path: String(r[1]) });
		}
	}

	messnamed(name, args) {
		const role = ROLE_OF[name];
		if (!role) return;
		const [m, ...r] = args, s = this.state;
		if (m === "ping") {
			if (!this.connected[role]) return;
			const tid = this.roleTracks()[role];
			if (tid) setImmediate(() => this.reply(HELLO_OF[role], ["id", tid]));
			return;
		}
		if (role === "guide") {
			if (m === "gateval") s.gateVal = Number(r[0]);
			else if (m === "gatearm") { s.gate = { beat: this.beatOf(r[0], r[1], r[2]), v: s.gateVal }; this.send("guide", { t: "gatearm", beat: s.gate.beat, v: s.gate.v }); }
			else if (m === "gatenow") { s.gate = null; s.gateNow = Number(r[0]); this.send("guide", { t: "gatenow", v: Number(r[0]) }); }
		} else if (role === "click") {
			if (m === "param") { s.click[r[0]] = Number(r[1]); this.sendClickSoon(); }
		} else if (role === "tail") {
			if (m === "load") { s.tailPath = String(r[0]); this.send("tail", { t: "tailload", path: s.tailPath }); }
			// rate already carries the tempo change; the old device also took a pitch factor
			else if (m === "play") this.send("tail", { t: "tailplay", rate: Number(r[0]), pitch: Number(r[1]), mode: Number(r[2]), durMs: Number(r[3]), offsetMs: Number(r[4]) });
			else if (m === "stop") this.send("tail", { t: "tailstop" });
			// pads between the keys of a medley: chords on beats (root 0-11, quality 1 major, 2 minor, 0 off)
			else if (m === "pad") this.send("tail", { t: "padev", beat: Number(r[0]), root: Number(r[1]), q: Number(r[2]) });
			else if (m === "padclear") this.send("tail", { t: "padclear" });
			else if (m === "padlevel") { s.padLevel = Number(r[0]); this.send("tail", { t: "padlevel", v: s.padLevel }); }
		}
	}

	// the engine sends the click settings one by one: send them as one message
	sendClickSoon() {
		if (this.clickTimer) return;
		this.clickTimer = setImmediate(() => { this.clickTimer = null; this.send("click", { t: "click", p: this.state.click }); });
	}

	// ------------------------------------------------------------ from the plugins
	// a plugin of this role appeared or went away: give it everything it missed
	setConnected(roles) {
		const before = this.connected;
		this.connected = roles;
		for (const role of Object.keys(ROLE_NAMES)) {
			if (!before[role] && roles[role]) this.replay(role);
		}
		const voice = !!roles.cues;
		if (voice !== !!before.cues) setImmediate(() => this.reply("voiceplayer", [voice ? 1 : 0]));
	}

	replay(role) {
		const s = this.state;
		if (role === "cues") {
			for (const idx in s.preload) this.send("cues", { t: "preload", idx: Number(idx), path: s.preload[idx] });
			if (s.arm) this.send("cues", { t: "arm", idx: s.arm.idx, beat: s.arm.beat });
		} else if (role === "click") this.send("click", { t: "click", p: s.click });
		else if (role === "guide") {
			if (s.gate) this.send("guide", { t: "gatearm", beat: s.gate.beat, v: s.gate.v });
			else if (s.gateNow != null) this.send("guide", { t: "gatenow", v: s.gateNow });
		} else if (role === "tail") {
			if (s.tailPath) this.send("tail", { t: "tailload", path: s.tailPath });
			if (s.padLevel != null) this.send("tail", { t: "padlevel", v: s.padLevel });
			if (this.pads) for (const p of this.pads.list) this.send("tail", { t: "padload", root: p.root, path: require("path").join(this.pads.dir, p.file), len: p.length });
		}
	}

	event(role, m) {
		if (role === "cues" && m.t === "fired") setImmediate(() => this.reply("cuefired", [m.idx]));
	}
}

module.exports = { AudioRouter, ROLE_NAMES };
