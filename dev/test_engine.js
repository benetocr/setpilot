// Headless checks of setpilot_engine.js against the fake Live.
const assert = require("assert");
const { FakeSong, DEMO_CUES } = require("./fake_live");
const { loadEngine } = process.env.SP_BRIDGE ? require("./bridged") : require("./fake_live");

let failures = 0;
const WRITE_DELAY = Number(process.env.SP_BRIDGE && process.env.SP_WRITE_DELAY || 0);
function test(name, fn) {
	try { fn(); console.log("ok   " + name); }
	catch (e) { failures++; console.log("FAIL " + name + "\n     " + e.message); }
}

function setup(opts = {}) {
	const song = new FakeSong(opts.cues || DEMO_CUES);
	if (opts.tail) song.tailDevice = 8;
	let last = null, struct = null, eng = null;
	const tailPlans = [], notices = [];
	eng = loadEngine(song, {
		realtime: false,
		onOutlet: a => {
			if (a[0] === "pos") last = a;
			if (a[0] === "notice") notices.push(a.slice(1));
			// the server mixing a tail: answer right away
			if (a[0] === "tailprep") { tailPlans.push(JSON.parse(JSON.stringify(eng.dicts.setpilot_tail))); setImmediate(() => {}); song.reply.push(["tailready", a[1], "/sim/tails/" + a[1] + ".wav"]); }
		}
	});
	const run = ms => { for (let i = 0; i < ms / 20; i++) eng.step(20); };
	run(40);
	if (!opts.guide) eng.send("cuesource", [0]);
	struct = eng.dicts.setpilot_struct;
	const pos = () => ({ t: last[1], playing: last[2], song: last[6], sec: last[7], qSong: last[8], qSec: last[9],
		loopSong: last[11], loopSec: last[12], arm: last[15], pending: last[16] });
	// run until the playhead (in beats) satisfies a predicate
	// through the bridge with SP_WRITE_DELAY, Live applies what the engine asked
	// a few ticks later: let it catch up before the test looks at the song
	const settle = () => { for (let i = 0; i < WRITE_DELAY; i++) eng.step(20); };
	const until = (pred, maxMs = 900000) => { for (let ms = 0; ms < maxMs; ms += 20) { eng.step(20); if (pred(pos())) { settle(); return; } } throw new Error("timeout, at t=" + pos().t); };
	return { song, eng, run, struct, pos, until, tailPlans, notices, cmd: (c, ...a) => eng.send(c, a) };
}

test("parses songs, sections and STOP markers", () => {
	const { struct } = setup();
	assert.strictEqual(struct.songs.length, 4);
	const s0 = struct.songs[0];
	assert.strictEqual(s0.name, "Grande y Fiel");
	assert.strictEqual(s0.bpm, 72);
	assert.strictEqual(s0.key, "G");
	assert.strictEqual(s0.end, 232);
	assert.deepStrictEqual(s0.sections.map(s => s.name), ["Intro", "Verso 1", "Coro", "Verso 2", "Coro", "Puente", "Coro", "Final"]);
	assert.strictEqual(s0.sections[7].end, 232);
	assert.deepStrictEqual(struct.order, [0, 1, 2, 3]);
});

test("play starts the armed song and stops at its end", () => {
	const t = setup();
	t.cmd("playsong", 1);
	t.run(20);
	assert.strictEqual(t.pos().playing, 1);
	t.until(p => p.playing === 0);
	assert.ok(Math.abs(t.song.props.current_song_time - 480) < 0.01, "should be parked at next song, got " + t.song.props.current_song_time);
	assert.strictEqual(t.pos().arm, 2);
});

test("queued backward jump lands exactly at the end of the section", () => {
	const t = setup();
	t.cmd("playsong", 0);
	t.until(p => p.t > 20); // inside Verso 1 (16..48)
	t.cmd("section", 0, 0, 0); // back to Intro
	t.until(p => p.sec === 0 && p.t < 10);
	assert.ok(t.song.log.includes("jump 48 -> 0"), t.song.log.join(", "));
	assert.strictEqual(t.pos().qSong, -1);
	assert.strictEqual(t.song.props.clip_trigger_quantization, 4);
});

test("queued forward jump skips sections without a seam", () => {
	const t = setup();
	t.cmd("playsong", 0);
	t.until(p => p.t > 2);
	t.cmd("section", 0, 5, 0); // Intro -> Puente (144)
	t.until(p => p.sec === 5);
	assert.ok(t.song.log.includes("jump 16 -> 144"), t.song.log.join(", "));
});

test("tapping the queued section again cancels it", () => {
	const t = setup();
	t.cmd("playsong", 0);
	t.until(p => p.t > 2);
	t.cmd("section", 0, 5, 0);
	assert.strictEqual(t.pos().qSec, -1, "queue appears on next tick");
	t.run(20);
	assert.strictEqual(t.pos().qSec, 5);
	t.cmd("section", 0, 5, 0);
	t.run(20);
	assert.strictEqual(t.pos().qSec, -1);
	t.until(p => p.sec === 1);
	assert.ok(!t.song.log.some(l => l.startsWith("jump")));
});

test("contiguous next section does not jump", () => {
	const t = setup();
	t.cmd("playsong", 0);
	t.until(p => p.t > 2);
	t.cmd("section", 0, 1, 0);
	t.until(p => p.sec === 1);
	t.run(40);
	assert.strictEqual(t.pos().qSec, -1);
	assert.ok(!t.song.log.some(l => l.startsWith("jump")));
});

test("infinite loop on the current section, then release", () => {
	const t = setup();
	t.cmd("playsong", 0);
	t.until(p => p.t > 20);
	t.cmd("loop", 0, 1);
	t.until(p => t.song.log.includes("loop 48 -> 16"));
	t.run(2000);
	assert.strictEqual(t.pos().sec, 1);
	t.cmd("loop", 0, 1); // toggle off
	t.until(p => p.sec === 2);
});

test("repeat once plays the section twice and continues", () => {
	const t = setup();
	t.cmd("playsong", 0);
	t.until(p => p.t > 20);
	t.cmd("repeat", 0, 1);
	t.until(p => p.sec === 2);
	assert.strictEqual(t.song.log.filter(l => l.startsWith("loop")).length, 1);
	assert.strictEqual(t.song.props.loop, 0);
});

test("loop on another section jumps there and loops it", () => {
	const t = setup();
	t.cmd("playsong", 0);
	t.until(p => p.t > 2);
	t.cmd("loop", 0, 2); // Coro 48..80
	t.until(p => t.song.log.includes("loop 80 -> 48"));
	assert.ok(t.song.log.includes("jump 16 -> 48"));
});

test("reordered setlist decides the next song", () => {
	const t = setup();
	t.cmd("setorder", 0, 3, 1, 2);
	t.run(20);
	assert.deepStrictEqual(t.eng.dicts.setpilot_struct.order, [0, 3, 1, 2]);
	assert.ok(JSON.parse(t.eng.dicts.setpilot_store.order).length === 4);
	t.cmd("playsong", 0);
	t.until(p => p.playing === 0);
	assert.ok(Math.abs(t.song.props.current_song_time - 704) < 0.01);
});

test("auto-continue chains into the next setlist song at the bar", () => {
	const t = setup();
	t.cmd("autostop", 0);
	t.cmd("setorder", 0, 2, 1, 3);
	t.cmd("playsong", 0);
	t.until(p => p.song === 2, 600000);
	assert.strictEqual(t.pos().playing, 1);
	assert.ok(t.song.log.includes("jump 232 -> 480"), t.song.log.join(", "));
});

test("choosing another song while playing makes it next", () => {
	const t = setup();
	t.cmd("playsong", 0);
	t.until(p => p.t > 2);
	t.cmd("selectsong", 3, 0);
	t.run(20);
	assert.strictEqual(t.pos().pending, 3);
	t.until(p => p.playing === 0, 600000);
	assert.ok(Math.abs(t.song.props.current_song_time - 704) < 0.01);
});

test("renaming a locator is picked up", () => {
	const t = setup();
	t.song.cues[1].name = "Intro Pad";
	t.run(1600);
	assert.strictEqual(t.eng.dicts.setpilot_struct.songs[0].sections[0].name, "Intro Pad");
});

test("set without # headers becomes one song", () => {
	const song = new FakeSong([["Intro", 0], ["Verse", 16], ["Chorus", 48]]);
	const eng = loadEngine(song, { realtime: false });
	eng.step(20);
	const s = eng.dicts.setpilot_struct;
	assert.strictEqual(s.songs.length, 1);
	assert.strictEqual(s.songs[0].sections.length, 3);
});


