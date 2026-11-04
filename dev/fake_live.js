// A small stand-in for Ableton Live's API, enough to run the real
// setpilot_engine.js outside Max: arrangement transport, locators,
// quantized locator jumps, the arrangement loop and tempo per song.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DEMO_CUES = [
	["# Grande y Fiel | 72 | G", 0], ["Intro", 0], ["Verso 1", 16], ["Coro", 48], ["Verso 2", 80],
	["Coro", 112], ["Puente", 144], ["Coro", 176], ["Final", 208], ["STOP", 232],
	["# Cielo Abierto | 128 | D", 256], ["Intro", 256], ["Verso", 272], ["Pre Coro", 304], ["Coro", 320],
	["Instrumental", 352], ["Puente", 368], ["Coro", 400], ["Tag", 432], ["Final", 448], ["STOP", 464],
	["# Tu Nombre | 68 | Bb", 480], ["Intro", 480], ["Verso 1", 488], ["Coro", 520], ["Verso 2", 552],
	["Coro", 584], ["Puente", 616], ["Puente", 632], ["Coro", 648], ["Outro", 680], ["STOP", 696],
	["# Santo Espíritu | 140 | E", 704], ["Intro", 704], ["Verso", 720], ["Coro", 752], ["Interludio", 784],
	["Verso", 792], ["Coro", 824], ["Vamp", 856], ["Final", 888], ["STOP", 904]
];

