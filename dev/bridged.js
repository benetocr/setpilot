// loadEngine, but the engine talks to the fake song through the real bridge:
// FakeScript (the Remote Script's protocol) -> Mirror -> LiveAPI facade.
//   SP_BRIDGE=1 node dev/test_engine.js         writes land on the next tick
//   SP_BRIDGE=1 SP_WRITE_DELAY=3 node ...       writes land 3 ticks later
const { loadEngine: loadDirect } = require("./fake_live");
const { FakeScript, connectLoopback } = require("./fake_script");
const { Mirror } = require("../bridge/mirror");
const { makeLiveAPI } = require("../bridge/facade");

function loadEngine(song, opts = {}) {
	const script = new FakeScript(song, { writeDelay: Number(process.env.SP_WRITE_DELAY || 0) });
	const mirror = new Mirror({ now: () => 0 });
	const link = connectLoopback(script, mirror);
	const eng = loadDirect(song, Object.assign({}, opts, {
		liveApiFor: () => makeLiveAPI(mirror, { ownTrack: () => song.ownTrack }),
		beforeTick: link.pump
	}));
	// a command reaches the engine after Live has reported what happened before it
	const send = eng.send;
	// Write delay only matters for what the engine does on its own as the song
	// plays (count-ins, jumps, fades, stops). What a command changes is checked
	// by the tests right away, so Live catches up with commands at once.
	eng.send = (cmd, args) => { link.pump(); send(cmd, args); script.drain(); link.pump(); };
	eng.mirror = mirror;
	eng.script = script;
	return eng;
}

module.exports = { loadEngine };
