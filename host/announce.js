// Makes the dashboard easy to reach from phones and tablets on the same
// network: announced over Bonjour/mDNS as "SetPilot" (http://setpilot.local)
// and shown as a QR code. Both are best effort.

const os = require("os");

function lanAddresses() {
	const out = [];
	for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
	return out;
}

function announce(port, log = () => {}) {
	let bonjour = null, service = null;
	try {
		const { Bonjour } = require("bonjour-service");
		bonjour = new Bonjour();
		service = bonjour.publish({ name: "SetPilot", type: "http", port, host: "setpilot.local", txt: { path: "/" } });
		service.on("error", e => log("mDNS: " + e.message));
	} catch (e) { log("mDNS unavailable: " + e.message); }
	const ip = lanAddresses()[0];
	const url = ip ? `http://${ip}:${port}` : `http://localhost:${port}`;
	return {
		url,
		friendly: `http://setpilot.local${port === 80 ? "" : ":" + port}`,
		async qr() { try { return await require("qrcode").toString(url, { type: "terminal", small: true }); } catch (e) { return ""; } },
		async qrSvg() { try { return await require("qrcode").toString(url, { type: "svg", margin: 1 }); } catch (e) { return ""; } },
		stop() { try { if (service) service.stop(); if (bonjour) bonjour.destroy(); } catch (e) { } }
	};
}

module.exports = { announce, lanAddresses };