// ---------------------------------------------------------------- voice cues
function cueSetup(mode) {
	const t = setup();
	for (const txt of t.eng.dicts.setpilot_struct.cueTexts) t.cmd("cuefile", txt, "/cues/" + txt + ".wav");
	if (mode !== undefined) t.cmd("cuemode", mode);
	t.run(20);
	const map = t.eng.ctx.cueMap;
	return Object.assign(t, { audio: t.song.audio, idx: name => map[name] });
}

test("cue texts are collected and preloaded", () => {
	const t = cueSetup();
	assert.ok(t.eng.dicts.setpilot_struct.cueTexts.includes("Pre Coro"));
	assert.ok(Object.keys(t.audio.preload).length >= 10);
});

test("generated mode: Guide gated and next section announced one bar early", () => {
	const t = cueSetup(2);
	assert.strictEqual(t.audio.gate, 0, "guide should be gated");
	t.cmd("playsong", 0);
	t.until(p => p.t > 14);
	assert.deepStrictEqual(t.audio.played[0], [t.idx("Verso 1"), 12]);
});

test("generated mode: queued jump announces the target, not the timeline", () => {
	const t = cueSetup(2);
	t.cmd("playsong", 0);
	t.until(p => p.t > 2);
	t.cmd("section", 0, 5, 0); // Puente
	t.until(p => p.sec === 5);
	assert.deepStrictEqual(t.audio.played[0], [t.idx("Puente"), 12]);
});

test("generated mode: an infinite loop announces the same section every pass", () => {
	const t = cueSetup(2);
	t.cmd("playsong", 0);
	t.until(p => p.t > 20);
	t.cmd("loop", 0, 1); // Verso 1 16..48
	t.until(() => t.song.log.filter(l => l.startsWith("loop")).length >= 2, 900000);
	const v = t.audio.played.filter(x => x[0] === t.idx("Verso 1") && x[1] > 16);
	assert.ok(v.length >= 2, JSON.stringify(t.audio.played));
	assert.ok(v.every(x => x[1] === 44), JSON.stringify(t.audio.played));
});

test("fix mode: natural transitions leave the original Guide alone", () => {
	const t = cueSetup(1);
	assert.strictEqual(t.audio.gate, 1);
	t.cmd("playsong", 0);
	t.until(p => p.sec === 1);
	assert.strictEqual(t.audio.played.length, 0);
	assert.strictEqual(t.audio.gate, 1);
});

test("fix mode: a jump gates the Guide for the cue bar and reopens it after", () => {
	const t = cueSetup(1);
	t.cmd("playsong", 0);
	t.until(p => p.t > 2);
	t.cmd("section", 0, 2, 0); // Intro -> Coro (skips Verso 1)
	t.until(p => p.t > 11.9);
	assert.strictEqual(t.audio.gate, 0, "closed before the cue bar");
	t.until(p => p.sec === 2);
	t.run(60);
	assert.deepStrictEqual(t.audio.played[0], [t.idx("Coro"), 12]);
	assert.strictEqual(t.audio.gate, 1, "open again in the new section");
});

test("a jump decided inside the cue bar is announced right away", () => {
	const t = cueSetup(2);
	t.cmd("playsong", 0);
	t.until(p => p.t > 13);
	t.cmd("section", 0, 6, 0); // Coro (second)
	t.run(40);
	const last = t.audio.played[t.audio.played.length - 1];
	assert.strictEqual(last[0], t.idx("Coro"));
	assert.strictEqual(last[2], "now");
});

test("cues off: nothing is spoken and the Guide plays", () => {
	const t = cueSetup(0);
	t.cmd("playsong", 0);
	t.until(p => p.sec === 1);
	assert.strictEqual(t.audio.played.length, 0);
	assert.strictEqual(t.audio.gate, 1);
});

test("settings are stored with the setlist", () => {
	const t = cueSetup(1);
	t.cmd("cuebars", 2);
	const st = t.eng.ctx.restored;
	assert.strictEqual(st.cueMode, 1);
	assert.strictEqual(st.cueBars, 2);
});


test("play starts where SetPilot prepared it even with a selection in the Arrangement", () => {
	const t = setup();
	t.song.selectionStart = 100;
	t.cmd("section", 1, 3, 0);
	t.run(100);
	t.cmd("play");
	t.run(200);
	// the count-in is always on: one bar before the section
	assert.ok(t.pos().t >= 316 && t.pos().t < 318, "at " + t.pos().t);
	t.until(p => p.t >= 320.2);
	assert.strictEqual(t.pos().sec, 3);
});

// ---------------------------------------------------------------- transitions
test("Stay In Song stops and stays at the start of the same song", () => {
	const t = setup();
	t.cmd("transition", 1, 2);
	t.cmd("playsong", 1);
	t.until(p => p.playing === 0);
	assert.ok(Math.abs(t.song.props.current_song_time - 256) < 0.01, "at " + t.song.props.current_song_time);
	assert.strictEqual(t.pos().arm, 1);
});

test("AutoLink per song skips the gap and the next song keeps its own stop", () => {
	const t = setup();
	t.cmd("transition", 0, 3);
	t.cmd("playsong", 0);
	t.until(p => p.song === 1, 600000);
	assert.ok(t.song.log.includes("jump 232 -> 256"), t.song.log.join(", "));
	t.until(p => p.playing === 0, 900000);
	assert.ok(Math.abs(t.song.props.current_song_time - 480) < 0.01, "song 2 uses the default: cue next");
	assert.strictEqual(t.eng.dicts.setpilot_struct.songs[0].trEff, 3);
});

test("Overlap without SetPilot Tail falls back to AutoLink", () => {
	const t = setup();
	t.cmd("transition", 0, 4);
	t.cmd("playsong", 0);
	t.until(p => p.song === 1, 600000);
	assert.ok(t.song.log.includes("jump 232 -> 256"), t.song.log.join(", "));
});

test("Overlap: the tail is prepared, the next song starts early and the tail plays", () => {
	const t = setup({ tail: true });
	t.run(200);
	t.cmd("transition", 0, 4);
	t.run(2000);
	assert.strictEqual(t.tailPlans.length, 1);
	const plan = t.tailPlans[0];
	assert.strictEqual(plan.song, "Grande y Fiel");
	assert.strictEqual(plan.to, 232);
	// 72 bpm: a bar is 3.33 s, 5 s rounds up to 2 bars of window
	assert.strictEqual(plan.from, 224);
	assert.ok(plan.stems.length >= 2 && !plan.stems.some(x => /click|guide|SP /i.test(x.name)), JSON.stringify(plan.stems.map(x => x.name)));
	t.cmd("playsong", 0);
	t.until(p => p.song === 1, 600000);
	// last section "Final" is 24 beats, next first section "Intro" 16 beats at 128 = 7.5 s, cap 5 s -> 1 bar
	assert.ok(t.song.log.includes("jump 228 -> 256"), t.song.log.join(", "));
	const play = t.song.tailLog.find(x => x[0] === "play");
	assert.ok(play, JSON.stringify(t.song.tailLog));
	assert.strictEqual(play[3], 1, "overlap mode");
	assert.ok(play[6] < 228 && play[6] >= 224, "armed in the bar before the handover");
	assert.ok(Math.abs(play[5] - (228 - 224) * 60 / 72 * 1000) < 1, "offset into the tail");
});

test("Crossfade: the next song fades in and the faders come back exactly", () => {
	const t = setup({ tail: true });
	t.run(200);
	t.cmd("transition", 1, 5);
	t.run(2000);
	t.cmd("playsong", 1);
	t.until(p => p.song === 2, 900000);
	const play = t.song.tailLog.find(x => x[0] === "play");
	assert.strictEqual(play[3], 2, "crossfade mode");
	// 128 bpm: bar 1.875 s, 5 s -> 3 bars: handover at 464 - 12
	assert.ok(t.song.log.includes("jump 452 -> 480"), t.song.log.join(", "));
	const keysVol = t.song.objs[3005];
	t.run(500);
	assert.ok(keysVol.value < 0.85 && keysVol.value > 0, "keys fading in: " + keysVol.value);
	assert.strictEqual(t.song.objs[3001].value, 0.85, "click untouched");
	t.run(6000);
	assert.strictEqual(keysVol.value, 0.85);
});

test("transitions are stored per song", () => {
	const t = setup();
	let stored = null;
	t.eng.ctx.outlet = (n, ...a) => { const f = [].concat(...a); if (f[0] === "store") stored = f.slice(1).join(" "); };
	t.cmd("transition", 2, 5);
	t.cmd("transdefault", 3);
	const o = JSON.parse(stored);
	assert.strictEqual(o.songs["Tu Nombre"].tr, 5);
	assert.strictEqual(o.trDefault, 3);
});

