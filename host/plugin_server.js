// Where the SetPilot Audio plugins connect: a TCP server on 127.0.0.1 whose
// port is written to ~/.setpilot/app.json. Each plugin says which role it
// plays (click, cues, guide, tail); messages for a role go to every plugin
// with that role. One JSON object per line, like the Live bridge.

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const APP_FILE = path.join(os.homedir(), ".setpilot", "app.json");

class PluginServer extends EventEmitter {
	constructor({ file = APP_FILE, log = () => {} } = {}) {
		super();
		this.file = file;
		this.log = log;
		this.clients = new Set();
	}

	start() {
		this.server = net.createServer(sock => this.accept(sock));
		this.server.listen(0, "127.0.0.1", () => {
			this.port = this.server.address().port;
			try {
				fs.mkdirSync(path.dirname(this.file), { recursive: true });
				let info = {};
				try { info = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) { }
				Object.assign(info, { plugins: this.port, pid: process.pid, at: Date.now() });
				fs.writeFileSync(this.file, JSON.stringify(info));
			} catch (e) { this.log("plugin server: " + e.message); }
			this.emit("listening", this.port);
		});
		return this;
	}

	accept(sock) {
		sock.setNoDelay(true);
		sock.setEncoding("utf8");
		const c = { sock, role: null, buf: "" };
		this.clients.add(c);
		sock.on("data", d => {
			c.buf += d;
			let i;
			while ((i = c.buf.indexOf("\n")) >= 0) {
				const line = c.buf.slice(0, i);
				c.buf = c.buf.slice(i + 1);
				let m;
				try { m = JSON.parse(line); } catch (e) { continue; }
				if (m.t === "hello") {
					const was = c.role;
					c.role = String(m.role || "");
					if (was && was !== c.role) this.roleChanged(was);
					this.emit("hello", c.role, m);
					this.roleChanged(c.role);
				} else if (c.role) this.emit("event", c.role, m);
			}
		});
		const gone = () => {
			if (!this.clients.has(c)) return;
			this.clients.delete(c);
			if (c.role) this.roleChanged(c.role);
		};
		sock.on("close", gone);
		sock.on("error", gone);
	}

	roles() {
		const r = {};
		for (const c of this.clients) if (c.role) r[c.role] = (r[c.role] || 0) + 1;
		return r;
	}

	roleChanged(role) { this.emit("roles", this.roles(), role); }

	send(role, msg) {
		const line = JSON.stringify(msg) + "\n";
		let n = 0;
		for (const c of this.clients) if (c.role === role) { c.sock.write(line); n++; }
		return n;
	}

	stop() {
		for (const c of this.clients) c.sock.destroy();
		if (this.server) this.server.close();
		try {
			const info = JSON.parse(fs.readFileSync(this.file, "utf8"));
			if (info.pid === process.pid) { delete info.plugins; fs.writeFileSync(this.file, JSON.stringify(info)); }
		} catch (e) { }
	}
}

module.exports = { PluginServer, APP_FILE };
