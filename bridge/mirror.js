// A live copy of the parts of Live's state the engine reads, kept in sync by
// the SetPilot Remote Script. Reads are instant (no round trip to Live);
// writes go out right away and show locally at once.
//
// Wire values: numbers, strings, null, arrays, and object references
// written as {"$": id}. See docs/bridge-protocol.md.

const SPEC = require("../live/SetPilot/spec.json");

const key = (id, p) => id + "|" + p;
const same = (a, b) => a === b || (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

class Mirror {
	// send(msg): fire and forget to the script
	// request(msg): synchronous round trip, returns the "res" message; every
	//   message the script sent before it has been applied by then
	// now(): milliseconds, used to move the song position between reports
	constructor({ send, request, now } = {}) {
		this.send = send || (() => {});
		this.request = request || null;
		this.now = now || (() => Number(process.hrtime.bigint() / 1000000n));
		this.reset();
	}

	reset() {
		this.objs = new Map();      // id -> { k: kind, p: { prop: value } }
		this.roots = {};            // song, app_view, ...
		this.listeners = new Map(); // "id|prop" -> Set(fn)
		this.pending = new Map();   // "id|prop" -> write number not yet applied by Live
		this.stale = new Set();     // "id|prop" to read from Live again before trusting the copy
		this.w = 0;
		this.q = 0;
		this.ready = false;
		this.info = null;
		this.clock = { s: 0, at: 0, last: 0 };
		this.stats = { msgs: 0, deltas: 0, times: 0, syncCalls: 0, syncMs: 0, lazyGets: 0 };
	}

	// ------------------------------------------------------------ incoming
	receive(msg) {
		this.stats.msgs++;
		switch (msg.t) {
			case "hello": this.info = msg; break;
			case "snap": this.applySnap(msg); break;
			case "d": this.applyDelta(msg); break;
			case "time": this.applyTime(msg); break;
			case "bye": this.ready = false; break;
		}
	}

	applySnap(msg) {
		const keepListeners = this.listeners;
		this.objs = new Map();
		for (const id in msg.o) this.objs.set(Number(id), { k: msg.o[id].k, p: msg.o[id].p || {} });
		this.roots = msg.roots || {};
		this.pending.clear();
		this.listeners = keepListeners;
		const song = this.objs.get(this.roots.song);
		this.clock = { s: song ? Number(song.p.current_song_time) || 0 : 0, at: this.now(), last: 0 };
		this.ready = true;
		// everything may have changed: tell whoever listens
		for (const [k, set] of this.listeners) {
			const [id, p] = k.split("|");
			for (const fn of set) fn(this.get(Number(id), p));
		}
	}

	applyDelta(msg) {
		this.stats.deltas++;
		const aw = msg.aw || 0;
		for (const [k, w] of this.pending) if (w <= aw) this.pending.delete(k);
		if (msg.o) for (const sid in msg.o) {
			const id = Number(sid), d = msg.o[sid];
			let o = this.objs.get(id);
			if (!o) { o = { k: d.k || "?", p: {} }; this.objs.set(id, o); }
			if (d.k) o.k = d.k;
			for (const p in d.p) {
				const kk = key(id, p);
				if (this.pending.has(kk)) continue;    // our newer write wins until Live confirms it
				const v = d.p[p];
				if (p === "current_song_time" && id === this.roots.song) { this.setClock(Number(v)); continue; }
				const old = o.p[p];
				o.p[p] = v;
				if (!same(old, v)) this.fire(id, p);
			}
		}
		if (msg.gone) for (const id of msg.gone) this.objs.delete(Number(id));
	}

	applyTime(msg) {
		this.stats.times++;
		const song = this.objs.get(this.roots.song);
		if (!song) return;
		if (msg.aw) for (const [k, w] of this.pending) if (w <= msg.aw) this.pending.delete(k);
		if (msg.p != null && song.p.is_playing !== msg.p && !this.pending.has(key(this.roots.song, "is_playing"))) {
			song.p.is_playing = msg.p;
			this.fire(this.roots.song, "is_playing");
		}
		if (msg.tempo != null && song.p.tempo !== msg.tempo) { song.p.tempo = msg.tempo; this.fire(this.roots.song, "tempo"); }
		if (this.pending.has(key(this.roots.song, "current_song_time"))) return;
		this.setClock(Number(msg.s));
	}

	setClock(s) {
		const now = this.now();
		const song = this.objs.get(this.roots.song);
		if (song) song.p.current_song_time = s;
		// Reports arrive with a little jitter. While playing, never step back by
		// less than ~60 ms: that is jitter, not a jump, and the engine looks for
		// boundary crossings, so a tiny step back could fire something twice.
		if (song && song.p.is_playing) {
			const guess = this.songTime();
			const beat = (song.p.tempo || 120) / 60;
			if (s < guess && guess - s < 0.06 * beat) { this.clock = { s: guess, at: now, last: guess }; return; }
		}
		this.clock = { s, at: now, last: s };
	}

	songTime() {
		const song = this.objs.get(this.roots.song);
		if (!song) return 0;
		if (!song.p.is_playing) return this.clock.s;
		const dt = Math.min(this.now() - this.clock.at, 250);   // Live stopped talking: do not run away
		const t = this.clock.s + dt / 1000 * (song.p.tempo || 120) / 60;
		this.clock.last = Math.max(this.clock.last, t);
		return this.clock.last;
	}

	fire(id, p) {
		const set = this.listeners.get(key(id, p));
		if (!set) return;
		const v = this.get(id, p);
		for (const fn of set) fn(v);
	}

	// ------------------------------------------------------------ reads
	kindOf(id) { const o = this.objs.get(Number(id)); return o ? o.k : null; }
	has(id) { return this.objs.has(Number(id)); }

	get(id, p) {
		id = Number(id);
		if (id === this.roots.song && p === "current_song_time") return this.songTime();
		const o = this.objs.get(id);
		if (!o) return undefined;
		if (p in o.p && !this.stale.has(key(id, p))) return o.p[p];
		if (this.stale.has(key(id, p)) && this.request) {
			// right after we changed it: ask Live for the value as it is now
			this.stale.delete(key(id, p));
			const r = this.request({ t: "get", id, p });
			if (r && r.ok) o.p[p] = r.v;
			return o.p[p];
		}
		// not mirrored yet: ask Live once, then keep it updated
		if (!this.request) return undefined;
		this.stats.lazyGets++;
		const r = this.request({ t: "get", id, p, watch: 1 });
		const v = r && r.ok ? r.v : null;
		o.p[p] = v;
		return v;
	}

	// ------------------------------------------------------------ writes
	set(id, p, v) {
		id = Number(id);
		const o = this.objs.get(id);
		const w = ++this.w;
		if (SPEC.routing.includes(p) && this.request) {
			// what a route becomes (and which channels it then offers) is up to
			// Live, and the engine reads it right back: wait for Live
			const r = this.request({ t: "set", w, id, p, v });
			if (!r || !r.ok) throw new Error((r && r.err) || "set failed: " + p);
			return;
		}
		this.pending.set(key(id, p), w);
		if (p === "warping" || p === "warp_mode" || p === "start_marker" || p === "end_marker") this.stale.add(key(id, "warp_markers"));
		this.send({ t: "set", w, id, p, v });
		if (!o) return;
		if (id === this.roots.song && p === "current_song_time") { this.clock = { s: Number(v), at: this.now(), last: Number(v) }; o.p[p] = Number(v); return; }
		const old = o.p[p];
		o.p[p] = v;
		if (!same(old, v)) this.fire(id, p);
	}

	call(id, fn, args, { sync } = {}) {
		id = Number(id);
		if (/warp_marker/.test(fn)) this.stale.add(key(id, "warp_markers"));
		const w = ++this.w;
		if (!sync || !this.request) { this.send({ t: "call", w, id, f: fn, a: args || [] }); return undefined; }
		const t0 = this.now();
		const r = this.request({ t: "call", w, id, f: fn, a: args || [] });
		this.stats.syncCalls++;
		this.stats.syncMs += this.now() - t0;
		if (!r || !r.ok) throw new Error((r && r.err) || ("call failed: " + fn));
		return r.v;
	}

	// ------------------------------------------------------------ listeners
	listen(id, p, fn) {
		const k = key(Number(id), p);
		if (!this.listeners.has(k)) this.listeners.set(k, new Set());
		this.listeners.get(k).add(fn);
		return () => this.listeners.get(k) && this.listeners.get(k).delete(fn);
	}
}

module.exports = { Mirror, SPEC };