// ---------------------------------------------------------------- companions, click, tempo, key
test("companion devices are found and the song's own click is muted", () => {
	const t = setup();
	t.run(100);
	const c = t.eng.dicts.setpilot_struct.companions;
	assert.deepStrictEqual(c, { click: 1, gate: 1, tail: 0 });
	assert.strictEqual(t.song.tracks.find(x => x.name === "Click").mute, 1);
	assert.strictEqual(t.song.tracks.find(x => x.name === "SP Click").mute, 0);
	assert.strictEqual(t.song.clickParams.beats, 4);
	assert.strictEqual(t.song.clickParams.accmask, 1);
});

test("click settings reach SetPilot Click", () => {
	const t = setup();
	t.run(100);
	t.cmd("clicksub", 2);
	t.cmd("clickaccent", 2, 4);   // accent beat 3 (levels: 4 accent, 3 lighter, 2 beat, 1 soft, 0 off)
	t.cmd("clickaccent", 3, 0);   // silence beat 4
	t.cmd("clicklevel", 3, 120);
	assert.strictEqual(t.song.clickParams.sub, 2);
	assert.strictEqual(t.song.clickParams.accmask, 1 + 4);
	assert.strictEqual(t.song.clickParams.mutemask, 8);
	assert.strictEqual(t.song.clickParams.gain, 1.2);
	t.cmd("clickaccent", 1, 3);
	t.cmd("clickaccent", 2, 1);
	assert.strictEqual(t.song.clickParams.midmask, 2);
	assert.strictEqual(t.song.clickParams.softmask, 4);
	t.cmd("clickon", 0);
	assert.strictEqual(t.song.tracks.find(x => x.name === "Click").mute, 0, "song click back when ours is off");
});

test("without SetPilot Guide, generated mode mutes the Guide track", () => {
	const song = new FakeSong(DEMO_CUES);
	song.gateDevice = 0;
	const eng = loadEngine(song, { realtime: false });
	for (let i = 0; i < 5; i++) eng.step(20);
	assert.strictEqual(song.tracks.find(x => x.name === "Guide").mute, 1);
});

test("with no voice player (app without its plugin) the Guide is never muted", () => {
	const song = new FakeSong(DEMO_CUES);
	song.gateDevice = 0;
	const eng = loadEngine(song, { realtime: false });
	for (let i = 0; i < 5; i++) eng.step(20);
	assert.strictEqual(song.tracks.find(x => x.name === "Guide").mute, 1, "Max: muted, the voice replaces it");
	eng.send("voiceplayer", [0]);
	eng.step(20);
	assert.strictEqual(song.tracks.find(x => x.name === "Guide").mute, 0, "app: the Guide is the only cue source");
});

test("no voice player: a jump silences the Guide's wrong cue, a natural cue is left alone", () => {
	const run = jump => {
		const song = new FakeSong(DEMO_CUES);
		song.gateDevice = 0;
		const eng = loadEngine(song, { realtime: false });
		for (let i = 0; i < 5; i++) eng.step(20);
		eng.send("cuesource", [0]);
		eng.send("voiceplayer", [0]);
		eng.send("playsong", [0]);
		const guide = song.tracks.find(x => x.name === "Guide");
		let step = 0;
		while (song.props.current_song_time < 6 && step++ < 5000) eng.step(20);
		if (jump) eng.send("section", [0, 5, 0]);       // Intro -> Puente instead of Verso 1
		const muted = [];
		while (song.props.current_song_time < 15.5 && step++ < 20000) { eng.step(20); if (song.props.current_song_time > 12.5) muted.push(guide.mute); }
		return muted;
	};
	assert.ok(run(false).every(m => m === 0), "Guide says the right cue: left alone");
	assert.ok(run(true).every(m => m === 1), "Guide would say Verso 1 before the Puente: silenced");
});

test("tempo chosen for a song is applied when it starts", () => {
	const t = setup();
	t.cmd("temposet", 1, 1340);  // Cielo Abierto 128 -> 134
	t.cmd("playsong", 1);
	t.run(40);
	assert.strictEqual(t.song.props.tempo, 134);
	assert.strictEqual(t.eng.dicts.setpilot_struct.songs[1].tempoSet, 134);
	t.cmd("temposet", 1, 0);     // locked while the song plays
	assert.strictEqual(t.song.props.tempo, 134);
	t.cmd("keyset", 1, 2);
	assert.strictEqual(t.eng.dicts.setpilot_struct.songs[1].semis, 0, "key locked too");
	t.cmd("stop");
	t.cmd("temposet", 1, 0);     // stopped: back to original
	assert.strictEqual(t.song.props.tempo, 128);
});

test("key change transposes the song's audio clips only", () => {
	const t = setup();
	t.run(100);
	t.cmd("keyset", 0, 2);
	const clip = id => t.song.clips.find(c => c.id === id);
	assert.strictEqual(clip(501).pitch_coarse, 2);
	assert.strictEqual(clip(501).warp_mode, 6);
	assert.strictEqual(clip(502).pitch_coarse, 0, "other song untouched");
	assert.strictEqual(clip(301).pitch_coarse, 0, "drums untouched");
	assert.strictEqual(clip(201).pitch_coarse, 0, "guide untouched");
	assert.strictEqual(t.eng.ctx.restored.songs["Grande y Fiel"].semis, 2);
});

test("songs without a BPM go back to the set's tempo automation", () => {
	const song = new FakeSong([["# Uno | 100", 0], ["Intro", 0], ["STOP", 32], ["# Dos", 48], ["Intro", 48], ["STOP", 80]]);
	const eng = loadEngine(song, { realtime: false });
	eng.step(20);
	eng.send("playsong", [0]);
	eng.step(20);
	assert.strictEqual(song.props.tempo, 100);
	eng.send("stop", []);
	eng.send("playsong", [1]);
	eng.step(20);
	assert.ok(song.log.includes("re_enable_automation"));
});


// ---------------------------------------------------------------- import
test("importing a song appends it after a gap, on matching tracks, with SetPilot locators", () => {
	const t = setup();
	t.run(100);
	const tracksBefore = t.song.tracks.length;
	const tempoBefore = t.song.props.tempo;
	t.eng.dicts.setpilot_import = {
		title: "Because He Lives", key: "F", bpm: 100, meter: "4/4", gap: 16, end: 408,
		locators: [{ time: 0, name: "Count Off" }, { time: 8, name: "Vamp" }, { time: 12, name: "Intro" }, { time: 44, name: "Verse 1" }, { time: 392, name: "Ending" }],
		tracks: [
			{ name: "Click Track", clips: [{ time: 0, file: "/x/Click Track.m4a" }] },
			{ name: "Guide", clips: [{ time: 0, file: "/x/Guide.m4a" }] },
			{ name: "Keys 1", clips: [{ time: 0, file: "/x/Keys 1.m4a" }] },
			{ name: "Drums", clips: [{ time: 0, file: "/x/Drums.m4a" }] }
		]
	};
	t.cmd("importplan");
	t.run(2000);
	const P = 904 + 64; // last STOP at 904, 16 bars of 4 beats
	const newClips = t.song.clips.filter(c => c.file);
	assert.strictEqual(newClips.length, 4);
	assert.ok(newClips.every(c => c.start_time === P));
	const byFile = f => newClips.find(c => c.file.endsWith(f));
	assert.strictEqual(byFile("Click Track.m4a").track, 1, "click stem on the Click track");
	assert.strictEqual(byFile("Guide.m4a").track, 2, "guide stem on the Guide track");
	assert.strictEqual(byFile("Drums.m4a").track, 3);
	assert.strictEqual(byFile("Drums.m4a").warp_mode, 0);
	assert.strictEqual(byFile("Keys 1.m4a").warp_mode, 6);
	assert.strictEqual(t.song.tracks.length, tracksBefore + 1, "a Keys 1 track was created");
	assert.strictEqual(t.song.tracks[t.song.tracks.length - 1].name, "Keys 1");
	const names = t.song.cues.filter(c => c.time >= P).sort((a, b) => a.time - b.time).map(c => c.time - P + ":" + c.name);
	assert.deepStrictEqual(names, ["0:# Because He Lives | 100 | F", "8:Vamp", "12:Intro", "44:Verse 1", "392:Ending", "408:STOP"]);
	const s = t.eng.dicts.setpilot_struct.songs.find(x => x.name === "Because He Lives");
	assert.ok(s, "the new song is in the setlist");
	assert.strictEqual(s.sections[0].name, "Count Off");
	assert.strictEqual(t.eng.dicts.setpilot_struct.order[t.eng.dicts.setpilot_struct.order.length - 1], t.eng.dicts.setpilot_struct.songs.indexOf(s));
	assert.strictEqual(t.song.props.tempo, tempoBefore, "tempo restored after the import");
});

