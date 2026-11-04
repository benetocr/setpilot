// The SetPilot Remote Script's behavior, played against the fake song: it
// answers the same protocol the Python script speaks (snapshot, deltas,
// time, set/call/get), so the engine can be tested through the real mirror
// and LiveAPI facade without Live.

const { makeDirectLiveAPI } = require("./fake_live");
const { SPEC } = require("../bridge/mirror");

const SONG = 900001, APP = 900002, APP_VIEW = 900003, MASTER_MIXER = 2999;
const LISTS = new Set(SPEC.lists), ROUTING = new Set(SPEC.routing);
const REFS = new Set(["mixer_device", "volume", "panning", "master_track"]);

class FakeScript {
	constructor(song, { writeDelay = 0 } = {}) {
		this.song = song;
		this.LiveAPI = makeDirectLiveAPI(song);
		this.sent = new Map();     // id -> { k, p } last values sent
		this.aw = 0;
		this.writeDelay = writeDelay;  // flushes a write waits before Live applies it
		this.queue = [];
		this.lastTime = null;
		this.log = [];
	}

	api(id) {
		const a = new this.LiveAPI(null, "live_set");
		if (id !== SONG) a.id = Number(id);
		return a;
	}

	kindOf(id) {
		const s = this.song;
		if (id === SONG) return "song";
		if (id === APP_VIEW) return "view";
		if (id === MASTER_MIXER) return "mixer";
		if (id === 1999 || s.tracks.some(t => t.id === id)) return "track";
		if (s.clips.some(c => c.id === id)) return "clip";
		if (s.cues.some(c => c.id === id)) return "cue";
		const o = s.objs[id];
		if (o && "volume" in o) return "mixer";
		if (o && "value" in o) return "param";
		return null;
	}

	read(id, p) {
		const s = this.song;
		if (id === SONG) {
			if (p === "master_track") return { $: 1999 };
			if (p === "cue_points") return s.cues.map(c => ({ $: c.id }));
			if (p === "tracks") return s.tracks.map(t => ({ $: t.id }));
			return s.props[p] === undefined ? null : s.props[p];
		}
		if (id === 1999) {
			if (p === "mixer_device") return { $: MASTER_MIXER };
			if (p === "output_meter_level") return s.objs[1999].output_meter_level;
			if (p === "name") return "Main";
			return null;
		}
		if (id === MASTER_MIXER) return p === "volume" ? { $: 3999 } : null;
		const raw = this.api(id).get(p);
		return fromMax(raw, p);
	}

	// every object reachable from the song, like the Python script's registry
	walk() {
		const s = this.song, ids = [SONG, APP_VIEW, 1999, MASTER_MIXER, 3999];
		for (const c of s.cues) ids.push(c.id);
		for (const t of s.tracks) {
			ids.push(t.id);
			const md = t.mixer_device && t.mixer_device[1];
			if (md) { ids.push(md); const o = s.objs[md]; if (o) ids.push(o.volume[1], o.panning[1]); }
			for (const c of s.clips) if (c.track === t.id) ids.push(c.id);
		}
		return ids;
	}

	state(id) {
		const k = this.kindOf(id);
		const p = {};
		for (const prop of SPEC.kinds[k] || []) {
			if (k === "song" && prop === "current_song_time") continue;   // goes in "time"
			if (k === "track" && id === 1999 && !["name", "output_meter_level", "mixer_device"].includes(prop)) continue;
			p[prop] = this.read(id, prop);
		}
		return { k, p };
	}

	snapshot() {
		this.sent = new Map();
		const o = {};
		for (const id of this.walk()) { const st = this.state(id); o[id] = st; this.sent.set(id, JSON.parse(JSON.stringify(st))); }
		o[SONG].p.current_song_time = this.song.props.current_song_time;
		this.lastTime = this.timeKey();
		return [
			{ t: "hello", v: SPEC.protocol, live: "fake", script: "fake" },
			{ t: "snap", roots: { song: SONG, app: APP, app_view: APP_VIEW }, o }
		];
	}

	timeKey() { const p = this.song.props; return [p.current_song_time, p.is_playing, p.tempo].join(","); }

