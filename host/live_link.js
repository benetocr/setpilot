// The app's end of the bridge: finds the SetPilot Remote Script through the
// file it writes (~/.setpilot/bridge.json), connects, and reconnects on its
// own whenever Live restarts or loads another set. Nobody has to press
// anything.

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const DISCOVERY = path.join(os.homedir(), ".setpilot", "bridge.json");

class LiveLink extends EventEmitter {
	constructor({ discovery = DISCOVERY, doorbell = null, log = () => {} } = {}) {
		super();
		this.discovery = discovery;
		this.doorbell = doorbell;     // fn(): nudges Live to read our messages now
		this.log = log;
		this.sock = null;
		this.buf = "";
		this.state = "searching";     // searching | connecting | connected
		this.info = null;
		this.timer = null;
		this.closed = false;
		this.q = 0;
		this.waiting = new Map();
		this.rings = 0;
		this.ringPending = false;
	}

	start() { this.closed = false; this.tryConnect(); return this; }

	stop() {
		this.closed = true;
		clearTimeout(this.timer);
		if (this.sock) this.sock.destroy();
	}

	readDiscovery() {
		try {
			const d = JSON.parse(fs.readFileSync(this.discovery, "utf8"));
			if (d.pid && !alive(d.pid)) return null;   // Live closed without cleaning up
			return d;
		} catch (e) { return null; }
	}

	retry(ms) {
		if (this.closed) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.tryConnect(), ms);
	}

	setState(s, extra) {
		if (this.state === s) return;
		this.state = s;
		this.emit("state", s, extra);
	}

	tryConnect() {
		if (this.closed || this.sock) return;
		const d = this.readDiscovery();
		if (!d) { this.setState("searching"); return this.retry(1000); }
		this.setState("connecting");
		const sock = net.createConnection({ host: "127.0.0.1", port: d.port });
		this.sock = sock;
		sock.setNoDelay(true);
		sock.setEncoding("utf8");
		sock.on("connect", () => {
			this.info = d;
			sock.write(JSON.stringify({ t: "auth", token: d.token }) + "\n");
			this.ring();
		});
		sock.on("data", chunk => {
			this.buf += chunk;
			let i;
			while ((i = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, i);
				this.buf = this.buf.slice(i + 1);
				if (!line) continue;
				let msg;
				try { msg = JSON.parse(line); } catch (e) { continue; }
				if (msg.t === "hello") this.setState("connected", msg);
				if (msg.t === "res" && this.waiting.has(msg.q)) { const w = this.waiting.get(msg.q); this.waiting.delete(msg.q); w(msg); continue; }
				this.emit("message", msg);
			}
		});
		const gone = why => {
			if (this.sock !== sock) return;
			this.sock = null;
			this.buf = "";
			for (const w of this.waiting.values()) w({ ok: false, err: "disconnected" });
			this.waiting.clear();
			const was = this.state;
			this.setState("searching", why);
			if (was === "connected") this.emit("disconnected", why);
			this.retry(was === "connected" ? 300 : 1000);
		};
		sock.on("error", e => gone(e.code || e.message));
		sock.on("close", () => gone("closed"));
	}

	send(msg) {
		if (!this.sock || this.state !== "connected") return false;
		this.sock.write(JSON.stringify(msg) + "\n");
		this.ring();
		return true;
	}

	// one doorbell per burst of messages, sent once the burst is written
	ring() {
		if (!this.doorbell || this.ringPending) return;
		this.ringPending = true;
		setImmediate(() => { this.ringPending = false; this.rings++; try { this.doorbell(); } catch (e) { } });
	}

	// async round trip for the app's own use (probe, diagnostics)
	request(msg, timeout = 3000) {
		return new Promise(resolve => {
			const q = "h" + (++this.q);
			const t = setTimeout(() => { this.waiting.delete(q); resolve({ ok: false, err: "timeout" }); }, timeout);
			this.waiting.set(q, r => { clearTimeout(t); resolve(r); });
			if (!this.send(Object.assign({}, msg, { q }))) { clearTimeout(t); this.waiting.delete(q); resolve({ ok: false, err: "not connected" }); }
		});
	}

	// how long Live takes to carry out a command, measured end to end
	async measure(n = 20) {
		const rtt = [];
		let stats = null;
		for (let i = 0; i < n; i++) {
			const t0 = Date.now();
			const r = await this.request({ t: "ping" });
			if (!r.ok) break;
			rtt.push(Date.now() - t0);
			stats = r.v && r.v.stats;
			await new Promise(res => setTimeout(res, 30 + Math.random() * 40));
		}
		if (!rtt.length) return null;
		rtt.sort((a, b) => a - b);
		const p = f => rtt[Math.min(rtt.length - 1, Math.floor(rtt.length * f))];
		return { n: rtt.length, p50: p(0.5), p95: p(0.95), max: rtt[rtt.length - 1], live: stats, doorbell: !!this.doorbell };
	}
}

function alive(pid) {
	try { process.kill(pid, 0); return true; }
	catch (e) { return e.code === "EPERM"; }
}

module.exports = { LiveLink, DISCOVERY };
