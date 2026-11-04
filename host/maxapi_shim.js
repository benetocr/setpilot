// Stands in for Max's "max-api" module, so core/setpilot_server.js runs in
// the app exactly as it runs inside Max for Live. Its outlets and dicts are
// wired by host/main.js to the engine thread.

const { EventEmitter } = require("events");

const bus = new EventEmitter();
const handlers = new Map();
const ALL = "__all__";
let allHandler = null;

const api = {
	MESSAGE_TYPES: { ALL, BANG: "bang", DICT: "dict", LIST: "list", NUMBER: "number" },
	POST_LEVELS: { ERROR: "error", INFO: "info", WARN: "warn" },
	addHandler(name, fn) { if (name === ALL) allHandler = fn; else handlers.set(name, fn); },
	removeHandler(name) { if (name === ALL) allHandler = null; else handlers.delete(name); },
	outlet(...args) { bus.emit("outlet", args); return Promise.resolve(); },
	post(...args) { bus.emit("post", args.join(" ")); return Promise.resolve(); },
	getDict(name) { return new Promise((resolve, reject) => bus.emit("getDict", name, v => (v ? resolve(v) : reject(new Error("no dict " + name))))); },
	setDict(name, value) { bus.emit("setDict", name, value); return Promise.resolve(value); },
	updateDict(name, path, value) { return Promise.reject(new Error("updateDict not supported")); },

	// a message from the engine, like Max's [route] in front of node.script
	_dispatch(args) {
		const [name, ...rest] = args;
		const h = handlers.get(name);
		if (h) {
			try { const r = h(...rest); if (r && r.catch) r.catch(e => bus.emit("post", "handler " + name + ": " + e.message)); }
			catch (e) { bus.emit("post", "handler " + name + ": " + e.message); }
		}
		if (allHandler) allHandler(!!h, ...args);
	},
	_bus: bus
};

module.exports = api;
