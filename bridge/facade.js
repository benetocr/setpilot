// Max's LiveAPI object, rebuilt on top of the mirror, so the engine written
// for Max for Live runs unchanged in Node. It keeps Max's behavior on
// purpose, quirks included: get() always returns a list, objects come back as
// "id", n pairs, routing and warp markers come back as JSON text, and reading
// .id gives a string that cannot be assigned back.

const { SPEC } = require("./mirror");

const LISTS = new Set(SPEC.lists);
const ROUTING = new Set(SPEC.routing);
const ASYNC = new Set(SPEC.async_calls);
const isRef = v => v && typeof v === "object" && !Array.isArray(v) && "$" in v;

function toMax(v, p) {
	if (v === undefined || v === null) return [0];
	if (ROUTING.has(p)) return [JSON.stringify({ [p]: v })];
	if (p === "warp_markers") return [JSON.stringify({ warp_markers: v || [] })];
	if (isRef(v)) return ["id", v.$];
	if (Array.isArray(v)) {
		if (LISTS.has(p) || v.every(isRef)) return v.flatMap(x => (isRef(x) ? ["id", x.$] : [x]));
		return v;
	}
	if (typeof v === "boolean") return [v ? 1 : 0];
	return [v];
}

// Max lets you pass objects as "id", n; the wire wants {"$": n}
function argsToWire(args) {
	const out = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "id" && i + 1 < args.length && !isNaN(Number(args[i + 1]))) { out.push({ $: Number(args[i + 1]) }); i++; }
		else out.push(args[i]);
	}
	return out;
}

function parseDb(s) {
	s = String(s);
	if (/-inf/i.test(s)) return -Infinity;
	if (!/dB/i.test(s)) return null;
	const m = s.match(/-?\d+(\.\d+)?/);
	return m ? parseFloat(m[0]) : null;
}

function makeLiveAPI(mirror, { ownTrack } = {}) {
	function resolve(path) {
		const parts = String(path || "").trim().split(/\s+/);
		let id = 0, i = 0;
		if (parts[0] === "live_set") { id = mirror.roots.song || 0; i = 1; }
		else if (parts[0] === "live_app" && parts[1] === "view") { id = mirror.roots.app_view || 0; i = 2; }
		else if (parts[0] === "live_app") { id = mirror.roots.app || 0; i = 1; }
		else if (parts[0] === "this_device" && parts[1] === "canonical_parent") { return ownTrack ? ownTrack(mirror) || 0 : 0; }
		else if (parts[0] === "id") return Number(parts[1]) || 0;
		else return 0;
		for (; i < parts.length && id; i++) {
			if (parts[i] === "view" && id === mirror.roots.app) { id = mirror.roots.app_view || 0; continue; }
			let v = mirror.get(id, parts[i]);
			if (Array.isArray(v)) { const n = Number(parts[++i]); v = v[n]; }
			id = isRef(v) ? v.$ : 0;
		}
		return id;
	}

	// Live's text for a parameter value ("-3.2 dB"). Asking Live each time would
	// cost a round trip per fader move; instead we ask once per parameter for
	// its curve and read values off it.
	const curves = new Map();
	function strForValue(id, v) {
		let c = curves.get(id);
		if (!c) {
			const list = mirror.call(id, "str_table", [201], { sync: true }) || [];
			c = list.map((s, i) => ({ x: i / (list.length - 1), s: String(s), db: parseDb(s) }));
			curves.set(id, c);
		}
		if (!c.length) return "";
		const x = Math.max(0, Math.min(1, v));
		const i = Math.min(c.length - 2, Math.floor(x * (c.length - 1)));
		const a = c[i], b = c[i + 1];
		if (Math.abs(x - a.x) < 1e-9) return a.s;
		if (Math.abs(x - b.x) < 1e-9) return b.s;
		if (a.db == null || b.db == null || !isFinite(a.db) || !isFinite(b.db)) return (x - a.x < b.x - x ? a : b).s;
		const db = a.db + (b.db - a.db) * (x - a.x) / (b.x - a.x);
		return db.toFixed(1) + " dB";
	}

	class LiveAPI {
		constructor(cb, path) {
			this.cb = cb;
			this._id = path ? resolve(path) : 0;
			this._prop = null;
			this._off = null;
		}
		goto(path) { this._id = resolve(path); }
		get id() { return String(this._id); }
		set id(v) { if (typeof v === "string") return; this._id = Number(v) || 0; }
		get path() { return ""; }
		set property(p) {
			if (this._off) this._off();
			this._prop = p;
			const id = this._id;
			const fire = () => { if (this.cb) this.cb([p].concat(this.get(p))); };
			this._off = mirror.listen(id, p, fire);
			fire();
		}
		get(p) {
			if (!this._id) return [0];
			return toMax(mirror.get(this._id, p), p);
		}
		set(p, v) {
			if (!this._id) return;
			if (Array.isArray(v) && v.length === 1) v = v[0];
			mirror.set(this._id, p, v);
		}
		call(fn, ...args) {
			if (!this._id) return undefined;
			if (fn === "str_for_value") return strForValue(this._id, Number(args[0]));
			const r = mirror.call(this._id, fn, argsToWire(args), { sync: !ASYNC.has(fn) });
			return r === undefined ? undefined : toMax(r, fn)[0];
		}
	}
	return LiveAPI;
}

module.exports = { makeLiveAPI, toMax, argsToWire };