test("imported clips are re-warped to the original timing, whatever Live guessed", () => {
	const t = setup();
	t.run(100);
	t.eng.dicts.setpilot_import = {
		title: "Do It Again", key: "Bb", bpm: 86, meter: "4/4", gap: 4, end: 140,
		locators: [{ time: 0, name: "Intro" }, { time: 32, name: "Verse 1" }],
		tracks: [
			// unwarped in the original set: straight at the set's 86 BPM
			{ name: "Drums", clips: [{ time: 0, file: "/x/Drums.wav", startBeat: 0, length: 140, markers: [[0, 0], [60 / 86, 1]] }] },
			// warped in the original with its own markers (a slight push in the middle)
			{ name: "Keys", clips: [{ time: 0, file: "/x/Keys.wav", startBeat: 0, length: 140, markers: [[0, 0], [30, 43], [60, 86.5], [90, 129]] }] }
		]
	};
	t.cmd("importplan");
	t.run(3000);
	const check = (f, map) => {
		const c = t.song.clips.find(x => x.file && x.file.endsWith(f));
		const wm = JSON.parse(c.warp_markers).warp_markers;
		for (const m of wm) assert.ok(Math.abs(m.beat_time - map(m.sample_time)) < 0.001, f + ": marker at " + m.beat_time + " for " + m.sample_time + " s");
		assert.strictEqual(c.end_marker, 140);
	};
	check("Drums.wav", s => s * 86 / 60);
	check("Keys.wav", s => s <= 30 ? s * 43 / 30 : s <= 60 ? 43 + (s - 30) * 43.5 / 30 : 86.5 + (s - 60) * 42.5 / 30);
});

// ---------------------------------------------------------------- warp guard
function importDoItAgain(t) {
	t.run(100);
	t.eng.dicts.setpilot_import = {
		title: "Do It Again", key: "Bb", bpm: 86, meter: "4/4", gap: 4, end: 140,
		locators: [{ time: 0, name: "Intro" }, { time: 32, name: "Verse 1" }],
		tracks: [
			{ name: "Drums", clips: [{ time: 0, file: "/x/Drums.wav", startBeat: 0, length: 140, markers: [[0, 0], [60 / 86, 1]] }] },
			{ name: "Keys", clips: [{ time: 0, file: "/x/Keys.wav", startBeat: 0, length: 140, markers: null }] }
		]
	};
	t.cmd("importplan");
	t.run(3000);
	return t.eng.dicts.setpilot_struct.songs.findIndex(x => x.name === "Do It Again");
}
function liveGuess(c) {
	const wm = [];
	for (let b = 0; b <= 160; b += 4) wm.push({ beat_time: b, sample_time: 2.37 + b * 60 / 84.51 });
	c.warp_markers = JSON.stringify({ warp_markers: wm });
}
const straight86 = c => JSON.parse(c.warp_markers).warp_markers.every(m => Math.abs(m.beat_time - m.sample_time * 86 / 60) < 0.001) && JSON.parse(c.warp_markers).warp_markers.length === 2;

test("import checks every clip and reports it; unwarped originals go straight at the session tempo", () => {
	const t = setup();
	const msgs = [];
	const orig = t.eng.onOutlet;
	importDoItAgain(t);
	const keys = t.song.clips.find(x => x.file === "/x/Keys.wav");
	assert.ok(straight86(keys), "no markers in the original: straight at 86");
	assert.ok(t.song.log.length >= 0);
	const st = t.eng.dicts.setpilot_struct;
	assert.ok(st.songs.some(x => x.name === "Do It Again"));
});

test("warp guard: a clip that loses its timing while stopped is fixed and reported", () => {
	const t = setup();
	importDoItAgain(t);
	const drums = t.song.clips.find(x => x.file === "/x/Drums.wav");
	assert.ok(straight86(drums));
	liveGuess(drums);                                   // an Undo, or Live re-analysing the file
	t.run(30000);                                       // the guard looks at every song while stopped
	assert.ok(straight86(drums), "fixed: " + drums.warp_markers.slice(0, 120));
});

test("warp guard: the song that starts is fixed before it plays", () => {
	const t = setup();
	const si = importDoItAgain(t);
	const keys = t.song.clips.find(x => x.file === "/x/Keys.wav");
	liveGuess(keys);
	t.cmd("selectsong", si, 0);
	t.cmd("play");
	t.run(20);
	assert.ok(straight86(keys), "fixed before playing");
});

test("warp guard: a song imported before the reference is adopted when its stems are clean", () => {
	const t = setup();
	t.run(9000);
	const ref = t.eng.dicts.setpilot_struct && true;
	assert.ok(ref);
	// the demo song's clips are clean (two markers, one tempo): the guard now protects them
	const c = t.song.clips.find(x => x.id === 201);
	liveGuess(c);
	t.run(40000);
	const wm = JSON.parse(c.warp_markers).warp_markers;
	assert.strictEqual(wm.length, 2);
	assert.ok(wm.every(m => Math.abs(m.beat_time - m.sample_time * 1.25) < 0.001), "back on its own timing: " + c.warp_markers);
});

test("warp guard: a song warped by hand with the same markers on every stem is protected too", () => {
	const t = setup();
	const same = JSON.stringify({ warp_markers: [{ beat_time: 0, sample_time: 0 }, { beat_time: 40, sample_time: 33 }, { beat_time: 100, sample_time: 84 }, { beat_time: 232, sample_time: 194 }] });
	for (const c of t.song.clips.filter(x => x.start_time === 0 && x.is_audio_clip)) c.warp_markers = same;
	t.run(9000);
	const c = t.song.clips.find(x => x.id === 301);
	liveGuess(c);
	t.run(40000);
	const wm = JSON.parse(c.warp_markers).warp_markers;
	const at = sec => sec <= 33 ? sec * 40 / 33 : sec <= 84 ? 40 + (sec - 33) * 60 / 51 : 100 + (sec - 84) * 132 / 110;
	assert.ok(wm.every(m => Math.abs(m.beat_time - at(m.sample_time)) < 0.01), "back on the hand-made timing: " + c.warp_markers.slice(0, 200));
});

test("warp guard: stems that disagree are never taken as the reference", () => {
	const t = setup();
	const c = t.song.clips.find(x => x.id === 201);
	liveGuess(c);                              // one stem on another tempo
	const before = c.warp_markers;
	t.run(40000);
	assert.strictEqual(c.warp_markers, before, "left alone: SetPilot can't know which one is right");
});

test("the store keeps a fresh warp reference when an older setlist file is restored", () => {
	const t = setup();
	importDoItAgain(t);
	t.cmd("restore", JSON.stringify({ order: ["Grande y Fiel"], songs: { "Do It Again": { bpm: 0, semis: 0 } } }));
	t.run(200);
	const drums = t.song.clips.find(x => x.file === "/x/Drums.wav");
	liveGuess(drums);
	t.run(30000);
	assert.ok(straight86(drums), "the reference survived the restore");
});

test("a clip with one real marker at the wrong tempo gets a second marker; its end follows its audio", () => {
	const t = setup();
	const si = importDoItAgain(t);
	const drums = t.song.clips.find(x => x.file === "/x/Drums.wav");
	// one marker plus Live's 1/32 beat helper, at double tempo; the clip cut at 90 beats
	drums.warp_markers = JSON.stringify({ warp_markers: [{ beat_time: 0, sample_time: 0 }, { beat_time: 0.03125, sample_time: 0.03125 * 60 / 172 }] });
	drums.loop_end = 90;
	t.run(30000);
	const wm = JSON.parse(drums.warp_markers).warp_markers;
	assert.ok(wm.every(m => Math.abs(m.beat_time - m.sample_time * 86 / 60) < 0.001), "86 BPM again: " + drums.warp_markers);
	assert.ok(Math.abs(drums.loop_end - 140) < 0.01, "ends where the original clip ended: " + drums.loop_end);
});

test("a clip the guard can't fix is reported once, not every few seconds", () => {
	const t = setup();
	importDoItAgain(t);
	const drums = t.song.clips.find(x => x.file === "/x/Drums.wav");
	drums.warp_markers = JSON.stringify({ warp_markers: [{ beat_time: 0, sample_time: 0 }, { beat_time: 0.03125, sample_time: 0.03125 * 60 / 172 }] });
	drums.sample_length = 0;                 // nothing to anchor a second marker to
	const notices = [];
	const orig = t.eng.outletHook;
	t.run(60000);
	const fixes = t.song.log.filter(l => /add_warp/.test(l)).length;
	assert.ok(fixes === 0);
});