class FakeSong {
	constructor(cues) {
		this.props = {
			current_song_time: 0, is_playing: 0, tempo: 120,
			signature_numerator: 4, signature_denominator: 4,
			loop: 0, loop_start: 0, loop_length: 16,
			clip_trigger_quantization: 4, back_to_arranger: 0,
			last_event_time: 0, song_length: 0
		};
		this.cues = [];
		this.nextId = 100;
		this.listeners = [];
		this.pendingJump = null;
		this.log = [];
		this.tracks = [
			{ id: 1, name: "Click", mute: 0, has_midi_input: 0 }, { id: 2, name: "Guide", mute: 0, has_midi_input: 0 },
			{ id: 3, name: "Drums", mute: 0, has_midi_input: 0 }, { id: 4, name: "SP Cues", mute: 0, has_midi_input: 0 },
			{ id: 5, name: "Keys", mute: 0, has_midi_input: 0 }, { id: 6, name: "SP Click", mute: 0, has_midi_input: 0 },
			{ id: 7, name: "Synth MIDI", mute: 0, has_midi_input: 1 },
			{ id: 8, name: "SP Tail", mute: 0, has_midi_input: 0 }
		];
		// mixer: volume and pan parameters per track
		this.objs = {};
		for (const t of this.tracks) {
			const md = 2000 + t.id, vol = 3000 + t.id, pan = 4000 + t.id;
			t.mixer_device = ["id", md];
			this.objs[md] = { volume: ["id", vol], panning: ["id", pan] };
			this.objs[vol] = { value: 0.85, automation_state: 0, kind: "volume" };
			this.objs[pan] = { value: 0, automation_state: 0, kind: "pan" };
		}
		this.clips = [
			{ id: 501, track: 5, start_time: 0, pitch_coarse: 0, warp_mode: 0, warping: 1, is_audio_clip: 1 },
			{ id: 502, track: 5, start_time: 256, pitch_coarse: 0, warp_mode: 0, warping: 1, is_audio_clip: 1 },
			{ id: 301, track: 3, start_time: 0, pitch_coarse: 0, warp_mode: 0, warping: 1, is_audio_clip: 1 },
			{ id: 201, track: 2, start_time: 0, pitch_coarse: 0, warp_mode: 0, warping: 1, is_audio_clip: 1 },
			{ id: 701, track: 7, start_time: 0, is_audio_clip: 0 }
		];
		this.objs[3999] = { value: 0.85, automation_state: 0, kind: "volume" };   // main volume
		this.objs[1999] = { output_meter_level: 0.3 };                            // main track
		this.routeTypes = [{ display_name: "Ext. Out", identifier: 18 }, { display_name: "Main", identifier: 19 }, { display_name: "Band Bus", identifier: 40 }];
		this.extChans = [{ display_name: "1/2", identifier: 50 }, { display_name: "3/4", identifier: 53 }, { display_name: "5/6", identifier: 55 }];
		for (const t of this.tracks) { t.routeType = 19; t.routeChan = 17; }
		for (const t of this.tracks) Object.assign(t, { color: 0xff6600, solo: 0, is_foldable: 0, is_grouped: 0, output_meter_level: 0.5 });
		for (const c of this.clips) Object.assign(c, { end_time: c.start_time + 232, file_path: "/sim/" + c.track + ".wav", start_marker: 0,
			gain_display_string: "0.0 dB", looping: 0, loop_start: 0, loop_end: 232, muted: 0,
			warp_markers: JSON.stringify({ warp_markers: [{ sample_time: 0, beat_time: 0 }, { sample_time: 0.025, beat_time: 0.03125 }] }) }, c);
		for (const t of this.tracks) t.arrangement_clips = this.clips.filter(c => c.track === t.id).flatMap(c => ["id", c.id]);
		this.ownTrack = 4;      // SetPilot (cues) on its own track
		this.gateDevice = 2;    // SetPilot Guide on the Guide track (0 = absent)
		this.clickDevice = 6;   // SetPilot Click on its own track (0 = absent)
		this.tailDevice = 0;    // SetPilot Tail (8 to add it)
		this.tailLog = [];
		this.clickParams = {};
		this.reply = [];
		this.audio = { cueArm: null, cueIdx: 0, gateArm: null, gateVal: 0, gate: 1, played: [], preload: {}, gateLog: [] };
		for (const [name, time] of cues) this.addCue(name, time);
	}
	addCue(name, time) {
		this.cues.push({ id: this.nextId++, name, time });
		const last = Math.max(...this.cues.map(c => c.time));
		this.props.last_event_time = last;
		this.props.song_length = last + 16;
		this.emit("cue_points");
	}
	cue(id) { return this.cues.find(c => c.id == id); }
	barLen() { return this.props.signature_numerator * 4 / this.props.signature_denominator; }
	set(p, v) {
		v = Number(v);
		if (p === "tempo") this.tempoOverride = true;
		if (p === "current_song_time" && this.props.is_playing) {
			this.log.push(`seek ${v}`);
			// real Live applies a seek while playing a few ticks later
			if (this.seekLatency) { this.pendingSeek = { v, left: this.seekLatency }; return; }
		}
		this.props[p] = v;
		this.emit(p);
	}
	emit(p) { for (const l of this.listeners) if (l.prop === p) l.fire(); }
	messnamed(name, args) {
		const [m, ...r] = args;
		if (name === "setpilot_gate") {
			if (m === "ping") { if (this.gateDevice) this.reply.push(["gatehello", "id", this.gateDevice]); }
			else if (this.gateDevice) this.audioMsg([m, ...r]);
		} else if (name === "setpilot_tail") {
			if (m === "ping") { if (this.tailDevice) this.reply.push(["tailhello", "id", this.tailDevice]); }
			else this.tailLog.push([m, ...r, this.props.current_song_time]);
		} else if (name === "setpilot_click") {
			if (m === "ping") { if (this.clickDevice) this.reply.push(["clickhello", "id", this.clickDevice]); }
			else if (m === "param") this.clickParams[r[0]] = Number(r[1]);
		}
	}
	call(fn, ...args) {
		if (fn === "create_audio_track") {
			const id = 1000 + this.tracks.length;
			this.tracks.push({ id, name: "Audio", mute: 0, has_midi_input: 0, arrangement_clips: [] });
			return;
		}
		if (fn === "set_or_delete_cue") {
			const t = this.props.current_song_time;
			const i = this.cues.findIndex(c => Math.abs(c.time - t) < 0.001);
			if (i >= 0) this.cues.splice(i, 1); else this.addCue("", t);
			return;
		}
		if (fn === "re_enable_automation") { this.log.push("re_enable_automation"); this.tempoOverride = false; return; }
		if (fn === "start_playing" || fn === "continue_playing") {
			if (this.selectionStart != null) this.props.current_song_time = this.selectionStart;
			// real Live may confirm is_playing a few ticks later
			if (this.playLatency) this.pendingPlay = this.playLatency; else this.set("is_playing", 1);
		}
		else if (fn === "stop_playing") { this.set("is_playing", 0); this.pendingJump = null; }
	}
	jumpTo(time) {
		if (!this.props.is_playing) { this.props.current_song_time = time; return; }
		const q = this.props.clip_trigger_quantization;
		const bars = { 1: 8, 2: 4, 3: 2, 4: 1 }[q];
		if (!bars) { this.props.current_song_time = time; this.log.push(`jump now ${time}`); return; }
		const span = bars * this.barLen();
		const at = Math.floor(this.props.current_song_time / span + 1e-9) * span + span;
		this.pendingJump = { at, time };
	}
	songTempo(t) {
		let bpm = 0;
		for (const c of this.cues) {
			if (c.time > t + 1e-9) break;
			const m = c.name.match(/^#.*?\|\s*(\d+)/);
			if (m) bpm = Number(m[1]);
		}
		return bpm;
	}
	advance(ms) {
		const p = this.props;
		if (this.pendingPlay != null) { if ((this.pendingPlay -= ms) <= 0) { this.pendingPlay = null; this.set("is_playing", 1); } return; }
		if (!p.is_playing) return;
		if (this.pendingSeek && (this.pendingSeek.left -= ms) <= 0) { p.current_song_time = this.pendingSeek.v; this.pendingSeek = null; this.emit("current_song_time"); }
		let t = p.current_song_time;
		const bpm = this.songTempo(t);
		if (bpm && bpm !== p.tempo && !this.tempoOverride) { p.tempo = bpm; this.emit("tempo"); }
		const dt = (ms / 1000) * (p.tempo / 60);
		let nt = t + dt;
		if (this.pendingJump && nt >= this.pendingJump.at - 1e-9) {
			this.log.push(`jump ${this.pendingJump.at} -> ${this.pendingJump.time}`);
			nt = this.pendingJump.time + (nt - this.pendingJump.at);
			this.pendingJump = null;
		} else if (p.loop) {
			const end = p.loop_start + p.loop_length;
			if (t < end - 1e-9 && nt >= end - 1e-9 && t >= p.loop_start - 1e-9) {
				this.log.push(`loop ${end} -> ${p.loop_start}`);
				nt = p.loop_start + (nt - end);
			}
		}
		p.current_song_time = nt;
		const a = this.audio;
		const cross = (at) => at != null && t < at - 1e-9 && nt >= at - 1e-9;
		if (cross(a.gateArm)) { a.gate = a.gateVal; a.gateLog.push(["tp", a.gateArm, a.gateVal]); }
		if (cross(a.cueArm)) { a.played.push([a.cueIdx, a.cueArm]); this.onCueFired && this.onCueFired(a.cueIdx); }
	}
	fromBBU(b, bb, u) {
		if (b >= 9999) return null;
		const bl = this.barLen(), beatLen = 4 / this.props.signature_denominator;
		return (b - 1) * bl + (bb - 1) * beatLen + u / 480;
	}
	audioMsg(args) {
		const a = this.audio, [m, ...r] = args;
		if (m === "cuearm") a.cueArm = this.fromBBU(...r.map(Number));
		else if (m === "gatearm") a.gateArm = this.fromBBU(...r.map(Number));
		else if (m === "cueidx") a.cueIdx = Number(r[0]);
		else if (m === "gateval") a.gateVal = Number(r[0]);
		else if (m === "gatenow") { a.gate = Number(r[0]); a.gateLog.push(["now", this.props.current_song_time, a.gate]); }
		else if (m === "play") a.played.push([Number(r[0]), this.props.current_song_time, "now"]);
		else if (m === "preload") a.preload[r[0]] = r[1];
	}
}

// Max's LiveAPI talking straight to the fake song (no bridge in between)
function makeDirectLiveAPI(song) {
	class LiveAPI {
		constructor(cb, p) {
			this.cb = cb; this._id = 1; this.target = "song"; this._prop = null;
			if (p === "this_device canonical_parent") { this._id = song.ownTrack; this.target = "obj"; }
		}
		goto(p) {
			if (p === "live_set master_track mixer_device volume") { this._id = 3999; this.target = "obj"; }
			else if (p === "live_set master_track") { this._id = 1999; this.target = "obj"; }
			else throw new Error("unknown path " + p);
		}
		// like Max: reading the id gives a string, and assigning a string back does
		// nothing (the object keeps pointing where it was); ids must go in as numbers
		get id() { return String(this._id); }
		set id(v) { if (typeof v === "string") return; this._id = Number(v); this.target = "obj"; }
		set property(p) {
			this._prop = p;
			const self = this;
			const l = { prop: p, fire() { self.cb && self.cb([p, ...[].concat(self.get(p))]); } };
			song.listeners.push(l);
			l.fire();
		}
		get(p) {
			if (this.target === "obj") {
				const tr = song.tracks.find(x => x.id == this._id);
				if (tr && p === "available_output_routing_types") return [JSON.stringify({ available_output_routing_types: song.routeTypes })];
				if (tr && p === "available_output_routing_channels") return [JSON.stringify({ available_output_routing_channels: tr.routeType === 18 ? song.extChans : [{ display_name: "", identifier: 17 }] })];
				if (tr && p === "output_routing_type") return [JSON.stringify({ output_routing_type: song.routeTypes.find(x => x.identifier === tr.routeType) })];
				if (tr && p === "output_routing_channel") {
					const ch = tr.routeType === 18 ? song.extChans.find(x => x.identifier === tr.routeChan) : { display_name: "", identifier: 17 };
					return [JSON.stringify({ output_routing_channel: ch })];
				}
				const o = song.cue(this._id) || song.tracks.find(x => x.id == this._id) || song.clips.find(x => x.id == this._id) || song.objs[this._id];
				return o ? (Array.isArray(o[p]) ? o[p] : [o[p]]) : [0];
			}
			if (p === "cue_points") return song.cues.flatMap(c => ["id", c.id]);
			if (p === "tracks") return song.tracks.flatMap(c => ["id", c.id]);
			return [song.props[p]];
		}
		set(p, v) {
			if (this.target === "obj") {
				const tr = song.tracks.find(x => x.id == this._id);
				if (tr && p === "output_routing_type") { tr.routeType = v.identifier; tr.routeChan = v.identifier === 18 ? 50 : 17; return; }
				if (tr && p === "output_routing_channel") { tr.routeChan = v.identifier; return; }
				const o = song.tracks.find(x => x.id == this._id) || song.clips.find(x => x.id == this._id) || song.cue(this._id) || song.objs[this._id];
				if (o) o[p] = p === "name" ? String(v) : Number(v);
				return;
			}
			song.set(p, v);
		}
		call(fn, ...args) {
			if (this.target === "obj" && fn === "create_audio_clip") {
				const tr = song.tracks.find(x => x.id == this._id);
				const id = 9000 + song.clips.length;
				// like Live's auto-warp: its own tempo guess (84.51) and a downbeat moved to 2.37 s
				const wm = [];
				for (let b = 0; b <= 160; b += 4) wm.push({ beat_time: b, sample_time: 2.37 + b * 60 / 84.51 });
				song.clips.push({ id, track: tr.id, start_time: Number(args[1]), end_time: Number(args[1]) + 160, file: args[0], file_path: args[0], sample_rate: 44100, sample_length: Math.round(44100 * 140 * 60 / 86), looping: 0, loop_end: 160, pitch_coarse: 0, warp_mode: 0, warping: 1, is_audio_clip: 1,
					start_marker: 0, end_marker: 160, warp_markers: JSON.stringify({ warp_markers: wm }) });
				tr.arrangement_clips = song.clips.filter(c => c.track === tr.id).flatMap(c => ["id", c.id]);
				song.props.last_event_time = Math.max(song.props.last_event_time, Number(args[1]) + 400);
				return;
			}
			if (this.target === "obj" && fn === "add_warp_marker") {
				// Live 12: one dict argument { beat_time, sample_time }
				const c = song.clips.find(x => x.id == this._id);
				const a = args[0];
				if (!a || typeof a !== "object") return;
				const o = JSON.parse(c.warp_markers);
				let list = o.warp_markers;
				// the 1/32 beat helper goes away once a second real marker exists
				if (list.length === 2 && list[1].beat_time - list[0].beat_time < 0.1) list = [list[0]];
				list.push({ beat_time: Number(a.beat_time), sample_time: Number(a.sample_time) });
				list.sort((p, q) => p.beat_time - q.beat_time);
				o.warp_markers = list;
				c.warp_markers = JSON.stringify(o);
				return;
			}
			if (this.target === "obj" && fn === "remove_warp_marker") {
				const c = song.clips.find(x => x.id == this._id);
				const o = JSON.parse(c.warp_markers);
				const i = o.warp_markers.findIndex(x => Math.abs(x.beat_time - Number(args[0])) < 1e-6);
				if (i > 0 && i < o.warp_markers.length - 1) o.warp_markers.splice(i, 1);
				c.warp_markers = JSON.stringify(o);
				return;
			}
			if (this.target === "obj" && fn === "move_warp_marker") {
				const c = song.clips.find(x => x.id == this._id);
				const o = JSON.parse(c.warp_markers);
				const m = o.warp_markers.find(x => Math.abs(x.beat_time - Number(args[0])) < 1e-6);
				if (!m) throw new Error("no marker at " + args[0]);
				const nb = m.beat_time + Number(args[1]);
				const i = o.warp_markers.indexOf(m);
				const prev = o.warp_markers[i - 1], next = o.warp_markers[i + 1];
				if ((prev && nb <= prev.beat_time) || (next && nb >= next.beat_time)) throw new Error("marker would cross another");
				m.beat_time = nb;
				c.warp_markers = JSON.stringify(o);
				return;
			}
			if (this.target === "obj" && fn === "str_for_value") {
				const v = Number(args[0]);
				return v <= 0 ? "-inf dB" : ((v - 0.85) * 40).toFixed(1) + " dB";
			}
			if (this.target === "obj" && fn === "jump") { const c = song.cue(this._id); if (c) song.jumpTo(c.time); }
			else song.call(fn, ...args);
		}
	}
	return LiveAPI;
}

function loadEngine(song, { onOutlet, realtime = true, engineFile, liveApiFor, beforeTick } = {}) {
	const dicts = {};
	const tasks = [];
	const LiveAPI = liveApiFor ? liveApiFor(song) : makeDirectLiveAPI(song);
	class Task {
		constructor(fn, ctx) { this.fn = fn; this.ctx = ctx; this.interval = 20; this.h = null; }
		repeat() {
			tasks.push(this);
			if (realtime) this.h = setInterval(() => {
				song.advance(this.interval); beforeTick && beforeTick(); this.fn.call(this.ctx);
				while (song.reply.length) { const [m, ...a] = song.reply.shift(); ctx[m](...a); }
			}, this.interval);
		}
		cancel() { if (this.h) clearInterval(this.h); }
		schedule() { /* the simulator calls init() itself */ }
	}
	class Dict {
		constructor(name) { this.name = name; dicts[name] = dicts[name] || {}; }
		parse(json) { dicts[this.name] = JSON.parse(json); }
		get(k) { const v = dicts[this.name][k]; return v === undefined ? null : v; }
		set(k, v) { dicts[this.name][k] = v; }
		stringify() { return JSON.stringify(dicts[this.name]); }
	}
	const ctx = {
		LiveAPI, Task, Dict,
		post: s => process.env.SP_DEBUG && process.stdout.write("[max] " + s),
		outlet: (n, ...args) => {
			const flat = [].concat(...args);
			if (n === 1) song.audioMsg(flat);
			else if (onOutlet) onOutlet(flat);
		},
		arrayfromargs: a => Array.prototype.slice.call(a),
		messagename: "", autowatch: 0, inlets: 1, outlets: 1,
		messnamed: (name, ...args) => song.messnamed(name, [].concat(...args)),
		Math, JSON, parseInt, parseFloat, isNaN, String, Array
	};
	vm.createContext(ctx);
	const file = engineFile || path.join(__dirname, "..", "core", "setpilot_engine.js");
	vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
	ctx.init();
	song.onCueFired = idx => { ctx.cuefired(idx); };
	return {
		ctx, dicts,
		send(cmd, args) {
			if (typeof ctx[cmd] !== "function") return;
			ctx.messagename = cmd;
			ctx[cmd](...(args || []));
		},
		step(ms) {
			for (const tk of tasks) { song.advance(ms); beforeTick && beforeTick(); tk.fn.call(tk.ctx); }
			while (song.reply.length) { const [m, ...a] = song.reply.shift(); ctx[m](...a); }
		}
	};
}

module.exports = { FakeSong, loadEngine, makeDirectLiveAPI, DEMO_CUES };
