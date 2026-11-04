// Runs core/setpilot_engine.js (written for Max's JavaScript object) in a
// plain Node VM, giving it the few Max globals it uses: LiveAPI, Task,
// Dict, outlet, messnamed and post.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ENGINE = path.join(__dirname, "..", "core", "setpilot_engine.js");

function loadEngine({ LiveAPI, onOutlet, onMessnamed, onPost, tickMs = 20, engineFile = ENGINE }) {
	const dicts = {};
	const tasks = [];

	class Task {
		constructor(fn, ctx) { this.fn = fn; this.ctx = ctx; this.interval = tickMs; this.h = null; }
		repeat() {
			this.cancel();
			tasks.push(this);
			// a self-correcting timer: keeps the average period on time even when
			// a tick runs late, without bursts of catch-up ticks
			let next = Date.now() + this.interval;
			const run = () => {
				try { this.fn.call(this.ctx); } catch (e) { onPost && onPost("tick error: " + e.message); }
				next += this.interval;
				const now = Date.now();
				if (next < now - this.interval * 3) next = now;    // fell far behind: start over
				this.h = setTimeout(run, Math.max(0, next - now));
			};
			this.h = setTimeout(run, this.interval);
		}
		cancel() { if (this.h) clearTimeout(this.h); this.h = null; }
		schedule(ms) { setTimeout(() => this.fn.call(this.ctx), ms || 0); }
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
		post: s => onPost && onPost(String(s).replace(/\n$/, "")),
		outlet: (n, ...args) => onOutlet && onOutlet(n, [].concat(...args)),
		messnamed: (name, ...args) => onMessnamed && onMessnamed(name, [].concat(...args)),
		arrayfromargs: a => Array.prototype.slice.call(a),
		messagename: "", autowatch: 0, inlets: 1, outlets: 2,
		Math, JSON, parseInt, parseFloat, isNaN, String, Array
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(engineFile, "utf8"), ctx, { filename: engineFile });

	return {
		ctx, dicts,
		init() { ctx.init(); },
		send(cmd, args) {
			if (typeof ctx[cmd] !== "function") return false;
			ctx.messagename = cmd;
			ctx[cmd](...(args || []));
			return true;
		},
		stop() { for (const t of tasks) t.cancel(); }
	};
}

module.exports = { loadEngine };