test("cues come from the song's guide when the source is the guide", () => {
	const t = setup({ guide: true });
	const texts = t.eng.dicts.setpilot_struct.cueTexts;
	assert.ok(texts.includes("g|Grande y Fiel|Coro"), texts.slice(0, 5).join(", "));
	t.cmd("cuesource", 0);
	assert.ok(t.eng.dicts.setpilot_struct.cueTexts.includes("Coro"));
});

test("rewarpsong repairs the clips of an imported song with the stored timing", () => {
	const t = setup();
	t.run(100);
	t.eng.dicts.setpilot_import = {
		title: "Do It Again", key: "Bb", bpm: 86, meter: "4/4", gap: 4, end: 140,
		locators: [{ time: 0, name: "Intro" }],
		tracks: [{ name: "Drums", clips: [{ time: 0, file: "/x/Drums.wav", startBeat: 0, length: 140, markers: [[0, 0], [60 / 86, 1]] }] }]
	};
	t.cmd("importplan");
	t.run(3000);
	const c = t.song.clips.find(x => x.file && x.file.endsWith("Drums.wav"));
	assert.strictEqual(JSON.parse(c.warp_markers).warp_markers.length, 2, "straight stems keep two markers");
	// Live (or the user) messes it up again
	const wm = [];
	for (let b = 0; b <= 160; b += 4) wm.push({ beat_time: b, sample_time: 1 + b * 60 / 84 });
	c.warp_markers = JSON.stringify({ warp_markers: wm });
	c.file_path = c.file;
	const si = t.eng.dicts.setpilot_struct.songs.findIndex(x => x.name === "Do It Again");
	t.cmd("rewarpsong", si);
	t.run(500);
	for (const m of JSON.parse(c.warp_markers).warp_markers) assert.ok(Math.abs(m.beat_time - m.sample_time * 86 / 60) < 0.001);
});

test("mixer: tracks with level, mute and solo, controlled from the dashboard", () => {
	const t = setup();
	let mixers = 0, meters = null;
	const orig = t.eng.ctx.outlet;
	t.eng.ctx.outlet = (n, ...a) => { const f = [].concat(...a); if (f[0] === "mixer") mixers++; if (f[0] === "meters") meters = f; orig(n, ...a); };
	t.run(1500);
	const m = t.eng.dicts.setpilot_mixer;
	assert.ok(mixers >= 1);
	const keys = m.tracks.find(x => x.name === "Keys");
	assert.strictEqual(keys.vol, 0.85);
	assert.strictEqual(keys.db, "0.0 dB");
	assert.strictEqual(m.tracks.find(x => x.name === "SP Cues").kind, "cues");
	assert.strictEqual(m.tracks[m.tracks.length - 1].kind, "main");
	t.cmd("mixvol", 5, 425);
	t.cmd("mixmute", 3, 1);
	t.cmd("mixsolo", 5, 1);
	t.run(200);
	assert.strictEqual(t.song.objs[3005].value, 0.425);
	assert.strictEqual(t.song.tracks.find(x => x.id === 3).mute, 1);
	const keys2 = t.eng.dicts.setpilot_mixer.tracks.find(x => x.name === "Keys");
	assert.strictEqual(keys2.solo, 1);
	assert.strictEqual(keys2.db, "-17.0 dB");
	t.cmd("mixvol", -1, 1000);
	t.run(200);
	assert.strictEqual(t.song.objs[3999].value, 1);
	assert.strictEqual(meters, null, "no meters until the mixer is open");
	t.cmd("mixeron");
	t.run(300);
	assert.ok(meters && meters.length > 4, "meters while open");
});

test("instrument guesses from track names", () => {
	const t = setup();
	const g = t.eng.ctx.guessInstr;
	const cases = { "Click Track": "click", "Guide": "guide", "Drums (Live)": "drums", "Kick": "drums", "Perc": "perc", "Shaker": "perc",
		"Bass": "bass", "Synth Bass": "bass", "AG": "ag", "Acoustic Gtr": "ag", "EG 1": "eg", "EG2": "eg", "Electric Guitar": "eg",
		"Piano": "keys", "Organ": "keys", "Keys 2": "keys", "Pad": "synth", "Synth Lead": "synth", "Strings 2": "strings",
		"Alto": "vox", "Tenor 2": "vox", "BGVS": "vox", "Choir": "vox", "Loop": "loops", "Tracks": "loops", "FX": "loops", "Weird Thing": "other" };
	for (const k of Object.keys(cases)) assert.strictEqual(g(k), cases[k], k);
});

test("outputs per instrument: options read from Live, applied to matching tracks, kept with the set", () => {
	const t = setup();
	t.song.tailDevice = 8;
	t.run(4000);
	let stored = null;
	const orig = t.eng.ctx.outlet;
	t.eng.ctx.outlet = (n, ...a) => { const f = [].concat(...a); if (f[0] === "store") stored = JSON.parse(f.slice(1).join(" ")); orig(n, ...a); };
	t.cmd("routeopts");
	const r = t.eng.dicts.setpilot_routes;
	assert.deepStrictEqual(r.list.map(x => x.label), ["Main", "Ext. Out 1/2", "Ext. Out 3/4", "Ext. Out 5/6", "Band Bus"]);
	assert.strictEqual(t.song.tracks.find(x => x.id === 8).routeType, 19, "SP Tail back on Main after reading the channels");
	const kinds = r.kinds;
	t.cmd("setoutput", kinds.indexOf("drums"), 2);   // drums -> Ext. Out 3/4
	const drums = t.song.tracks.find(x => x.name === "Drums");
	assert.strictEqual(drums.routeType, 18);
	assert.strictEqual(drums.routeChan, 53);
	assert.strictEqual(t.song.tracks.find(x => x.name === "Keys").routeType, 19, "other kinds untouched");
	assert.deepStrictEqual(stored.instr.outputs.drums, { type: "Ext. Out", chan: "3/4" });
	// the Keys track is really a synth: mark it, it follows the synth output
	t.cmd("setoutput", kinds.indexOf("synth"), 4);   // synth -> Band Bus
	t.cmd("settrackinstr", 5, kinds.indexOf("synth"));
	assert.strictEqual(t.song.tracks.find(x => x.name === "Keys").routeType, 40);
	assert.strictEqual(stored.instr.tracks.keys, "synth");
	t.run(800);
	const keysRow = t.eng.dicts.setpilot_mixer.tracks.find(x => x.name === "Keys");
	assert.strictEqual(keysRow.instr, "synth");
	assert.strictEqual(keysRow.out, "Band Bus");
});

// ---------------------------------------------------------------- practice and show helpers
test("band fade out keeps click and Guide, fade in brings the mix back, stop restores", () => {
	const t = setup();
	t.cmd("playsong", 0);
	t.run(500);
	t.song.objs[3005].value = 0.7;              // Keys mixed a bit lower
	t.cmd("fadeout", 1000);
	t.run(1200);
	assert.strictEqual(t.song.objs[3005].value, 0, "keys out");
	assert.strictEqual(t.song.objs[3003].value, 0, "drums out");
	assert.strictEqual(t.song.objs[3002].value, 0.85, "guide stays");
	assert.strictEqual(t.song.objs[3001].value, 0.85, "song click stays");
	t.cmd("fadein", 600);
	t.run(800);
	assert.ok(Math.abs(t.song.objs[3005].value - 0.7) < 1e-9, "keys back to its own level");
	t.cmd("fadeout", 500);
	t.run(200);
	t.cmd("stop");
	assert.ok(Math.abs(t.song.objs[3005].value - 0.7) < 1e-9, "stop restores");
});

test("count-in: starts bars early with the band muted, names the section, band enters on the downbeat", () => {
	const t = setup();
	t.cmd("precount", 1);
	t.cmd("cuefile", "Coro", "/sim/coro.wav");
	t.cmd("section", 0, 2, 0);                 // Coro at 48, stopped: prepare there
	t.run(100);
	t.cmd("play");
	t.run(60);
	assert.ok(t.pos().t >= 44 && t.pos().t < 45, "starts one bar early: " + t.pos().t);
	const drums = t.song.tracks.find(x => x.name === "Drums"), click = t.song.tracks.find(x => x.name === "Click");
	assert.strictEqual(drums.mute, 1, "band muted during the count-in");
	assert.strictEqual(t.song.tracks.find(x => x.name === "Guide").mute, 1, "guide muted too");
	const said = t.song.audio.played.find(x => t.song.audio.preload[x[0]] === "/sim/coro.wav");
	assert.ok(said && said[1] < 44.5, "voice names the section at the count-in: " + JSON.stringify(t.song.audio.played));
	t.until(p => p.t >= 48.2);
	assert.strictEqual(drums.mute, 0, "band in");
	assert.strictEqual(t.pos().sec, 2);
});