	flush() {
		const out = [];
		// writes Live has not applied yet (see writeDelay)
		const due = this.queue.filter(q => --q.left <= 0);
		this.queue = this.queue.filter(q => q.left > 0);
		for (const q of due) this.apply(q.msg);
		const p = this.song.props;
		if (this.timeKey() !== this.lastTime) {
			this.lastTime = this.timeKey();
			out.push({ t: "time", s: p.current_song_time, p: p.is_playing, tempo: p.tempo, aw: this.aw });
		}
		const d = {}, seen = new Set();
		let any = false;
		for (const id of this.walk()) {
			seen.add(id);
			const st = this.state(id), prev = this.sent.get(id);
			const ch = {};
			let n = 0;
			for (const k in st.p) if (!prev || JSON.stringify(prev.p[k]) !== JSON.stringify(st.p[k])) { ch[k] = st.p[k]; n++; }
			if (n) { d[id] = prev ? { p: ch } : { k: st.k, p: ch }; any = true; this.sent.set(id, JSON.parse(JSON.stringify(st))); }
		}
		const gone = [...this.sent.keys()].filter(id => !seen.has(id));
		for (const id of gone) this.sent.delete(id);
		if (any || gone.length || due.length) out.push({ t: "d", aw: this.aw, o: d, gone: gone.length ? gone : undefined });
		return out;
	}

	// apply every write still waiting, now
	drain() { for (const q of this.queue) this.apply(q.msg); this.queue = []; }

	handle(msg) {
		if ((msg.t === "set" || msg.t === "call") && msg.q == null) {
			if (this.writeDelay) { this.queue.push({ msg, left: this.writeDelay }); return null; }
			this.apply(msg);
			return null;
		}
		// Live works through its queue in order: earlier writes land first
		for (const q of this.queue) this.apply(q.msg);
		this.queue = [];
		const res = { t: "res", q: msg.q, ok: true };
		try { res.v = this.apply(msg); }
		catch (e) { res.ok = false; res.err = e.message; }
		return res;
	}

	apply(msg) {
		try {
			if (msg.t === "set") {
				const a = this.api(msg.id);
				a.set(msg.p, msg.v);
				return null;
			}
			if (msg.t === "get") return this.read(msg.id, msg.p);
			if (msg.t === "call") {
				this.log.push(msg.f);
				const a = this.api(msg.id);
				if (msg.f === "str_table") {
					const n = Number(msg.a[0]) || 201, out = [];
					for (let i = 0; i < n; i++) out.push(a.call("str_for_value", i / (n - 1)));
					return out;
				}
				const args = msg.a.flatMap(x => (x && typeof x === "object" && "$" in x ? ["id", x.$] : [x]));
				const r = a.call(msg.f, ...args);
				return r === undefined ? null : r;
			}
		} finally {
			if (msg.w) this.aw = Math.max(this.aw, msg.w);
		}
		return null;
	}
}

function fromMax(raw, p) {
	if (ROUTING.has(p)) { try { return JSON.parse(raw[0])[p]; } catch (e) { return null; } }
	if (p === "warp_markers") { try { const o = JSON.parse(raw[0]); return o.warp_markers || o; } catch (e) { return []; } }
	if (LISTS.has(p)) { const out = []; for (let i = 0; i < raw.length; i++) if (raw[i] === "id") out.push({ $: Number(raw[++i]) }); return out; }
	if (REFS.has(p)) return raw && raw[0] === "id" ? { $: Number(raw[1]) } : null;
	if (!Array.isArray(raw)) return raw === undefined ? null : raw;
	return raw.length === 1 ? (raw[0] === undefined ? null : raw[0]) : raw;
}

// Script and mirror wired back to back in the same process, no socket.
function connectLoopback(script, mirror) {
	let q = 0;
	const pump = () => { for (const m of script.flush()) mirror.receive(m); };
	mirror.send = msg => { script.handle(msg); };
	mirror.request = msg => {
		pump();
		const r = script.handle(Object.assign({ q: ++q }, msg));
		pump();
		return r;
	};
	for (const m of script.snapshot()) mirror.receive(m);
	return { pump };
}

module.exports = { FakeScript, connectLoopback, SONG };
