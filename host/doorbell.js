// The doorbell: a MIDI message on the app's own virtual port, "SetPilot
// Bridge". Live hands MIDI to the Remote Script at once, on its main thread,
// where the script may change the set, so a command runs within a few ms
// instead of waiting up to ~100 ms for Live's next display tick.
//
// The same port is what lets Live find the SetPilot control surface by
// itself (the script suggests this port name).
//
// "udp:<port>" rings a test harness instead of MIDI.

const PORT_NAME = "SetPilot Bridge";
const RING = [0xbf, 119, 127];    // CC 119 on channel 16

function makeDoorbell(spec, log = () => {}) {
	if (spec === "off") return null;
	if (spec && spec.startsWith("udp:")) {
		const dgram = require("dgram");
		const port = Number(spec.slice(4));
		const s = dgram.createSocket("udp4");
		s.unref();
		const msg = Buffer.from(RING);
		return { kind: "udp", ring: () => s.send(msg, port, "127.0.0.1"), close: () => s.close() };
	}
	let midi;
	try { midi = require("@julusian/midi"); }
	catch (e) { log("doorbell: MIDI module missing, Live will pick up commands on its own tick"); return null; }
	try {
		const out = new midi.Output();
		if (process.platform === "win32") {
			// Windows has no virtual MIDI ports of its own: use one that exists
			// (loopMIDI or Windows MIDI Services loopback) when it is there
			let found = -1;
			for (let i = 0; i < out.getPortCount(); i++) if (out.getPortName(i).includes(PORT_NAME)) found = i;
			if (found < 0) { log("doorbell: no \"" + PORT_NAME + "\" MIDI port on this PC"); return null; }
			out.openPort(found);
		} else out.openVirtualPort(PORT_NAME);
		return { kind: "midi", ring: () => out.sendMessage(RING), close: () => out.closePort() };
	} catch (e) {
		log("doorbell: " + e.message);
		return null;
	}
}

module.exports = { makeDoorbell, PORT_NAME, RING };