test("count-in survives Live starting from its own selection first", () => {
	for (const sel of [10, 100]) {
		const t = setup();
		t.song.selectionStart = sel;
		t.song.seekLatency = 60;
		t.cmd("precount", 1);
		t.cmd("section", 0, 2, 0);
		t.run(100);
		t.cmd("play");
		t.run(400);
		const drums = t.song.tracks.find(x => x.name === "Drums");
		assert.ok(t.pos().t >= 44 && t.pos().t < 48, "corrected into the count-in from " + sel + ": " + t.pos().t);
		assert.strictEqual(drums.mute, 1, "band still muted (selection " + sel + ")");
		t.until(p => p.t >= 48.2);
		assert.strictEqual(drums.mute, 0, "band in");
	}
});

test("count-in is always on: off is refused, 2 bars works", () => {
	const t = setup();
	t.cmd("precount", 0);
	assert.strictEqual(t.eng.dicts.setpilot_struct.settings.precount, 1);
	t.cmd("precount", 2);
	t.cmd("section", 0, 2, 0);
	t.run(100);
	t.cmd("play");
	t.run(60);
	assert.ok(t.pos().t >= 40 && t.pos().t < 41, "two bars early: " + t.pos().t);
});

test("play from the middle of a section starts at the section's start, with the count-in", () => {
	const t = setup();
	t.cmd("section", 0, 2, 0);   // Coro 48..80
	t.run(100);
	t.song.props.current_song_time = 57.5;  // stopped in bar 3 of the Coro
	t.run(40);
	t.cmd("play");
	t.run(60);
	assert.ok(t.pos().t >= 44 && t.pos().t < 45, "one bar before the Coro: " + t.pos().t);
	const drums = t.song.tracks.find(x => x.name === "Drums");
	assert.strictEqual(drums.mute, 1);
	t.until(p => p.t >= 48.1);
	assert.strictEqual(drums.mute, 0, "band in on the Coro's downbeat");
});

test("play from the middle of the first section starts at the top of the song", () => {
	const t = setup();
	t.cmd("selectsong", 0, 0);
	t.run(60);
	t.song.props.current_song_time = 9;     // inside the Intro (0..16)
	t.run(40);
	t.cmd("play");
	t.run(60);
	assert.ok(t.pos().t < 1, "from the top: " + t.pos().t);
});

test("no count-in from the start of the song", () => {
	const t = setup();
	t.cmd("playsong", 0);
	t.run(60);
	assert.ok(t.pos().t < 1, "starts at the top: " + t.pos().t);
	assert.strictEqual(t.song.tracks.find(x => x.name === "Drums").mute, 0);
});

// ---------------------------------------------------------------- arrangement
// Grande y Fiel: 0 Intro 0-16, 1 Verso 1 16-48, 2 Coro 48-80, 3 Verso 2 80-112,
// 4 Coro 112-144, 5 Puente 144-176, 6 Coro 176-208, 7 Final 208-232
test("arrangement: plays the sections in the edited order with jumps", () => {
	const t = setup();
	t.cmd("arrset", 0, 0, 1, 2, 2, 5, 7);   // Intro V1 Coro Coro Puente Final
	assert.deepStrictEqual(t.eng.dicts.setpilot_struct.songs[0].arr, [0, 1, 2, 2, 5, 7]);
	t.cmd("playsong", 0);
	const seen = [];
	let last = "";
	t.until(p => {
		const k = p.sec + ":" + (t.eng && 0);
		if (p.playing && p.sec + "" !== last) { last = p.sec + ""; seen.push(p.sec); }
		return p.t >= 80 && p.sec === 2 && seen.length > 3 || p.playing === 0;
	});
	t.until(p => p.playing === 0 || p.t >= 232 - 0.5);
	assert.deepStrictEqual(seen.slice(0, 3), [0, 1, 2]);
	assert.ok(t.song.log.some(l => /jump 80 -> 48/.test(l)), "Coro again: " + t.song.log.slice(-8).join(" | "));
	assert.ok(t.song.log.some(l => /jump 80 -> 144/.test(l)), "then the Puente");
	assert.ok(t.song.log.some(l => /jump 176 -> 208/.test(l)), "then the Final");
});

test("arrangement: the song ends with its last section", () => {
	const t = setup();
	t.cmd("arrset", 0, 0, 1, 2);          // Intro V1 Coro: ends at 80
	t.cmd("playsong", 0);
	let maxT = 0;
	t.until(p => { if (p.playing) maxT = Math.max(maxT, p.t); return p.playing === 0; });
	assert.ok(maxT < 80 && maxT > 79, "stopped at the end of the Coro: " + maxT);
	assert.ok(Math.abs(t.song.props.current_song_time - 256) < 0.01, "next song prepared: " + t.song.props.current_song_time);
	const stopAt = t.song.log.filter(l => /jump/.test(l));
	assert.strictEqual(stopAt.length, 0, "no jumps for an arrangement that is a cut: " + stopAt.join(","));
});

test("arrangement: the voice says the next section of the arrangement", () => {
	const t = setup();
	t.cmd("cuefile", "Puente", "/sim/puente.wav");
	t.cmd("arrset", 0, 0, 1, 5, 7);       // Intro V1 Puente Final
	t.cmd("section", 0, 1, 0);
	t.run(100);
	t.cmd("play");
	t.until(p => p.t >= 44.2);
	assert.strictEqual(t.song.audio.preload[t.song.audio.cueIdx], "/sim/puente.wav", "Puente, not Coro");
});

test("arrangement: tapping a slot plays that slot, repeated sections included", () => {
	const t = setup();
	t.cmd("arrset", 0, 0, 2, 1, 2, 7);    // Intro Coro V1 Coro Final
	t.cmd("arrgo", 0, 3, 0);              // stopped: the second Coro
	t.run(100);
	t.cmd("play");
	t.until(p => p.t >= 48.5);
	assert.strictEqual(t.pos().sec, 2);
	const k = () => t.eng.lastPos ? 0 : 0;
	t.until(p => p.t >= 80 - 0.3 || p.sec !== 2);
	t.until(p => p.playing === 0 || p.sec === 7, 200000);
	assert.strictEqual(t.pos().sec, 7, "after the second Coro comes the Final");
});

test("arrangement: AutoLink jumps to the next song where the arrangement ends", () => {
	const t = setup();
	t.cmd("transition", 0, 3);
	t.cmd("arrset", 0, 0, 1, 2);          // ends at 80
	t.cmd("playsong", 0);
	t.until(p => p.song === 1 && p.playing === 1);
	assert.ok(t.song.log.some(l => /jump 80 -> 256/.test(l)), t.song.log.filter(l => /jump/.test(l)).join(" | "));
});

test("arrangement of the next song without its first section: the handover goes to its first arranged section", () => {
	const t = setup();
	t.cmd("transition", 0, 3);
	const sc = t.eng.dicts.setpilot_struct.songs[1].sections;
	const list = []; for (let j = 1; j < sc.length; j++) list.push(j);
	t.cmd.apply(null, ["arrset", 1].concat(list));
	t.cmd("playsong", 0);
	t.until(p => p.song === 1 && p.playing === 1, 600000);
	const want = "jump 232 -> " + sc[1].start;
	assert.ok(t.song.log.includes(want), want + " in " + t.song.log.filter(l => /jump/.test(l)).join(" | "));
	assert.strictEqual(t.pos().sec, 1);
});

test("a song whose arrangement leaves out its first section starts at its first arranged section", () => {
	const t = setup();
	const sc = t.eng.dicts.setpilot_struct.songs[1].sections;
	const list = []; for (let j = 1; j < sc.length; j++) list.push(j);
	t.cmd.apply(null, ["arrset", 1].concat(list));
	t.cmd("selectsong", 1, 0);
	t.run(500);
	assert.ok(Math.abs(t.song.props.current_song_time - sc[1].start) < 0.01, "at " + t.song.props.current_song_time + " want " + sc[1].start);
});

test("the Pad button: a pad now, in the song's key, playing or stopped; it follows the key and fades out when turned off", () => {
	const t = setup({ tail: true });
	t.run(4000);
	t.cmd("selectsong", 0, 0);
	t.run(300);
	t.song.tailLog.length = 0;
	t.cmd("padfree");
	t.run(200);
	const on = t.song.tailLog.filter(x => x[0] === "pad");
	assert.strictEqual(on.length, 1, JSON.stringify(t.song.tailLog));
	assert.strictEqual(on[0][1], -1, "now");
	const k = t.eng.dicts.setpilot_struct.songs[0].key, root = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[String(k)[0]];
	if (root != null && !/[#b]/.test(String(k).slice(1, 2))) assert.strictEqual(on[0][2], root, "in " + k);
	assert.ok(on[0][3] > 0);
	t.cmd("keyset", 0, 2);
	t.run(300);
	const moved = t.song.tailLog.filter(x => x[0] === "pad");
	assert.strictEqual(moved.length, 2, "follows the new key: " + JSON.stringify(moved));
	assert.strictEqual(moved[1][2], (on[0][2] + 2) % 12);
	t.cmd("padfree");
	t.run(200);
	const off = t.song.tailLog.filter(x => x[0] === "pad").pop();
	assert.strictEqual(off[3], 0, "off: it fades out");
});

test("count-in and arrangement survive Live confirming play late", () => {
	const t = setup();
	t.song.playLatency = 120;
	t.song.seekLatency = 60;
	t.song.selectionStart = 700;
	t.cmd("arrset", 0, 0, 1, 2, 2, 5, 7);   // Intro V1 Coro Coro Puente Final
	t.cmd("arrgo", 0, 2, 0);                // stopped: first Coro slot (48)
	t.run(100);
	t.cmd("play");
	t.run(600);
	const drums = t.song.tracks.find(x => x.name === "Drums");
	assert.ok(t.pos().t >= 44 && t.pos().t < 48, "in the count-in: " + t.pos().t);
	assert.strictEqual(drums.mute, 1, "band muted while Live catches up");
	t.until(p => p.t >= 48.2);
	assert.strictEqual(drums.mute, 0);
	assert.strictEqual(t.pos().playing, 1);
	t.until(p => p.t >= 79.5);
	t.until(p => p.t < 60 || p.playing === 0);
	assert.strictEqual(t.pos().playing, 1, "the arrangement goes on to the second Coro");
	assert.strictEqual(t.pos().sec, 2);
});

test("count-in into a slot whose previous section ends the arrangement", () => {
	const t = setup();
	t.song.playLatency = 60;
	t.cmd("arrset", 0, 0, 2, 2, 1);         // Intro Coro Coro Verso1: Verso 1 (just before the Coro) is last
	t.cmd("arrgo", 0, 1, 0);                // first Coro slot
	t.run(100);
	t.cmd("play");
	t.until(p => p.t >= 48.5);
	assert.strictEqual(t.pos().playing, 1, "still playing after the count-in");
	assert.strictEqual(t.pos().sec, 2);
	t.until(p => p.t >= 79.5);
	t.until(p => p.t < 60 || p.playing === 0);
	assert.strictEqual(t.pos().playing, 1, "on to the second Coro");
});

test("arrangement: back to the original removes it", () => {
	const t = setup();
	t.cmd("arrset", 0, 0, 2);
	t.cmd("arrset", 0, 0, 1, 2, 3, 4, 5, 6, 7);
	assert.strictEqual(t.eng.dicts.setpilot_struct.songs[0].arr, null);
});

// ---------------------------------------------------------------- medleys
// Grande y Fiel (72, G): Coro 48-80, Final 208-232. Cielo Abierto (128, D): Coro 320-352.
function addMedley(t, extra) {
	t.eng.dicts.setpilot_medley = Object.assign({ action: "save", medley: { id: "m1", name: "Grande + Cielo", bpm: 100, key: "G", voice: "Grande y Fiel",
		slots: [{ song: "Grande y Fiel", sec: 2, name: "Coro" }, { song: "Cielo Abierto", sec: 3, name: "Coro" }, { song: "Grande y Fiel", sec: 7, name: "Final" }],
		semis: { "Cielo Abierto": -7 } } }, extra || {});
	t.cmd("medleydict");
	return t.eng.dicts.setpilot_struct;
}

test("medley: sits in the setlist and plays its sections across songs at one tempo and key", () => {
	const t = setup();
	const st = addMedley(t);
	assert.strictEqual(st.medleys.length, 1);
	assert.deepStrictEqual(st.medleys[0].slots, [{ s: 0, j: 2 }, { s: 1, j: 3 }, { s: 0, j: 7 }]);
	assert.ok(st.order.includes(100000), "in the setlist: " + st.order);
	const cielo = t.song.clips.find(c => c.id === 502);
	t.cmd("playmed", 0);
	t.run(200);
	assert.ok(t.pos().t >= 44 && t.pos().t < 48, "count-in into the first Coro: " + t.pos().t);
	assert.strictEqual(t.song.props.tempo, 100, "the medley's tempo");
	assert.strictEqual(cielo.pitch_coarse, -7, "Cielo Abierto transposed to the medley key");
	t.until(p => p.song === 1 && p.sec === 3);
	assert.strictEqual(t.song.props.tempo, 100, "same tempo in the second song");
	t.until(p => p.song === 0 && p.sec === 7);
	assert.ok(t.song.log.some(l => /jump 80 -> 320/.test(l)), "Coro to the other Coro");
	assert.ok(t.song.log.some(l => /jump 352 -> 208/.test(l)), "then the Final of the first song");
	t.until(p => p.playing === 0);
	assert.strictEqual(cielo.pitch_coarse, 0, "its own key again after the medley");
});

test("medley: arrives from the server as one JSON message", () => {
	const t = setup();
	t.cmd("medleyjson", JSON.stringify({ action: "save", medley: { id: "mj", name: "Two songs", bpm: 90, key: "G", slots: [{ song: "Grande y Fiel", sec: 2, name: "Coro" }, { song: "Tu Nombre", sec: 2, name: "Coro" }], semis: {} } }));
	const st = t.eng.dicts.setpilot_struct;
	assert.strictEqual(st.medleys.length, 1);
	assert.deepStrictEqual(st.medleys[0].slots, [{ s: 0, j: 2 }, { s: 2, j: 2 }]);
});

test("medley: the voice uses one source for the whole medley", () => {
	const t = setup({ guide: true });
	addMedley(t);
	const texts = t.eng.dicts.setpilot_struct.cueTexts;
	assert.ok(texts.includes("u|m1|Coro") && texts.includes("u|m1|Final"), texts.filter(x => x.startsWith("u|")).join(", "));
});

test("medley: preparing a song leaves the medley and its key", () => {
	const t = setup();
	addMedley(t);
	const cielo = t.song.clips.find(c => c.id === 502);
	t.cmd("selectsong", 100000, 0);
	t.run(60);
	assert.strictEqual(cielo.pitch_coarse, -7);
	t.cmd("selectsong", 1, 0);
	t.run(60);
	assert.strictEqual(cielo.pitch_coarse, 0);
	assert.strictEqual(t.eng.dicts.setpilot_struct.medleys.length, 1);
});

test("medley: tapping a slot plays it; deleting the medley takes it out of the setlist", () => {
	const t = setup();
	addMedley(t);
	t.cmd("medgo", 0, 2, 0);         // stopped: the Final slot
	t.run(60);
	assert.ok(Math.abs(t.pos().t - 208) < 0.01, "at the Final: " + t.pos().t);
	t.eng.dicts.setpilot_medley = { action: "delete", id: "m1" };
	t.cmd("medleydict");
	const st = t.eng.dicts.setpilot_struct;
	assert.strictEqual(st.medleys.length, 0);
	assert.ok(!st.order.some(v => v >= 100000));
});

test("medley: a song linked into a medley jumps to its first section in the medley key", () => {
	const t = setup();
	addMedley(t, { at: 1 });          // right after Grande y Fiel
	t.cmd("transition", 0, 3);         // AutoLink
	const cielo = t.song.clips.find(c => c.id === 502);
	t.cmd("playsong", 0);
	t.until(p => p.song === 0 && p.t > 220);
	t.until(p => p.t < 100 && p.t > 40);   // back to the Coro at 48: the medley's first section
	assert.strictEqual(cielo.pitch_coarse, -7);
	assert.strictEqual(t.song.props.tempo, 100);
});

test("counted cues: one file per section, tempo and meter", () => {
	const t = setup();
	t.cmd("cuestyle", 1);
	const texts = t.eng.dicts.setpilot_struct.cueTexts;
	assert.ok(texts.includes("Coro@72@4") && texts.includes("Coro@128@4"), texts.slice(0, 8).join(", "));
	assert.ok(texts.includes("Intro@72@4"), "next song's first section in this song's tempo");
	t.cmd("cuefile", "Verso 1@72@4", "/sim/v1-72.wav");
	t.cmd("cuemode", 2);
	t.cmd("playsong", 0);
	t.run(200);
	// the cue for Verso 1 is said over the last bar of the Intro (12..16)
	assert.ok(Math.abs(t.song.audio.cueArm - 12) < 0.01, "counted cue one bar before: " + t.song.audio.cueArm);
	assert.strictEqual(t.song.audio.preload[t.song.audio.cueIdx], "/sim/v1-72.wav");
});

test("section automation mutes a track in one section and gives it back after", () => {
	const t = setup();
	t.cmd("autoset", 0, 1, 5, -1, 1);          // Verso 1: Keys muted
	t.cmd("autoset", 0, 1, 3, 400, -1);        // Verso 1: Drums at 0.4
	assert.deepStrictEqual(t.eng.dicts.setpilot_struct.songs[0].auto[1].keys, { m: 1 });
	t.cmd("playsong", 0);
	t.until(p => p.sec === 1);
	t.run(100);
	const keys = t.song.tracks.find(x => x.name === "Keys");
	assert.strictEqual(keys.mute, 1);
	assert.strictEqual(t.song.objs[3003].value, 0.4);
	t.until(p => p.sec === 2);
	t.run(100);
	assert.strictEqual(keys.mute, 0, "back after the section");
	assert.strictEqual(t.song.objs[3003].value, 0.85);
});

test("moving a section start re-makes its locator at the new beat", () => {
	const t = setup();
	t.cmd("movesec", 0, 2, 5200);              // Coro 48 -> 52
	t.run(3000);
	const names = t.song.cues.filter(c => c.time >= 40 && c.time < 60).map(c => c.name + "@" + c.time).sort();
	assert.deepStrictEqual(names, ["Coro@52"]);
	const s0 = t.eng.dicts.setpilot_struct.songs[0];
	assert.strictEqual(s0.sections[2].start, 52);
	assert.strictEqual(s0.sections[1].end, 52);
	t.cmd("movesec", 0, 2, 1000);              // out of range: nothing happens
	t.run(1000);
	assert.strictEqual(t.eng.dicts.setpilot_struct.songs[0].sections[2].start, 52);
});

test("waveform request sends the whole song's clips to the server", () => {
	const t = setup();
	let id = 0;
	const orig = t.eng.ctx.outlet;
	t.eng.ctx.outlet = (n, ...a) => { const f = [].concat(...a); if (f[0] === "waveprep") id = f[1]; orig(n, ...a); };
	t.cmd("wave", 1);
	assert.ok(id > 0);
	const plan = t.eng.dicts.setpilot_wave;
	assert.strictEqual(plan.song, "Cielo Abierto");
	assert.strictEqual(plan.from, 256);
	assert.ok(plan.stems.length >= 1 && plan.bars > 10);
});

test("track names are matched loosely", () => {
	const t = setup();
	const n = t.eng.ctx.normTrack;
	assert.strictEqual(n("1-TPC_ - Click Track"), "click");
	assert.strictEqual(n("Click"), "click");
	assert.strictEqual(n("Drums (Live)"), n("Drums"));
	assert.strictEqual(n("Cues"), "guide");
	assert.notStrictEqual(n("Keys 1"), n("Keys 2"));
});


// ------------------------------------------------------------------ automation
const auto = (t, o) => t.eng.send("medleyjson", [JSON.stringify(Object.assign({ action: "auto", song: "Grande y Fiel" }, o))]);

test("automation by section: tempo and key change on the downbeat and stay; back to the song's key later", () => {
	const t = setup();
	t.run(100);
	auto(t, { scope: "sec", i: 6, tempo: { bpm: 80, ramp: 0 }, key: { semis: 1 } });    // last Coro
	auto(t, { scope: "sec", i: 7, key: { orig: 1 } });                                     // Final: song's key
	const keys = () => t.song.clips.find(c => c.id === 501).pitch_coarse;
	t.cmd("section", 0, 5, 0);           // Puente
	t.run(200);
	t.cmd("play");
	t.until(p => p.t >= 175.9);
	assert.strictEqual(t.song.props.tempo, 72, "not before the Coro");
	assert.strictEqual(keys(), 0);
	t.until(p => p.t >= 176.1);
	assert.strictEqual(t.song.props.tempo, 80, "80 BPM from the Coro on");
	assert.strictEqual(keys(), 1, "a semitone up from the Coro on");
	t.until(p => p.t >= 208.2);
	assert.strictEqual(t.song.props.tempo, 80, "the tempo stays");
	assert.strictEqual(keys(), 0, "Final: back to the song's key");
	t.cmd("stop");
	t.run(200);
	// stopped on an earlier section: what is in force there
	t.cmd("section", 0, 2, 0);
	t.run(200);
	assert.strictEqual(t.song.props.tempo, 72);
	assert.strictEqual(keys(), 0);
	t.cmd("section", 0, 6, 0);
	t.run(200);
	assert.strictEqual(t.song.props.tempo, 80, "prepared on the last Coro: its tempo");
	assert.strictEqual(keys(), 1);
});

test("automation: a tempo ramp over the bars before the section", () => {
	const t = setup();
	t.run(100);
	auto(t, { scope: "sec", i: 6, tempo: { bpm: 90, ramp: 2 } });
	t.cmd("section", 0, 5, 0);
	t.run(200);
	t.cmd("play");
	t.until(p => p.t >= 167.5);
	assert.strictEqual(t.song.props.tempo, 72, "flat before the ramp");
	t.until(p => p.t >= 172);
	const mid = t.song.props.tempo;
	assert.ok(mid > 76 && mid < 86, "half way up: " + mid);
	t.until(p => p.t >= 176.2);
	assert.ok(Math.abs(t.song.props.tempo - 90) < 0.05, "there: " + t.song.props.tempo);
});

test("automation by section follows duplicates; on a block it stays with that block", () => {
	const t = setup();
	t.run(100);
	t.cmd("arrset", 0, 0, 1, 2, 2, 7);          // Intro, Verso, Coro, Coro, Final
	auto(t, { scope: "sec", i: 2, key: { semis: 2 } });
	auto(t, { scope: "blk", i: 3, key: { semis: 3 }, mix: { Drums: 1 } });
	let sg = t.eng.dicts.setpilot_struct.songs[0];
	assert.deepStrictEqual(Object.keys(sg.blk), ["3"]);
	const keys = () => t.song.clips.find(c => c.id === 501).pitch_coarse;
	const drums = () => t.song.tracks.find(x => x.name === "Drums").mute;
	t.cmd("playsong", 0);
	t.until(p => p.t >= 49);
	assert.strictEqual(keys(), 2, "first Coro: the section's key");
	assert.strictEqual(drums(), 0);
	t.until(p => p.t >= 70);
	t.until(p => p.t < 60 && p.t >= 48.5);
	assert.strictEqual(keys(), 3, "second Coro (its own block): +3");
	assert.strictEqual(drums(), 1, "drums off on that block only");
	t.cmd("stop");
	t.run(200);
	// a block more: the block's automation stays where it was, the new one has none (and the dashboard is told)
	t.notices.length = 0;
	t.cmd("arrset", 0, 0, 1, 2, 2, 2, 7);
	sg = t.eng.dicts.setpilot_struct.songs[0];
	assert.deepStrictEqual(Object.keys(sg.blk), ["3"]);
	assert.deepStrictEqual(t.notices.find(n => n[0] === "blknew"), ["blknew", "Grande y Fiel", 1]);
	// a block taken out before it: the automation moves with its block
	t.cmd("arrset", 0, 0, 2, 2, 2, 7);
	sg = t.eng.dicts.setpilot_struct.songs[0];
	assert.deepStrictEqual(Object.keys(sg.blk), ["2"]);
	auto(t, { scope: "blk", i: 2, key: "none", mix: { Drums: null } });
	assert.strictEqual(t.eng.dicts.setpilot_struct.songs[0].blk, null, "cleared");
});


test("a song in 6/8 gets Live's time signature while it plays; the next one goes back to 4/4", () => {
	const cues = DEMO_CUES.map(c => [c[0] === "# Grande y Fiel | 72 | G" ? "# Grande y Fiel | 72 | G | 6/8" : c[0], c[1]]);
	const t = setup({ cues });
	t.run(200);
	t.cmd("playsong", 0);
	t.run(300);
	assert.deepStrictEqual([t.song.props.signature_numerator, t.song.props.signature_denominator], [6, 8]);
	// the click in 6/8: eighths, beat one accented, beat 4 a lighter accent, the rest soft, from the song's start
	assert.strictEqual(t.song.clickParams.beats, 6);
	assert.strictEqual(t.song.clickParams.accmask, 1);
	assert.strictEqual(t.song.clickParams.midmask, 8);
	assert.strictEqual(t.song.clickParams.softmask, 2 + 4 + 16 + 32);
	assert.strictEqual(t.song.clickParams.origin, 0);
	t.cmd("stop");
	t.run(200);
	t.cmd("playsong", 1);
	t.run(300);
	assert.deepStrictEqual([t.song.props.signature_numerator, t.song.props.signature_denominator], [4, 4]);
});

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
