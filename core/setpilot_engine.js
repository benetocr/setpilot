// SetPilot engine: runs inside Max's [js] object in a Max for Live device.
// Reads the Arrangement locators, tracks the playhead and performs the
// section jumps, loops and song changes requested from the dashboard.
//
// Locator convention
//   "# Song title | 72 | G"  start of a song (BPM, key and meter are optional)
//   "Intro", "Verso 1", ...  start of a section of the current song
//   "STOP" / "FIN" / "END"   end of the current song (optional)
//
// Timing-critical work happens here, next to the Live API. The dashboard only
// says WHAT should happen next; Live decides WHEN, because every jump is a
// locator jump quantized to the bar.
//
// Voice cues: the Guide stem of a multitrack announces the NEXT section in the
// timeline, which is wrong as soon as you jump or loop. SetPilot knows what
// really comes next, so it speaks that section's name on the downbeat of the
// last bar before the change (scheduled with [timepoint] in the patch) and
// gates the original Guide when it would say something else.
//   outlet 0 -> server (dashboard)     outlet 1 -> cue player in this patch
//
// Companion devices, each on its own track so it gets its own output:
//   SetPilot Click  (receive "setpilot_click")  consistent click, synced to Live
//   SetPilot Guide  (receive "setpilot_gate")   sample-accurate gate on the Guide
//   SetPilot Tail   (receive "setpilot_tail")   plays the end of a song for
//                   Overlap and Crossfade transitions
// They answer pings with "clickhello"/"gatehello"/"tailhello" + their track id.
//
// Transitions (per song, what happens when it ends), as in Playback:
//   1 Cue Next Song  stop, ready at the start of the next song
//   2 Stay In Song   stop, ready at the start of the same song
//   3 AutoLink       the next song starts right away (the gap is skipped)
//   4 Overlap        the next song starts while this one still rings out
//   5 Crossfade      this one fades out over 5 seconds while the next fades in

autowatch = 0;
inlets = 1;
outlets = 2;

var STRUCT_DICT = "setpilot_struct";
var STORE_DICT = "setpilot_store";
var TICK_MS = 20;
// how long Live takes to carry out what we ask, in seconds. Zero inside Max
// (LiveAPI writes are immediate); the app measures it through its bridge
// and sends "latency <ms>" so timed changes are asked for that much earlier.
var writeLead = 0;
// The app's Live bridge can add, name and delete a locator as one safe step
// ("add_cue" / "delete_cue"); inside Max we do it ourselves, tick by tick.
var cueOps = 0;
function cueops(v) { cueOps = num(v) ? 1 : 0; log("locator steps by the bridge: " + (cueOps ? "on" : "off")); }
var QUANT_ONE_BAR = 4; // clip_trigger_quantization enum: 4 = 1 Bar

var song = null;      // LiveAPI on live_set
var cueApi = null;    // reusable LiveAPI pointed at one cue point
var observers = [];
var task = null;

var songs = [];       // parsed structure
var order = [];       // setlist order (indices into songs)
var structSig = "";
var structVersion = 0;
var dirty = true;
var lastScan = 0;

// live state mirrored by observers
var playing = 0, tempo = 120, sigNum = 4, sigDen = 4, liveLoop = 0;
var t = 0, lastT = 0;

// SetPilot state
var curSong = -1, curSec = -1;
var armSong = -1;       // song shown/prepared while stopped
var pendingSong = -1;   // song chosen to follow the current one
var queue = null;       // {song, sec, now, loop, fired, firedAt, savedQuant}
var loopState = null;   // {song, sec, once}
var autoStop = 1;
var lastSent = "";
var clock = 0;          // ms counter from ticks

// voice cues
var CUE_OFF = 0, CUE_FIX = 1, CUE_ALL = 2;
var cueMode = CUE_ALL;  // 0 off, 1 fix the original Guide, 2 SetPilot speaks every cue
// whether anything can play SetPilot's own cue voice. Always inside Max; in
// the app only once its audio plugin is there. Without it the song's Guide
// must never be muted, or nobody would hear any cue at all.
var voicePlayer = 1;
var cueBars = 1;        // bars of anticipation
var cueLang = 2;        // 0 auto, 1 Spanish, 2 English (used by the server's voice)
var cueMap = {};        // spoken text -> sfplay~ cue number
var cueNext = 2;        // sfplay~ reserves 1
var armedKey = null;
var lastPlanMsg = "";
var gateNow = 1;        // gain applied to the track this device sits on
var GUIDE_RE = /^(guide|gu[ií]a|cues?|voice ?cues?|vocal ?cues?)\b/i;
var CLICK_RE = /^(click|clic|metronome|metr[oó]nomo)\b/i;
var NONPITCH_RE = /(click|clic|metronome|metr[oó]nomo|guide|gu[ií]a|\bcues?\b|count|drum|kick|snare|hi ?hat|\bhh\b|perc|shaker|tamb|cymbal|crash|ride|\btoms?\b|clap|bater[ií]a|bombo|redoblante)/i;
var trackApi = null, clipApi = null;
var ownTrackId = 0, guideIds = [], guideNames = [], clickIds = [], clickNames = [];
var mutedGuide = {}, mutedClick = {};
var gateTrackId = 0, gateSeen = -99999, clickTrackId = 0, clickSeen = -99999, lastPing = -99999;

// click settings (sent to SetPilot Click)
var click = { on: 1, sound: 0, sub: 1, accents: [2, 1, 1, 1], acc: 100, beat: 75, subl: 45, gain: 80, muteSong: 1 };

// per song tempo and key: name -> { bpm: 0 (= original) | bpm, semis: 0 }
var songOpts = {};
var baseCache = {};
var tempoOverridden = false;
var lastEntered = -1;
var lastTrackScan = -99999;
var pendingKeys = false;
var FAR = [9999, 1, 0];

// transitions
var TR_CUE = 1, TR_STAY = 2, TR_LINK = 3, TR_OVERLAP = 4, TR_XFADE = 5;
var trDefault = TR_CUE;
var XFADE_SEC = 5;
var tailTrackId = 0, tailSeen = -99999;
var TAIL_DICT = "setpilot_tail";
var tails = {};         // song name -> { sig, path, from, to, ref }
var tailJob = null;     // { id, name, sig, from, to, ref, at }
var tailJobId = 0;
var tailDirty = true;
var tailCheckAt = 0;
var tailPlayingUntil = 0;
var warnedTail = {};
var ramp = null;        // crossfade fade-in of the next song: { list, at, ms }
var paramApi = null;

// practice and show helpers
var precountBars = 1;   // bars of count-in when playback starts after the first section (1 or 2)
var cueStyle = 0;       // 0: "Chorus"   1: "Chorus, two, three, four"
var cueSource = 1;      // 1: the song's own guide when it has the cue, 0: always the Mac voice
var GUIDE_DICT = "setpilot_guide";
var guideSent = {}, guideAt = 0;
var warpGuard = { at: 0, rr: 0, fixing: null, soon: [], gaveUp: {} };
var pre = null;         // count-in in progress: { song, sec, S, ids }
var fade = null;        // band fade in progress: { list, start, at, ms, dir }
var faded = null;       // band faded out (or fading): [{ id, orig }]
var autoState = {};     // track id -> { vol, mute } before section automation changed it
var autoAt = "";
var WAVE_DICT = "setpilot_wave";
var arrCur = null;      // where the playhead is in the song's arrangement: { song, k, sec }
// Medleys: an ordered list of sections from any songs, with one tempo and one
// key. They sit in the setlist like songs (as MED + their index in "order").
var MED = 100000, MED_DICT = "setpilot_medley", MED_TAG = "\u0001medley:";
var medleys = [];       // { id, name, bpm, key, voice, tr, slots: [{ song, sec, name }], semis: { songName: n } }
var med = null;         // the medley that is prepared or playing: { i, k }
var medKeysOn = -1;     // medley whose transposition is applied to its songs
var annSaid = null;     // the song name last announced: { text, at, B }
var arrHint = null;     // arrangement slot chosen while stopped: { song, k }
var lastPosT = -1, lastPosAt = 0;
var waveId = 0;
// mixer for the dashboard
var MIX_DICT = "setpilot_mixer";
var mix = { tracks: [], ids: "", sig: "", at: -99999, meterUntil: 0, meterAt: 0, dirty: true };
var mixApi = null;

// instruments: what each track is, and where each kind of instrument goes
var INSTR = ["click", "guide", "drums", "perc", "bass", "eg", "ag", "keys", "synth", "strings", "vox", "loops", "other"];
var INSTR_RE = [
	["click", /\b(click|clic|metronome|metronomo)\b/],
	["guide", /\b(guide|guides|guia|cues?|vocal cues)\b/],
	["drums", /\b(drums?|drum kit|kick|snare|hats?|hihat|hh|toms?|overheads?|oh|cymbals?|bateria|bombo|redoblante)\b/],
	["perc", /\b(perc\w*|shakers?|tamb\w*|congas?|bongos?|claps?|cajon|cowbell)\b/],
	["bass", /\b(bass\w*|bajo|sub)\b/],
	["ag", /\b(ag\d*|acoustic|acustica|acustico|acgtr)\b/],
	["eg", /\b(eg\d*|electric|elec|guitars?|gtrs?|guitarra)\b/],
	["keys", /\b(keys?|piano|rhodes|wurli\w*|organ|organo|b3|teclados?|ep)\b/],
	["synth", /\b(synth\w*|pads?|arp\w*|lead synth)\b/],
	["strings", /\b(strings?|violin\w*|cellos?|violas?|orch\w*|brass|horns?|cuerdas|trumpets?)\b/],
	["vox", /\b(vox|vocals?|bgvs?|bv|alto|altos|tenors?|sopranos?|choir|voz|voces|harmony|harm|lead vocal)\b/],
	["loops", /\b(loops?|tracks?|fx|sfx|ambient|drones?|seq\w*|textures?)\b/]
];
// SetPilot's own channels get an output too; unset, Click goes with the click
// tracks and Cues with the guide
var SPK = ["spclick", "spcues", "sptail"];
var SPK_FOLLOW = { spclick: "click", spcues: "guide", sptail: "" };
var instr = { tracks: {}, outputs: {} };   // tracks: normName -> kind; outputs: kind -> { type, chan } by display name
var routes = { list: [], at: 0 };          // output choices offered in the dashboard
var ROUTE_DICT = "setpilot_routes";

function guessInstr(name) {
	var n = normTrack(name).replace(/(\D)(\d)/g, "$1 $2");
	for (var i = 0; i < INSTR_RE.length; i++) if (INSTR_RE[i][1].test(n)) return INSTR_RE[i][0];
	return "other";
}

function instrOf(name) {
	return instr.tracks[normTrack(name)] || guessInstr(name);
}
var needStore = false;

// ------------------------------------------------------------------ helpers

function log() {
	var a = [];
	for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
	post("SetPilot: " + a.join(" ") + "\n");
	try { outlet(0, "log", a.join(" ")); } catch (e) { }
}

function guard(name, fn) {
	return function () {
		try { return fn.apply(this, arguments); }
		catch (e) { log("error in " + name + ": " + e.message + (e.lineNumber ? " (line " + e.lineNumber + ")" : "")); }
	};
}

function num(v) {
	if (v instanceof Array) v = v[0];
	var n = parseFloat(v);
	return isNaN(n) ? 0 : n;
}

function str(v) {
	var s = (v instanceof Array) ? v.join(" ") : String(v);
	return s.replace(/^"(.*)"$/, "$1");
}

function barLen() {
	return sigNum * 4 / (sigDen || 4);
}

function getProp(p) { return song.get(p); }
function setProp(p, v) { song.set(p, v); }

function jumpToCue(id) {
	cueApi.id = id;
	cueApi.call("jump");
}

// ------------------------------------------------------------------ setup

function bang() { init(); }
function loadbang() { /* LiveAPI is not ready until live.thisdevice bangs */ }

function init() { guard("init", initImpl)(); }
function initImpl() {
	log("init");
	song = new LiveAPI(null, "live_set");
	if (!song || !song.id || song.id == 0) {
		log("Live API not ready yet");
		return;
	}
	cueApi = new LiveAPI(null, "live_set");
	importDict = new Dict(IMPORT_DICT);
	trackApi = new LiveAPI(null, "live_set");
	clipApi = new LiveAPI(null, "live_set");
	paramApi = new LiveAPI(null, "live_set");
	mixApi = new LiveAPI(null, "live_set");

	observers = [];
	observe("is_playing", function (v) { playing = num(v); });
	observe("tempo", function (v) { tempo = num(v); });
	observe("signature_numerator", function (v) { sigNum = num(v) || 4; dirty = true; });
	observe("signature_denominator", function (v) { sigDen = num(v) || 4; dirty = true; });
	observe("loop", function (v) {
		liveLoop = num(v);
		if (!liveLoop) loopState = null;
	});
	observe("cue_points", function () { dirty = true; });

	// a new connection numbers Live's objects anew: forget ids from before
	mutedGuide = {}; mutedClick = {};
	mix.tracks = []; mix.ids = ""; mix.sig = ""; mix.curve = null; mix.dirty = true;
	loadStore();
	scanTracks();
	applyMode();
	dirty = true;
	if (task) task.cancel();
	task = new Task(guard("tick", tick), this);
	task.interval = TICK_MS;
	task.repeat();
	log("ready");
}

function observe(prop, fn) {
	var o = new LiveAPI(function (args) {
		if (args && args[0] == prop) fn(args.slice(1));
	}, "live_set");
	o.property = prop;
	observers.push(o);
}

// ------------------------------------------------------------------ structure

var KEY_RE = /^[A-G](#|b)?m?$/;

function parseHeader(name) {
	var parts = name.replace(/^#\s*/, "").split("|");
	var info = { title: parts[0].replace(/\s+$/, "") || "Untitled", bpm: 0, key: "", meter: "" };
	for (var i = 1; i < parts.length; i++) {
		var p = parts[i].replace(/^\s+|\s+$/g, "");
		var m;
		if ((m = p.match(/^(\d+(\.\d+)?)\s*(bpm)?$/i))) info.bpm = parseFloat(m[1]);
		else if (/^\d+\/\d+$/.test(p)) info.meter = p;
		else if (KEY_RE.test(p)) info.key = p;
	}
	return info;
}

function isStop(name) {
	return /^(stop|fin|end|final de canci[oó]n)$/i.test(name.replace(/^\s+|\s+$/g, ""));
}

function readCues() {
	var raw = getProp("cue_points") || [];
	var cues = [];
	for (var i = 0; i < raw.length; i++) {
		if (raw[i] == "id") {
			var id = raw[i + 1];
			cueApi.id = id;
			cues.push({ id: id, name: str(cueApi.get("name")), time: num(cueApi.get("time")) });
			i++;
		}
	}
	cues.sort(function (a, b) { return a.time - b.time; });
	return cues;
}

function setEnd() {
	var e = 0;
	try { e = num(getProp("last_event_time")); } catch (err) { e = 0; }
	if (!e) e = num(getProp("song_length"));
	return e;
}

function buildSongs(cues, endOfSet) {
	var out = [];
	var hasHeaders = false;
	for (var i = 0; i < cues.length; i++) if (/^#/.test(cues[i].name)) hasHeaders = true;

	var cur = null;
	function startSong(title, cue, info) {
		if (cur && cur.end == null) cur.end = cue ? cue.time : cur.start;
		cur = {
			name: title, start: cue ? cue.time : 0, end: null, cue: cue ? cue.id : 0,
			bpm: info ? info.bpm : 0, key: info ? info.key : "", meter: info ? info.meter : "",
			sections: [], stopAt: null
		};
		out.push(cur);
	}

	if (!hasHeaders && cues.length) startSong("Full set", null, null);

	for (var j = 0; j < cues.length; j++) {
		var c = cues[j];
		if (/^#/.test(c.name)) {
			var info = parseHeader(c.name);
			if (cur && cur.stopAt == null) cur.end = c.time;
			startSong(info.title, c, info);
		} else if (isStop(c.name)) {
			if (cur && cur.stopAt == null) { cur.stopAt = c.time; cur.end = c.time; }
		} else if (cur && cur.stopAt == null) {
			cur.sections.push({ name: c.name, start: c.time, cue: c.id });
		}
		else if (!cur) {
			// locators before the first "#" header: keep them as an untitled song
			startSong("Untitled", { time: 0, id: c.id }, null);
			cur.sections.push({ name: c.name, start: c.time, cue: c.id });
		}
	}
	if (cur && cur.end == null) cur.end = Math.max(endOfSet, cur.start + barLen() * 4);
	if (!hasHeaders && out.length && cues.length) out[0].cue = cues[0].id;

	for (var k = 0; k < out.length; k++) {
		var s = out[k];
		if (!s.sections.length || s.sections[0].start > s.start + 0.001) {
			var lead = s.sections.length ? s.sections[0].start - s.start : 0;
			s.sections.unshift({ name: !s.sections.length ? "Song" : (lead <= barLen() * 4 + 0.001 ? "Count Off" : "Start"), start: s.start, cue: s.cue, implicit: 1 });
		}
		for (var n = 0; n < s.sections.length; n++) {
			var nx = s.sections[n + 1];
			s.sections[n].end = nx ? nx.start : s.end;
		}
	}
	return out;
}

function rescan(force) {
	var cues = readCues();
	var endOfSet = setEnd();
	var sig = sigNum + "/" + sigDen + "|" + Math.round(endOfSet * 100) + "|";
	for (var i = 0; i < cues.length; i++) sig += cues[i].id + ":" + cues[i].name + "@" + cues[i].time + ";";
	if (!force && sig == structSig) return;
	structSig = sig;

	var prevNames = orderNames();
	if (!order.length) prevNames = [];
	var stored = prevNames.length ? prevNames : storedOrder();

	songs = buildSongs(cues, endOfSet);
	tailDirty = true;
	order = mergeOrder(stored);
	if (armSong >= songs.length) armSong = -1;
	if (pendingSong >= songs.length) pendingSong = -1;
	queue = null;
	publishStruct();
}

function mergeOrder(names) {
	var used = {}, usedM = {}, res = [];
	for (var i = 0; i < names.length; i++) {
		var nm = String(names[i]);
		if (nm.indexOf(MED_TAG) == 0) {
			var mi = medIndex(nm.slice(MED_TAG.length));
			if (mi >= 0 && !usedM[mi]) { usedM[mi] = 1; res.push(MED + mi); }
			continue;
		}
		for (var j = 0; j < songs.length; j++) {
			if (!used[j] && songs[j].name == nm) { used[j] = 1; res.push(j); break; }
		}
	}
	for (var k = 0; k < songs.length; k++) if (!used[k]) res.push(k);
	for (var m = 0; m < medleys.length; m++) if (!usedM[m]) res.push(MED + m);
	return res;
}

// the setlist by names (medleys by their id), to keep it across rescans and sessions
function orderNames() {
	var names = [];
	for (var i = 0; i < order.length; i++) {
		var v = order[i];
		if (v >= MED) { if (medleys[v - MED]) names.push(MED_TAG + medleys[v - MED].id); }
		else if (songs[v]) names.push(songs[v].name);
	}
	return names;
}

function publishStruct() {
	structVersion++;
	for (var si = 0; si < songs.length; si++) {
		var o = opt(si);
		songs[si].tempoSet = o.bpm;
		songs[si].semis = o.semis;
		songs[si].baseBpm = baseBpm(si);
		songs[si].tr = o.tr || 0;
		songs[si].auto = o.auto || null;
		songs[si].arr = arrOf(si);
		songs[si].trEff = trMode(si);
		songs[si].med = o.med ? { id: o.med.id, key: o.med.key, parts: o.med.parts, seams: o.med.seams, spec: o.med.spec } : null;
	}
	var obj = {
		version: structVersion, songs: songs, order: order, medleys: medPublic(),
		meter: [sigNum, sigDen], autoStop: autoStop, trDefault: trDefault,
		cueTexts: cueTexts(),
		cueLoaded: loadedCues(),
		settings: { cueMode: cueMode, cueBars: cueBars, cueLang: cueLang, precount: precountBars, cueStyle: cueStyle, cueSource: cueSource },
		click: click,
		companions: { click: clickPresent() ? 1 : 0, gate: gatePresent() ? 1 : 0, tail: tailPresent() ? 1 : 0 },
		guide: { tracks: guideNames, clicks: clickNames }
	};
	var d = new Dict(STRUCT_DICT);
	d.parse(JSON.stringify(obj));
	outlet(0, "struct", structVersion);
	outlet(0, "status", songs.length + (songs.length == 1 ? " song" : " songs") + " in this set");
	lastSent = "";
}

// the server calls this when it starts: anything sent before it was ready was lost
function hello() {
	if (!song) return;
	publishStruct();
}

// ------------------------------------------------------------------ store
// The server keeps the setlist order in a small file per set (keyed by the
// song names): the engine sends "store <json>" and gets "restore <json>" back
// when the same set is opened again.

var restored = null;
var lastStored = "";

function storedOrder() {
	if (restored && restored.order) return restored.order;
	try {
		var d = new Dict(STORE_DICT);
		var s = d.get("order");
		if (s) return JSON.parse(str(s));
	} catch (e) { }
	return [];
}

function loadStore() {
	if (!restored) return;
	if (restored.autostop !== undefined) autoStop = restored.autostop ? 1 : 0;
	trDefault = restored.trDefault || (autoStop ? TR_CUE : TR_LINK);
	if (restored.cueMode !== undefined) cueMode = restored.cueMode;
	if (restored.cueBars !== undefined) cueBars = restored.cueBars;
	if (restored.cueLang !== undefined) cueLang = restored.cueLang;
	if (restored.precount !== undefined) precountBars = Math.max(1, Math.min(2, restored.precount || 1));
	if (restored.cueStyle !== undefined) cueStyle = restored.cueStyle;
	if (restored.cueSource !== undefined) cueSource = restored.cueSource ? 1 : 0;
	if (restored.medleys && restored.medleys.length !== undefined) medleys = restored.medleys;
	if (restored.click) for (var k in restored.click) if (restored.click.hasOwnProperty(k)) click[k] = restored.click[k];
	if (restored.songs) {
		// merge: what this session already knows (a fresh import's warp reference) is kept
		var merged = restored.songs;
		for (var nm in songOpts) {
			if (!songOpts.hasOwnProperty(nm)) continue;
			if (!merged[nm]) { merged[nm] = songOpts[nm]; continue; }
			if (songOpts[nm].warp && !merged[nm].warp) merged[nm].warp = songOpts[nm].warp;
		}
		songOpts = merged;
	}
	if (restored.instr) {
		if (restored.instr.tracks) instr.tracks = restored.instr.tracks;
		if (restored.instr.outputs) instr.outputs = restored.instr.outputs;
	}
	pendingKeys = true;
}

function restore() {
	var raw = arrayfromargs(arguments).join(" ");
	if (!raw || raw == lastStored) return;
	try { restored = JSON.parse(raw); } catch (e) { log("bad stored data"); return; }
	lastStored = raw;
	loadStore();
	applyMode();
	order = [];
	structSig = "";
	dirty = true;
}

function saveStore() {
	var names = orderNames();
	restored = { order: names, medleys: medleys, autostop: autoStop, trDefault: trDefault, cueMode: cueMode, cueBars: cueBars, cueLang: cueLang, precount: precountBars, cueStyle: cueStyle, cueSource: cueSource, click: click, songs: songOpts, instr: instr };
	var json = JSON.stringify(restored);
	lastStored = json;
	var d = new Dict(STORE_DICT);
	d.set("order", JSON.stringify(names));
	d.set("autostop", autoStop);
	outlet(0, "store", json);
}

// ------------------------------------------------------------------ position

function locate(time) {
	for (var i = 0; i < songs.length; i++) {
		var s = songs[i];
		if (time >= s.start - 0.0001 && time < s.end - 0.0001) {
			for (var j = s.sections.length - 1; j >= 0; j--) {
				if (time >= s.sections[j].start - 0.0001) return [i, j];
			}
			return [i, 0];
		}
	}
	return [-1, -1];
}

function setlistPos(si) {
	for (var i = 0; i < order.length; i++) if (order[i] == si) return i;
	return -1;
}

function nextInSetlist(si) {
	if (pendingSong >= 0 && pendingSong != si) return pendingSong;
	var p = setlistPos(si);
	return (p >= 0 && p + 1 < order.length) ? order[p + 1] : -1;
}

// ------------------------------------------------------------------ actions

function fireJump(cueId) {
	var saved = num(getProp("clip_trigger_quantization"));
	if (saved != QUANT_ONE_BAR) setProp("clip_trigger_quantization", QUANT_ONE_BAR);
	jumpToCue(cueId);
	return saved;
}

function restoreQuant(q) {
	if (q && q.savedQuant != null && q.savedQuant != QUANT_ONE_BAR) {
		setProp("clip_trigger_quantization", q.savedQuant);
	}
}

function setLoop(s, j, once) {
	var sec = songs[s].sections[j];
	setProp("loop_start", sec.start);
	setProp("loop_length", sec.end - sec.start);
	setProp("loop_start", sec.start);
	setProp("loop", 1);
	liveLoop = 1;
	loopState = { song: s, sec: j, once: once ? 1 : 0 };
}

function clearLoop() {
	if (liveLoop) setProp("loop", 0);
	liveLoop = 0;
	loopState = null;
}

function moveTo(time) {
	setProp("current_song_time", time);
	t = lastT = time;
}

function prepareSong(s) {
	if (s >= MED) { prepareMedley(s - MED); return; }
	if (s < 0 || s >= songs.length) return;
	exitMed();
	clearLoop();
	queue = null;
	pendingSong = -1;
	armSong = s;
	arrCur = null;
	arrHint = arrOf(s) ? { song: s, k: 0 } : null;
	moveTo(songEntry(s));
	lastEntered = s;
	applyTempo(s);
	loadTail(s);
}

function startSong(s) {
	prepareSong(s);
	setProp("back_to_arranger", 0);
	startFrom(songEntry(s));
}

// With a selection in the Arrangement, Live starts playing at the selection
// and not where SetPilot left the playhead. Start, then put it right.
var wantStart = null;
function startFrom(time) {
	wantStart = { time: time, at: clock, since: 0, fixes: 0 };
	song.call("continue_playing");
}

function queueSection(s, j, now, loop, arrK) {
	if (s < 0 || s >= songs.length || j < 0 || j >= songs[s].sections.length) return;
	if (!playing) {
		prepareSong(s);
		moveTo(songs[s].sections[j].start);
		if (loop) setLoop(s, j, 0);
		var a0 = arrOf(s);
		if (a0) arrHint = { song: s, k: (arrK != null && a0[arrK] == j) ? arrK : arrFind(a0, j, -1) };
		return;
	}
	if (queue && !queue.fired && !queue.auto && queue.song == s && queue.sec == j && !now && (arrK == null || queue.arrK == arrK)) {
		queue = null; // tapping the queued section again cancels it
		return;
	}
	if (queue && queue.fired) return; // a jump is already in flight
	if (loopState && !(loopState.song == s && loopState.sec == j)) clearLoop();
	queue = { song: s, sec: j, now: now ? 1 : 0, loop: loop ? 1 : 0, fired: 0, from: curSong + ":" + curSec };
	var a = arrOf(s);
	if (a) queue.arrK = (arrK != null && a[arrK] == j) ? arrK : arrFind(a, j, (arrCur && arrCur.song == s) ? arrCur.k : -1);
	pendingSong = (s != curSong) ? -1 : pendingSong;
}

// ------------------------------------------------------------------ tick

function tick() {
	clock += TICK_MS;
	if (dirty || clock - lastScan > 1500) {
		dirty = false;
		lastScan = clock;
		rescan(false);
	}
	lastT = t;
	t = num(getProp("current_song_time"));
	if (wantStart) {
		if (!playing) { if (clock - wantStart.at > 1000) wantStart = null; }
		else {
			if (!wantStart.since) wantStart.since = clock;
			var el = clock - wantStart.since;
			if (wantStart.fixes && el < 160) { /* give Live time to apply the seek */ }
			else {
			var expect = wantStart.time + el * tempo / 60000;
			if (Math.abs(t - expect) > 0.75) {
				log("start moved from " + Math.round(t * 100) / 100 + " to " + wantStart.time);
				setProp("current_song_time", wantStart.time);
				t = lastT = wantStart.time;
				wantStart.since = clock;
				if (++wantStart.fixes > 2) wantStart = null;
			} else if (el > 800) wantStart = null;
			}
		}
	}
	var loc = locate(t);
	curSong = loc[0];
	curSec = loc[1];
	if (curSong >= 0 && playing) armSong = curSong;
	if (playing && curSong >= 0 && curSong != lastEntered && !pre) {
		lastEntered = curSong;
		restoreFade();
		guard("tempo", applyTempo)(curSong);
		tailDirty = true; // fader levels may have changed: refresh this song's tail
		loadTail(curSong);
	}
	if (ramp) guard("ramp", runRamp)();
	if (pre) guard("countin", runCountIn)();
	if (fade) guard("fade", runFade)();
	if (playing && curSong >= 0 && !pre) guard("auto", applyAuto)(curSong, curSec);
	if (curSong >= 0 && !playing && armSong < 0) armSong = curSong;

	if (playing && !wasPlaying) tickLog = 0;
	wasPlaying = playing;
	if (playing && curSong >= 0 && !pre && med) guard("medley", runMed)();
	else if (playing && curSong >= 0 && !pre) guard("arrangement", runArr)();
	if (playing) runTransport();
	guard("medtempo", medTempoTick)();
	guard("listen", listenTick)();
	guard("medpad", medPadTick)();
	if (medPlace) guard("medplace", runMedPlace)();
	if (clock - lastTrackScan > 3000) { lastTrackScan = clock; scanTracks(); }
	if (clock - lastPing > 3000) { lastPing = clock; ping(); }
	if (pendingKeys && songs.length) { pendingKeys = false; guard("keys", applyAllKeys)(); }
	if (job) { runJobSafe(); return; }
	if (clearCues >= 0) { guard("clear", clearCueStep)(); return; }
	if (rewarpQueue.length && !playing) { guard("rewarp", runRewarp)(); return; }
	if (clock - mix.at > (mix.dirty ? 60 : 700)) guard("mixer", pollMixer)();
	if (clock < mix.meterUntil && clock - mix.meterAt >= 40) guard("meters", sendMeters)();
	if (needStore && songs.length && !dirty) { needStore = false; saveStore(); }
	if (clock % 500 < TICK_MS) guard("tails", runTails)();
	if (cueSource && clock - guideAt > 400) { guideAt = clock; guard("guide", runGuides)(); }
	if (!playing && !pre && clock - warpGuard.at > 4000) { warpGuard.at = clock; guard("warpguard", runWarpGuard)(); }
	runCues();
	send();
}

function runTransport() {
	var bl = barLen();

	// repeat-once loops end after the first wrap
	if (loopState && loopState.once && t < lastT - 0.25) clearLoop();

	if (queue) {
		var target = songs[queue.song] && songs[queue.song].sections[queue.sec];
		if (!target) { queue = null; return; }
		if (!queue.fired && curSong == queue.song && curSec == queue.sec && queue.from != curSong + ":" + curSec) {
			landed(); // the timeline got there on its own
		} else if (!queue.fired) {
			var cs = (curSong >= 0) ? songs[curSong].sections[curSec] : null;
			var contiguous = cs && Math.abs(cs.end - target.start) < 0.001 && !queue.now;
			if (contiguous) {
				queue.contiguous = 1; // the timeline already goes there
			} else if (queue.now || !cs || t >= cs.end - bl + 0.05) {
				queue.savedQuant = fireJump(target.cue);
				queue.fired = 1;
				queue.firedAt = clock;
			}
		} else {
			// landed = the playhead is inside the target and it moved discontinuously to get there
			var inTarget = curSong == queue.song && curSec == queue.sec && t - target.start < bl;
			if (inTarget && (lastT > t + 0.01 || lastT < target.start - 0.01)) {
				landed();
			} else if (clock - queue.firedAt > (60000 / tempo) * bl * 2 + 500) {
				log("jump timeout");
				restoreQuant(queue);
				queue = null;
			}
		}
		return;
	}

	if (curSong < 0) return;
	var sg = songs[curSong];
	if (loopState && loopState.song == curSong) return;
	if (med) { medTransport(bl); return; }

	// end of song: what happens depends on the song's transition
	var E = arrEnd(curSong);
	var ho = handoverPlan(curSong);
	var mode = ho ? ho.mode : trMode(curSong);
	if (ho && ho.mode != TR_LINK) {
		if (t < ho.J - 0.02) {
			if (t >= ho.J - bl + 0.05) startHandover(curSong, ho);
			return;
		}
		// too late for the handover (started inside its last bar): AutoLink
		ho = { n: ho.n, sec: ho.sec, J: E, mode: TR_LINK, natural: !ho.sec && E == sg.end && Math.abs(songs[ho.n].start - sg.end) < 0.001 };
	}
	if (ho) {
		// AutoLink: jump to the next song on the downbeat where this one ends
		if (t >= ho.J - bl + 0.05 && !ho.natural) {
			queue = { song: ho.n, sec: ho.sec || 0, now: 0, loop: 0, fired: 0, from: curSong + ":" + curSec };
			if (ho.med == null && arrOf(ho.n)) queue.arrK = 0;
			if (ho.med != null) { queue.medStart = ho.med; medKeys(ho.med); }
			pendingSong = -1;
		}
		return;
	}
	var look = (tempo / 60) * (0.06 + writeLead);
	if (t >= E - look) {
		song.call("stop_playing");
		playing = 0;
		finishRamp();
		restoreFade();
		clearAuto();
		var nxt = nextInSetlist(curSong);
		if (mode == TR_STAY) prepareSong(curSong);
		else if (nxt >= 0) prepareSong(nxt);
		else moveTo(sg.end);
	}
}

// ------------------------------------------------------------------ medleys
function medIndex(id) {
	for (var i = 0; i < medleys.length; i++) if (String(medleys[i].id) == String(id)) return i;
	return -1;
}

// the medley's slots as song and section indices in this set (missing ones skipped)
function medSlots(mi) {
	var m = medleys[mi], out = [];
	if (!m || !m.slots) return out;
	for (var k = 0; k < m.slots.length; k++) {
		var sl = m.slots[k], s = songIndex(sl.song);
		if (s < 0) continue;
		var sc = songs[s].sections, j = parseInt(sl.sec, 10);
		if (!sc[j] || (sl.name && sc[j].name != sl.name)) {
			j = -1;
			for (var q = 0; q < sc.length; q++) if (sc[q].name == sl.name) { j = q; break; }
		}
		if (j >= 0) out.push({ s: s, j: j, k: out.length });
	}
	return out;
}

function medHas(mi, s) {
	var sl = medSlots(mi);
	for (var k = 0; k < sl.length; k++) if (sl[k].s == s) return true;
	return false;
}

function medBpmFor(s) {
	if (!med || !medleys[med.i] || !medleys[med.i].bpm) return 0;
	return medHas(med.i, s) ? medleys[med.i].bpm : 0;
}

function medSemisOf(mi, s) {
	var m = medleys[mi], v = m && m.semis ? m.semis[songs[s].name] : 0;
	return Math.max(-12, Math.min(12, parseInt(v, 10) || 0));
}

// transpose the medley's songs to the medley key (their own settings are kept)
function medKeys(mi) {
	if (medKeysOn == mi) return;
	medKeysOff();
	var sl = medSlots(mi), done = {};
	for (var k = 0; k < sl.length; k++) {
		if (done[sl[k].s]) continue;
		done[sl[k].s] = 1;
		applyKey(sl[k].s, medSemisOf(mi, sl[k].s));
	}
	medKeysOn = mi;
}

function medKeysOff() {
	if (medKeysOn < 0) return;
	var sl = medSlots(medKeysOn), done = {};
	medKeysOn = -1;
	for (var k = 0; k < sl.length; k++) {
		if (done[sl[k].s]) continue;
		done[sl[k].s] = 1;
		applyKey(sl[k].s, opt(sl[k].s).semis || 0);
	}
}

function exitMed() {
	if (!med && medKeysOn < 0) return;
	med = null;
	medKeysOff();
}

function prepareMedley(mi) {
	var sl = medSlots(mi);
	if (!sl.length) return;
	clearLoop();
	queue = null;
	pendingSong = -1;
	if (!med || med.i != mi) exitMed();
	med = { i: mi, k: 0 };
	medKeys(mi);
	armSong = sl[0].s;
	arrCur = null;
	arrHint = null;
	moveTo(songs[sl[0].s].sections[sl[0].j].start);
	lastEntered = sl[0].s;
	applyTempo(sl[0].s);
	loadTail(sl[0].s);
}

function selectmed(mi, now) {
	mi = parseInt(mi, 10);
	if (!medleys[mi]) return;
	if (!playing) { prepareMedley(mi); return; }
	if (med && med.i == mi) return;
	if (now) { medgo(mi, 0, 1); return; }
	pendingSong = (pendingSong == MED + mi) ? -1 : MED + mi;
}

// play slot k of a medley (from stopped: prepare it there)
function medgo(mi, k, now) {
	mi = parseInt(mi, 10); k = parseInt(k, 10);
	var sl = medSlots(mi);
	if (!sl[k]) return;
	if (!playing) {
		prepareMedley(mi);
		med.k = k;
		armSong = sl[k].s;
		moveTo(songs[sl[k].s].sections[sl[k].j].start);
		lastEntered = sl[k].s;
		return;
	}
	if (queue && queue.fired) return;
	medKeys(mi);
	queue = { song: sl[k].s, sec: sl[k].j, now: now ? 1 : 0, loop: 0, fired: 0, from: curSong + ":" + curSec };
	if (med && med.i == mi) queue.medK = k; else { queue.medStart = mi; queue.medFirst = k; }
}

function playmed(mi) { prepareMedley(parseInt(mi, 10)); play(); }

function runMed() {
	if (wantStart) return;
	var sl = medSlots(med.i);
	if (!sl.length) { exitMed(); return; }
	var cur = sl[med.k];
	if (!cur || cur.s != curSong || cur.j != curSec) {
		var nx = sl[med.k + 1];
		if (nx && nx.s == curSong && nx.j == curSec) med.k++;
		else {
			var f = -1;
			for (var k = med.k + 1; k < sl.length && f < 0; k++) if (sl[k].s == curSong && sl[k].j == curSec) f = k;
			for (k = 0; k < sl.length && f < 0; k++) if (sl[k].s == curSong && sl[k].j == curSec) f = k;
			if (f < 0) {
				// on the way into the medley's first section (the bar before it): wait
				if (cur && cur.s == curSong && t < songs[cur.s].sections[cur.j].start && t > songs[cur.s].sections[cur.j].start - 3 * barLen()) return;
				if (queue) return;
				exitMed();
				return;
			}
			med.k = f;
		}
	}
	if (queue || loopState) return;
	var nk = med.k + 1;
	if (nk >= sl.length) return; // the last slot: medTransport ends the medley
	queue = { song: sl[nk].s, sec: sl[nk].j, now: 0, loop: 0, fired: 0, from: curSong + ":" + curSec, auto: 1, medK: nk };
}

// the item after the medley in the setlist (or the one chosen to follow)
function medNext(mi) {
	if (pendingSong >= 0 && pendingSong != MED + mi) return pendingSong;
	var p = setlistPos(MED + mi);
	return (p >= 0 && p + 1 < order.length) ? order[p + 1] : -1;
}

function medTransport(bl) {
	var sl = medSlots(med.i);
	var cur = sl[med.k];
	if (!cur || cur.s != curSong || cur.j != curSec || med.k < sl.length - 1) return;
	var E = songs[curSong].sections[curSec].end;
	var m = medleys[med.i].tr || TR_CUE, nxt = medNext(med.i);
	if ((m == TR_LINK || m == TR_OVERLAP || m == TR_XFADE) && nxt >= 0) {
		if (t >= E - bl + 0.05 && !queue) {
			if (nxt >= MED) {
				var ns = medSlots(nxt - MED);
				if (ns.length) { medKeys(nxt - MED); queue = { song: ns[0].s, sec: ns[0].j, now: 0, loop: 0, fired: 0, from: curSong + ":" + curSec, medStart: nxt - MED }; }
			} else queue = { song: nxt, sec: 0, now: 0, loop: 0, fired: 0, from: curSong + ":" + curSec };
			pendingSong = -1;
		}
		return;
	}
	var look = (tempo / 60) * (0.06 + writeLead);
	if (t >= E - look) {
		song.call("stop_playing");
		playing = 0;
		finishRamp();
		restoreFade();
		clearAuto();
		var mi = med.i;
		if (m == TR_STAY) prepareMedley(mi);
		else if (nxt >= 0) prepareSong(nxt);
		else { exitMed(); moveTo(E); }
	}
}

// what the dashboard needs: the medleys resolved in this set
function medPublic() {
	var out = [];
	for (var mi = 0; mi < medleys.length; mi++) {
		var m = medleys[mi], sl = medSlots(mi), semis = {};
		for (var k = 0; k < sl.length; k++) semis[sl[k].s] = medSemisOf(mi, sl[k].s);
		out.push({ id: m.id, name: m.name, bpm: m.bpm || 0, key: m.key || "", voice: m.voice || "", tr: m.tr || 0,
			slots: sl.map(function (x) { return { s: x.s, j: x.j }; }), semis: semis, raw: m.slots ? m.slots.length : 0 });
	}
	return out;
}

// the dashboard sends a whole medley (or a delete) through a dict
function medleydict() {
	var o;
	try { o = JSON.parse(new Dict(MED_DICT).stringify()); } catch (e) { log("medley: bad dict"); return; }
	medleyApply(o);
}

function medleyjson() {
	var o;
	try { o = JSON.parse(arrayfromargs(arguments).join(" ")); } catch (e) { log("medley: bad json"); return; }
	medleyApply(o);
}

function medleyApply(o) {
	if (!o) return;
	if (o.action == "build") { medBuild(o); return; }
	if (o.action == "unbuild") { medUnbuild(o); return; }
	var mi = medIndex(o.id);
	if (o.action == "delete") {
		if (mi < 0) return;
		if (med && med.i == mi) exitMed();
		var names = orderNames();
		medleys.splice(mi, 1);
		if (med && med.i > mi) med.i--;
		if (medKeysOn > mi) medKeysOn--;
		order = mergeOrder(names);
		log("medley deleted: " + o.id);
	} else {
		var m = o.medley;
		if (!m || !m.slots || !m.slots.length) return;
		var rec = { id: m.id || ("m" + new Date().getTime()), name: String(m.name || "Medley"), bpm: Number(m.bpm) || 0,
			key: String(m.key || ""), voice: String(m.voice || ""), tr: parseInt(m.tr, 10) || 0, slots: [], semis: {} };
		for (var k = 0; k < m.slots.length; k++) rec.slots.push({ song: String(m.slots[k].song), sec: parseInt(m.slots[k].sec, 10), name: String(m.slots[k].name || "") });
		for (var nm in (m.semis || {})) if (m.semis.hasOwnProperty(nm)) rec.semis[nm] = parseInt(m.semis[nm], 10) || 0;
		var keysWere = medKeysOn == mi && mi >= 0;
		if (mi >= 0) { if (keysWere) medKeysOff(); medleys[mi] = rec; }
		else {
			medleys.push(rec);
			mi = medleys.length - 1;
			// in the setlist right where the dashboard asked (default: at the end)
			var at = parseInt(o.at, 10), names2 = orderNames();
			if (at >= 0 && at <= names2.length) names2.splice(at, 0, MED_TAG + rec.id); else names2.push(MED_TAG + rec.id);
			order = mergeOrder(names2);
		}
		if (med && med.i == mi && !playing) prepareMedley(mi);
		else if (keysWere) medKeys(mi);
		log("medley " + rec.name + ": " + rec.slots.length + " sections, " + (rec.bpm || "own") + " BPM, key " + (rec.key || "own"));
	}
	saveStore();
	publishStruct();
}

// ------------------------------------------------------------------ built medleys
// A medley the wizard builds is a song of its own at the end of the
// arrangement: copies of the chosen sections' clips (same audio files), each
// part already in the medley's key, with its own locators. Live plays it
// straight through like any song: no jumps on stage. What Live can't hold
// (each part's tempo, the ramps, the pads between keys) is kept in the
// song's options as opt(s).med and played by the engine.
var VOX_RE = /(vox|vocal|voz|voces|bgv|bgvs|choir|\bcoro\b|alto|tenor|soprano|\blead\b|harmon|armon)/i;
var GUIDEV_RE = /(guide|gu[ií]a|\bcues?\b)/i;
var SEAM_BARS = { cut: 0, ant: 0, ramp: 0, pivot: 2, count: 2 };
var KEYS_SHARP = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
var KEY_IDX = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
var medJobInfo = null;

function keyParse(k) {
	var m = /^([A-G](#|b)?)(m?)$/.exec(String(k || ""));
	return m && KEY_IDX[m[1]] != null ? { root: KEY_IDX[m[1]], minor: !!m[3] } : null;
}

function medOf(s) {
	if (s < 0 || s >= songs.length || s >= MED) return null;
	var o = songOpts[songs[s].name];
	return o && o.med ? o.med : null;
}

// the set's end, leaving out a range (the medley being rebuilt)
function setEndExcept(a, b) {
	var last = 0, ids = trackIds();
	for (var i = 0; i < ids.length; i++) {
		trackApi.id = ids[i];
		var raw = trackApi.get("arrangement_clips") || [];
		for (var k = 0; k < raw.length; k++) {
			if (raw[k] != "id") continue;
			clipApi.id = num(raw[k + 1]); k++;
			var st = num(clipApi.get("start_time"));
			if (st >= a - 0.001 && st < b - 0.001) continue;
			last = Math.max(last, num(clipApi.get("end_time")));
		}
	}
	var cues = readCues();
	for (var c = 0; c < cues.length; c++) if (!(cues[c].time >= a - 0.001 && cues[c].time < b - 0.001)) last = Math.max(last, cues[c].time);
	return last;
}

// where a song's material ends: the next song's header, or the end of the set
function songRange(s) {
	var sg = songs[s];
	var next = 1e12;
	for (var i = 0; i < songs.length; i++) if (songs[i].start > sg.start + 0.001) next = Math.min(next, songs[i].start);
	return [sg.start, next];
}

// the clips under [a, b) of a song, per track: what a part copies
function clipsUnder(a, b) {
	var out = [], ids = trackIds();
	for (var i = 0; i < ids.length; i++) {
		var id = ids[i];
		// SetPilot Click is in: songs' click stems live there
		if (id == ownTrackId || id == tailTrackId || id == gateTrackId) continue;
		trackApi.id = id;
		if (num(trackApi.get("has_midi_input"))) continue;
		var nm = str(trackApi.get("name"));
		if (GUIDEV_RE.test(nm) && !/click|clic/i.test(nm)) continue;   // the guide's words belong to its own song
		var raw = trackApi.get("arrangement_clips") || [];
		for (var k = 0; k < raw.length; k++) {
			if (raw[k] != "id") continue;
			var cid = num(raw[k + 1]); k++;
			clipApi.id = cid;
			if (!num(clipApi.get("is_audio_clip"))) continue;
			var st = num(clipApi.get("start_time")), et = num(clipApi.get("end_time"));
			if (et <= a + 0.001 || st >= b - 0.001) continue;
			// a clip without warp keeps its markers in seconds, on the set's tempo of the moment
			var warped = !!num(clipApi.get("warping"));
			out.push({ track: id, name: nm, clip: cid, st: st, et: et, sm: num(clipApi.get("loop_start")), f: warped ? 1 : 60 / (tempo || 120),
				pitched: warped && !NONPITCH_RE.test(nm), vox: VOX_RE.test(nm), click: normTrack(nm) == "click", warped: warped });
		}
	}
	return out;
}

// o: { action: "build", at, medley: { id, name, key, parts: [{ song, secs: [j], semis, bpm }], seams: [{ type }] } }
function medBuild(o) {
	if (job) { importMsg("error", "busy"); return; }
	if (playing) { importMsg("error", "playing"); return; }
	var m = o.medley;
	if (!m || !m.parts || m.parts.length < 1) { importMsg("error", "plan"); return; }
	var bl = barLen();
	var name = String(m.name || "Medley").replace(/[#|]/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "") || "Medley";

	// an earlier build of this medley (or a song with that name made by a medley) goes away first
	var old = -1;
	for (var i = 0; i < songs.length; i++) {
		var md = medOf(i);
		if (md && (String(md.id) == String(m.id) || songs[i].name == name)) { old = i; break; }
	}
	var steps = [], oldA = -1, oldB = -1;
	if (old >= 0) {
		var rg = songRange(old);
		oldA = rg[0]; oldB = rg[1];
		steps.push({ type: "rmclips", from: oldA, to: oldB });
		var oc = readCues();
		for (var c = 0; c < oc.length; c++) if (oc[c].time >= oldA - 0.001 && oc[c].time < oldB - 0.001) steps.push({ type: "uncue", time: oc[c].time });
	}
	var last = old >= 0 ? setEndExcept(oldA, oldB) : songEndBeats();
	var P = last > 0 ? Math.ceil(last / bl - 1e-6) * bl + 4 * bl : 0;

	// two bars of count-off before the first part, like a song from MultiTracks: the
	// header takes the song's start and the first section gets its own locator
	var lead = 2 * bl;
	var Q = P + lead, cues = [], parts = [], seams = [], dupN = 0, missing = [], unwarped = {};
	for (var k = 0; k < m.parts.length; k++) {
		var pt = m.parts[k], s = songIndex(pt.song);
		if (s < 0) { missing.push(pt.song); continue; }
		// the sections play in the order the wizard gives (any order, repeats too)
		var sg = songs[s], secs = (pt.secs || []).map(function (x) { return parseInt(x, 10); }).filter(function (j) { return sg.sections[j]; });
		if (!secs.length) continue;
		var semis = Math.max(-12, Math.min(12, parseInt(pt.semis, 10) || 0));
		var bpm = Number(pt.bpm) || sg.bpm || tempo;
		var seamIn = k > 0 ? (m.seams && m.seams[k - 1] ? String(m.seams[k - 1].type) : "cut") : "";
		var partStart = Q;
		// runs of sections that follow each other in the song are copied as one piece
		var runs = [];
		for (var r = 0; r < secs.length; r++) {
			var sec = sg.sections[secs[r]], lr = runs[runs.length - 1];
			if (lr && Math.abs(lr.b - sec.start) < 0.01) { lr.b = sec.end; lr.secs.push(secs[r]); }
			else runs.push({ a: sec.start, b: sec.end, secs: [secs[r]] });
		}
		if (k == 0) {
			// the click of the count-off: the bars before the first section, on the click track
			var pre = clipsUnder(runs[0].a - lead, runs[0].a);
			for (var w = 0; w < pre.length; w++) {
				if (!pre[w].click) continue;
				var w0 = Math.max(runs[0].a - lead, pre[w].st), w1 = Math.min(runs[0].a, pre[w].et);
				if (w1 - w0 < 0.5) continue;
				steps.push({ type: "dup", track: pre[w].track, clip: pre[w].clip, pos: P + (w0 - (runs[0].a - lead)), sm: pre[w].sm + (w0 - pre[w].st) * pre[w].f, em: pre[w].sm + (w1 - pre[w].st) * pre[w].f, f: pre[w].f, pitch: 0, name: pre[w].name });
				dupN++;
			}
		}
		for (var u = 0; u < runs.length; u++) {
			var run = runs[u], under = clipsUnder(run.a, run.b);
			for (var q = 0; q < under.length; q++) {
				var cl = under[q];
				var x0 = Math.max(run.a, cl.st), x1 = Math.min(run.b, cl.et);
				var pos = Q + (x0 - run.a), sm = cl.sm + (x0 - cl.st) * cl.f, em = cl.sm + (x1 - cl.st) * cl.f;
				// the voices of a part that anticipates come in half a bar early
				if (seamIn == "ant" && u == 0 && cl.vox && Math.abs(x0 - run.a) < 0.01 && x0 - cl.st >= bl / 2) { pos -= bl / 2; sm -= bl / 2 * cl.f; }
				if (!cl.warped) unwarped[sg.name] = 1;
				steps.push({ type: "dup", track: cl.track, clip: cl.clip, pos: pos, sm: sm, em: em, f: cl.f, pitch: cl.pitched ? semis : 0, name: cl.name });
				dupN++;
			}
			for (var j2 = 0; j2 < run.secs.length; j2++) {
				var sc2 = sg.sections[run.secs[j2]];
				cues.push({ time: Q + (sc2.start - run.a), name: sc2.name });
			}
			Q += run.b - run.a;
		}
		parts.push({ song: sg.name, a: partStart - P, b: Q - P, bpm: bpm, semis: semis, key: m.key || "", pkey: pt.key || m.key || "" });
		// the bridge after this part: pad bars, with the click going on
		var nextSeam = k + 1 < m.parts.length && m.seams && m.seams[k] ? String(m.seams[k].type) : "";
		var nb = SEAM_BARS[nextSeam] || 0;
		if (nextSeam) seams.push({ type: nextSeam, at: Q - P, len: nb * bl, from: parts.length - 1 });
		if (nb) {
			var lastRun = runs[runs.length - 1], ck = clipsUnder(Math.max(lastRun.a, lastRun.b - nb * bl), lastRun.b);
			for (var z = 0; z < ck.length; z++) {
				if (!ck[z].click) continue;
				var y0 = Math.max(lastRun.b - nb * bl, ck[z].st), y1 = Math.min(lastRun.b, ck[z].et);
				steps.push({ type: "dup", track: ck[z].track, clip: ck[z].clip, pos: Q + (y0 - (lastRun.b - nb * bl)), sm: ck[z].sm + (y0 - ck[z].st) * ck[z].f, em: ck[z].sm + (y1 - ck[z].st) * ck[z].f, f: ck[z].f, pitch: 0, name: ck[z].name });
				dupN++;
			}
			cues.push({ time: Q, name: "Transición" });
			Q += nb * bl;
		}
	}
	if (!parts.length) { importMsg("error", "plan"); return; }
	// a seam after the last part means nothing
	seams = seams.filter(function (x) { return x.from < parts.length - 1; });
	var keyName = String(m.key || "");
	steps.push({ type: "verify" });
	steps.push({ type: "zoom", dir: 3 });
	var hdr = "# " + name + " | " + (Math.round(parts[0].bpm * 100) / 100) + (keyName ? " | " + keyName : "");
	steps.push({ type: "cue", time: P, name: hdr });
	for (var cc = 0; cc < cues.length; cc++) if (cues[cc].time > P + 0.001) steps.push({ type: "cue", time: cues[cc].time, name: cues[cc].name });
	// the first section's name lives on the header's spot: the song map shows it as its first section
	var stopAt = Math.ceil((Q - 0.001) / bl) * bl;
	steps.push({ type: "cue", time: stopAt, name: "STOP" });
	steps.push({ type: "zoom", dir: 2 });
	steps.push({ type: "meddone" });

	medJobInfo = { id: String(m.id || ("m" + new Date().getTime())), name: name, key: keyName, parts: parts, seams: seams, first: cues.length ? cues[0].name : "",
		spec: m, at: parseInt(o.at, 10), oldName: old >= 0 ? songs[old].name : "" };
	job = { steps: steps, i: 0, P: P, dest: {}, title: name, savedTempo: tempo, warp: {}, medley: 1 };
	importMsg("start", name, steps.length, Math.round(P / bl) + 1);
	var uw = Object.keys(unwarped);
	log("medley build " + name + " at bar " + (Math.round(P / bl) + 1) + ": " + parts.length + " parts, " + dupN + " clips, " + seams.length + " seams" + (missing.length ? ", missing " + missing.join(", ") : "") + (uw.length ? ", audio without warp in " + uw.join(", ") + " (kept at its pitch)" : ""));
}

// one copied clip: Live duplicates it (warp, gain and all), then it is trimmed to the section
function runDup(step) {
	if (step.created) return;
	step.created = 1;
	trackApi.id = step.track;
	var made = null;
	try {
		trackApi.call("duplicate_clip_to_arrangement", "id", step.clip, step.pos);
		made = findClipAt(step.track, step.pos);
	} catch (e) { log("duplicate failed (" + e.message + "): copying from the file"); }
	if (!made) {
		// older Live: a new clip from the same file on the source's timing
		clipApi.id = step.clip;
		var file = str(clipApi.get("file_path")), src = markersOf(clipApi).map(function (x) { return [x.sec, x.beat]; }), mode = num(clipApi.get("warp_mode"));
		trackApi.id = step.track;
		trackApi.call("create_audio_clip", file, step.pos);
		made = findClipAt(step.track, step.pos);
		if (!made) throw new Error("clip not made on " + step.name);
		clipApi.id = made;
		if (!num(clipApi.get("warping"))) clipApi.set("warping", 1);
		if (num(clipApi.get("warp_mode")) != mode) clipApi.set("warp_mode", mode);
		if (src.length >= 2) rewarp(clipApi, { markers: src, name: step.name, maxEnd: 0, length: step.em - step.sm });
	}
	clipApi.id = made;
	// Live 12 ignores start_marker on an arrangement clip that doesn't loop: its
	// region is loop_start..loop_end (the start marker follows loop_start). The
	// start can't pass the end, so the order depends on where the region moves.
	if (step.sm < num(clipApi.get("loop_end")) - 0.0001) {
		clipApi.set("loop_start", step.sm);
		clipApi.set("loop_end", step.em);
	} else {
		clipApi.set("loop_end", step.em);
		clipApi.set("loop_start", step.sm);
	}
	try { clipApi.set("end_marker", step.em); } catch (e) { }
	if (num(clipApi.get("pitch_coarse")) != step.pitch) clipApi.set("pitch_coarse", step.pitch);
	if (step.pitch && num(clipApi.get("warping")) && num(clipApi.get("warp_mode")) != 6) clipApi.set("warp_mode", 6);
	(job.dups = job.dups || []).push({ track: step.track, pos: step.pos, len: (step.em - step.sm) / (step.f || 1), name: step.name });
}

function findClipAt(track, pos) {
	trackApi.id = track;
	var raw = trackApi.get("arrangement_clips") || [];
	for (var k = 0; k < raw.length; k++) {
		if (raw[k] != "id") continue;
		clipApi.id = num(raw[k + 1]); k++;
		if (Math.abs(num(clipApi.get("start_time")) - pos) < 0.01) return num(raw[k]);
	}
	return 0;
}

function rmClips(a, b) {
	var ids = trackIds(), n = 0;
	for (var i = 0; i < ids.length; i++) {
		trackApi.id = ids[i];
		var raw = trackApi.get("arrangement_clips") || [], del = [];
		for (var k = 0; k < raw.length; k++) {
			if (raw[k] != "id") continue;
			clipApi.id = num(raw[k + 1]); k++;
			var st = num(clipApi.get("start_time"));
			if (st >= a - 0.001 && st < b - 0.001) del.push(clipApi.id);
		}
		for (var d = 0; d < del.length; d++) { trackApi.call("delete_clip", "id", del[d]); n++; }
	}
	log("medley: " + n + " old clips removed");
}

function medDone() {
	var info = medJobInfo, P = job.P;
	medJobInfo = null;
	var bad = 0, list = job.dups || [];
	for (var i = 0; i < list.length; i++) {
		var c = list[i], id = findClipAt(c.track, c.pos);
		if (!id) { bad++; log("medley check: " + c.name + " missing at " + c.pos); continue; }
		clipApi.id = id;
		var len = num(clipApi.get("end_time")) - num(clipApi.get("start_time"));
		if (Math.abs(len - c.len) > 0.02) { bad++; log("medley check: " + c.name + " is " + len + " beats, wanted " + c.len); }
	}
	if (info) {
		if (info.oldName && info.oldName != info.name && songOpts[info.oldName]) delete songOpts[info.oldName];
		var o = songOpts[info.name] = songOpts[info.name] || { bpm: 0, semis: 0 };
		o.bpm = 0; o.semis = 0;
		o.med = { id: info.id, key: info.key, parts: info.parts, seams: info.seams, spec: info.spec, built: new Date().getTime() };
		if (info.at >= 0) medPlace = { name: info.name, at: info.at, until: clock + 15000 };
	}
	setProp("current_song_time", P);
	needStore = true;
	var title = job.title;
	job = null;
	structSig = "";
	dirty = true;
	importMsg("done", title, list.length - bad, list.length);
	log("medley built: " + title + " (" + (list.length - bad) + "/" + list.length + " clips ok)");
}

// the new medley goes where the wizard said in the setlist, once its song shows up
var medPlace = null;
function runMedPlace() {
	if (!medPlace) return;
	if (clock > medPlace.until) { medPlace = null; return; }
	if (songIndex(medPlace.name) < 0) return;
	var names = orderNames().filter(function (n) { return n != medPlace.name; });
	names.splice(Math.max(0, Math.min(names.length, medPlace.at)), 0, medPlace.name);
	order = mergeOrder(names);
	medPlace = null;
	saveStore();
	publishStruct();
}

function medUnbuild(o) {
	if (job || playing) return;
	var s = -1;
	for (var i = 0; i < songs.length; i++) { var md = medOf(i); if (md && String(md.id) == String(o.id)) { s = i; break; } }
	if (s < 0) return;
	var rg = songRange(s), steps = [{ type: "rmclips", from: rg[0], to: rg[1] }], oc = readCues();
	for (var c = 0; c < oc.length; c++) if (oc[c].time >= rg[0] - 0.001 && oc[c].time < rg[1] - 0.001) steps.push({ type: "uncue", time: oc[c].time });
	steps.push({ type: "fin", back: Math.max(0, rg[0] - barLen() * 4), what: "medley deleted" });
	delete songOpts[songs[s].name];
	needStore = true;
	job = { steps: steps, i: 0, P: rg[0], dest: {}, title: songs[s].name, savedTempo: tempo, warp: {} };
	log("medley delete: " + songs[s].name);
}

// ---------- playing a built medley
// the tempo at a point of the medley: its part's, ramping into the next part
// over the last 4 bars when that seam is a ramp; a pad bridge already takes
// the next part's tempo
function medTempoAt(s, time) {
	var md = medOf(s);
	if (!md || !md.parts || !md.parts.length) return 0;
	var rel = time - songs[s].start, bl = barLen(), p = md.parts, k = 0;
	for (var i = 0; i < p.length; i++) if (rel >= p[i].a - 0.001) k = i;
	var v = p[k].bpm;
	if (rel >= p[k].b - 0.001 && k + 1 < p.length) v = p[k + 1].bpm;   // in the bridge after it
	else {
		for (var j = 0; j < (md.seams || []).length; j++) {
			var sm = md.seams[j];
			if (sm.type != "ramp" || sm.from != k || !p[k + 1]) continue;
			var r0 = p[k].b - 4 * bl;
			if (rel > r0) v = p[k].bpm + (p[k + 1].bpm - p[k].bpm) * Math.min(1, (rel - r0) / (4 * bl));
		}
	}
	var o = opt(s), base = p[0].bpm;
	return o.bpm && base ? v * o.bpm / base : v;
}

// the wizard's "listen": two bars before a join to two bars after it, then stop
var listenStop = 0, listenAt = 0;
function medlisten(s, k) {
	s = parseInt(s, 10); k = parseInt(k, 10);
	var md = medOf(s);
	if (!md || !md.seams || !md.seams[k] || job) return;
	if (playing) stop();
	var sm = md.seams[k], S = songs[s].start, bl = barLen();
	var from = Math.max(S, S + sm.at - 2 * bl);
	prepareSong(s);
	moveTo(from);
	applyTempo(s);
	listenStop = S + sm.at + sm.len + 2 * bl;
	listenAt = clock;
	startFrom(from);
}

function listenTick() {
	if (!listenStop) return;
	if (playing && t >= listenStop) { listenStop = 0; stop(); stop(); return; }
	if (!playing && clock - listenAt > 2500) listenStop = 0;
}

// which song this moment belongs to: a medley's part (its bridge counts as the
// next part), or the song itself
function songIdentityAt(s, time) {
	if (s < 0 || !songs[s]) return "";
	var md = medOf(s);
	if (!md || !md.parts || !md.parts.length) return songs[s].name;
	var rel = time - songs[s].start, p = md.parts, k = 0;
	for (var i = 0; i < p.length; i++) if (rel >= p[i].a - 0.01) k = i;
	if (rel >= p[k].b - 0.01 && p[k + 1]) k++;
	return p[k].song;
}

function songAtTime(time) {
	for (var i = 0; i < songs.length; i++) if (time >= songs[i].start - 0.001 && time < songs[i].end - 0.001) return i;
	return -1;
}

// the song a medley goes into at this point (where the previous part ends), or ""
function medAnnounce(s, time) {
	var md = medOf(s);
	if (!md || !md.parts) return "";
	var rel = time - songs[s].start, p = md.parts;
	for (var k = 1; k < p.length; k++) {
		if (Math.abs(rel - p[k - 1].b) < 0.01 && p[k].song != p[k - 1].song) return cleanCue(p[k].song);
	}
	return "";
}

var medTempoLast = 0;
function medTempoTick() {
	if (!playing || curSong < 0 || !medOf(curSong)) return;
	var v = medTempoAt(curSong, t);
	if (!(v > 0)) return;
	v = Math.round(v * 100) / 100;
	if (Math.abs(tempo - v) > 0.009) { setProp("tempo", v); tempo = v; tempoOverridden = true; }
}

// the pitch of a medley clip: its part's, plus the key the song is moved to
function medPitchAt(s, time) {
	var md = medOf(s);
	if (!md) return 0;
	var rel = time - songs[s].start, p = md.parts, v = p.length ? p[0].semis : 0;
	for (var i = 0; i < p.length; i++) if (rel >= p[i].a - 0.6 * barLen()) v = p[i].semis;   // a clip that anticipates belongs to the part it starts
	return v;
}

// pads between keys, played by SetPilot Audio on the Tail track: chords
// scheduled on the beat, sent again whenever the playhead jumps
var padSent = "", padOn = false, padLastT = 0;
function medPadEvents(s) {
	var md = medOf(s), ev = [];
	if (!md || !md.seams) return ev;
	var S = songs[s].start, bl = barLen(), p = md.parts;
	for (var i = 0; i < md.seams.length; i++) {
		var sm = md.seams[i], A = p[sm.from], B = p[sm.from + 1];
		if (!A || !B || !(sm.len > 0)) continue;
		var ka = keyParse(A.pkey || md.key), kb = keyParse(B.pkey || md.key);
		if (!kb) continue;
		if (!ka) ka = kb;
		var at = S + sm.at, end = at + sm.len;
		if (sm.type == "pivot") {
			ev.push([at - bl, ka.root, ka.minor ? 2 : 1]);
			ev.push([end - bl, (kb.root + 7) % 12, 1]);        // V of the new key
			ev.push([end, kb.root, kb.minor ? 2 : 1]);
			ev.push([end + 2 * bl, 0, 0]);
		} else if (sm.type == "count") {
			ev.push([at - bl, ka.root, ka.minor ? 2 : 1]);
			ev.push([at, kb.root, kb.minor ? 2 : 1]);
			ev.push([end + bl, 0, 0]);
		}
	}
	return ev;
}

function medPadTick() {
	if (!tailPresent()) return;
	var md = playing && curSong >= 0 ? medOf(curSong) : null;
	if (!md) {
		if (padOn) { messnamed("setpilot_tail", "padclear"); padOn = false; padSent = ""; }
		return;
	}
	var jumped = t < padLastT - 0.05 || t > padLastT + 2 * barLen();
	padLastT = t;
	var key = curSong + "|" + (md.built || 0);
	if (key == padSent && !jumped) return;
	padSent = key;
	messnamed("setpilot_tail", "padclear");
	var ev = medPadEvents(curSong);
	for (var i = 0; i < ev.length; i++) if (ev[i][0] > t - 0.01) messnamed("setpilot_tail", "pad", ev[i][0], ev[i][1], ev[i][2]);
	padOn = true;
}

// ------------------------------------------------------------------ arrangement
// A song's arrangement is the order its sections play in. By default it is the
// order of the timeline; edited, SetPilot follows it with jumps on the downbeat
// (nothing in the Live set is cut or copied).
function secNames(s) {
	var n = [], sc = songs[s].sections;
	for (var j = 0; j < sc.length; j++) n.push(sc[j].name);
	return n.join("|");
}

function arrOf(s) {
	if (s < 0 || !songs[s]) return null;
	var a = opt(s).arr;
	if (!a || !a.list || !a.list.length || a.sig != secNames(s)) return null;
	return a.list;
}

// the section a song starts with: the first of its arrangement (a count-off
// taken out of it is skipped)
function firstSec(s) {
	var a = arrOf(s);
	return a ? a[0] : 0;
}

// where playing the song starts from
function songEntry(s) {
	var f = firstSec(s), sc = songs[s].sections[f];
	return f && sc ? sc.start : songs[s].start;
}

// first slot after "after" that plays section j (or the first one anywhere)
function arrFind(a, j, after) {
	for (var i = after + 1; i < a.length; i++) if (a[i] == j) return i;
	for (i = 0; i < a.length; i++) if (a[i] == j) return i;
	return -1;
}

// next slot when the current section is not in the arrangement
function arrAfter(a, j) {
	for (var i = 0; i < a.length; i++) if (a[i] > j) return i;
	return a.length;
}

function arrNext(s) {
	var a = arrOf(s);
	if (!a || !arrCur || arrCur.song != s) return -2;
	return arrCur.k >= 0 ? arrCur.k + 1 : arrAfter(a, arrCur.sec);
}

// where the song really ends: the end of the last section of its arrangement
function arrEnd(s) {
	var sg = songs[s];
	if (s != curSong || !playing) return sg.end;
	var a = arrOf(s), nk = arrNext(s);
	if (!a || nk < a.length || nk == -2) return sg.end;
	var sec = sg.sections[curSec];
	return sec ? sec.end : sg.end;
}

function runArr() {
	var a = arrOf(curSong);
	if (!a) { arrCur = null; return; }
	// still on the way to the slot chosen while stopped (end of a count-in): wait for it
	if (arrHint && arrHint.song == curSong && a[arrHint.k] != curSec) {
		var hs = songs[curSong].sections[a[arrHint.k]];
		if (hs && t < hs.start && t > hs.start - 3 * barLen()) return;
	}
	if (arrHint && arrHint.song == curSong && a[arrHint.k] == curSec) {
		// the slot chosen while stopped wins
		arrCur = { song: curSong, k: arrHint.k, sec: curSec };
		arrHint = null;
	} else if (!arrCur || arrCur.song != curSong) {
		arrCur = { song: curSong, k: arrFind(a, curSec, -1), sec: curSec };
	} else if (arrCur.sec != curSec) {
		if (arrCur.k + 1 < a.length && a[arrCur.k + 1] == curSec) arrCur.k++;
		else if (arrCur.k < 0 || a[arrCur.k] != curSec) arrCur.k = arrFind(a, curSec, arrCur.k);
		arrCur.sec = curSec;
	}
	if (queue || loopState) return;
	var nk = arrNext(curSong);
	if (nk < 0 || nk >= a.length) return; // last slot: the song ends with it
	queue = { song: curSong, sec: a[nk], now: 0, loop: 0, fired: 0, from: curSong + ":" + curSec, auto: 1, arrK: nk };
}

// the dashboard sends the whole arrangement: section indices in play order
function arrset() {
	var args = arrayfromargs(arguments);
	var s = parseInt(args[0], 10);
	if (!songs[s]) return;
	var n = songs[s].sections.length, list = [], same = args.length - 1 == n;
	for (var i = 1; i < args.length; i++) {
		var j = parseInt(args[i], 10);
		if (isNaN(j) || j < 0 || j >= n) return;
		list.push(j);
		if (j != i - 1) same = false;
	}
	var o = opt(s);
	if (!list.length || same) delete o.arr;
	else o.arr = { sig: secNames(s), list: list };
	if (queue && queue.auto && !queue.fired) queue = null;
	if (arrCur && arrCur.song == s) {
		var a = arrOf(s);
		if (!a) arrCur = null;
		else if (arrCur.k < 0 || a[arrCur.k] != arrCur.sec) arrCur.k = arrFind(a, arrCur.sec, -1);
	}
	log("arrangement " + songs[s].name + ": " + (o.arr ? list.join(",") : "original"));
	saveStore();
	publishStruct();
}

// play the k-th slot of the arrangement
function arrgo(s, k, now) {
	s = parseInt(s, 10); k = parseInt(k, 10);
	var a = arrOf(s);
	if (!a) { queueSection(s, k, now, 0); return; }
	if (k < 0 || k >= a.length) return;
	queueSection(s, a[k], now, 0, k);
}

// ------------------------------------------------------------------ transitions

function trMode(s) {
	var o = opt(s);
	return o.tr || trDefault;
}

function effTempo(s) {
	var mb = medBpmFor(s);
	if (mb) return mb;
	var o = opt(s);
	return o.bpm || songs[s].bpm || baseCache[songs[s].name] || tempo || 120;
}

function barSec(s) { return barLen() * 60 / effTempo(s); }

// first beat of the window a song's tail file covers (the longest handover)
function tailFrom(s) {
	var sg = songs[s], bl = barLen();
	var bars = Math.max(1, Math.ceil(XFADE_SEC / barSec(s) - 0.001));
	return Math.max(sg.start, sg.end - bars * bl);
}

// beat where the next song takes over in Overlap and Crossfade. Like Playback:
// a crossfade lasts about 5 seconds; an overlap lasts the shortest of the last
// section, the next song's first section and 5 seconds. Always whole bars.
function handoverAt(s, n, mode) {
	var sg = songs[s], bl = barLen(), bs = barSec(s), bars;
	if (mode == TR_XFADE) bars = Math.max(1, Math.round(XFADE_SEC / bs));
	else {
		var last = sg.sections[sg.sections.length - 1];
		var first = songs[n].sections[firstSec(n)];
		var d = Math.min((last.end - last.start) * 60 / effTempo(s), (first.end - first.start) * 60 / effTempo(n), XFADE_SEC);
		bars = Math.max(1, Math.floor(d / bs + 0.001));
	}
	var J = Math.max(sg.end - bars * bl, tailFrom(s), sg.start + bl);
	return J < sg.end - 0.001 ? J : null;
}

function tailOk(s, J) {
	var tl = tails[songs[s].name];
	return tailPresent() && tl && tl.path && tl.from <= J + 0.001 && Math.abs(tl.to - songs[s].end) < 0.001;
}

// how the current song hands over to the next one, or null if it just stops
function handoverPlan(s) {
	if (s < 0) return null;
	var n = nextInSetlist(s);
	if (n < 0) return null;
	var m = trMode(s), sg = songs[s];
	if (n >= MED) {
		// into a medley: its first section, after its key is set (no tail for this one)
		var ms0 = medSlots(n - MED);
		if (!ms0.length || (m != TR_LINK && m != TR_OVERLAP && m != TR_XFADE)) return null;
		return { n: ms0[0].s, sec: ms0[0].j, med: n - MED, J: arrEnd(s), mode: TR_LINK, natural: false };
	}
	var E = arrEnd(s);
	if (E < sg.end - 0.001) {
		// the arrangement ends before the timeline does: no tail for that ending, link there
		return (m == TR_LINK || m == TR_OVERLAP || m == TR_XFADE) ? { n: n, sec: firstSec(n), J: E, mode: TR_LINK, natural: false } : null;
	}
	var f = firstSec(n);
	var link = { n: n, sec: f, J: sg.end, mode: TR_LINK, natural: !f && Math.abs(songs[n].start - sg.end) < 0.001 };
	if (m == TR_LINK) return link;
	if (m == TR_OVERLAP || m == TR_XFADE) {
		var J = handoverAt(s, n, m);
		if (J != null && tailOk(s, J)) return { n: n, sec: f, J: J, mode: m, natural: false };
		if (!warnedTail[sg.name]) {
			warnedTail[sg.name] = 1;
			log((tailPresent() ? "tail not ready" : "no SetPilot Tail") + " for " + sg.name + ", using AutoLink");
		}
		return link;
	}
	return null;
}

function startHandover(s, ho) {
	var tl = tails[songs[s].name], sg = songs[s];
	var q = { song: ho.n, sec: ho.sec || 0, now: 0, loop: 0, fired: 1, firedAt: clock, from: curSong + ":" + curSec, handover: ho.mode };
	if (arrOf(ho.n)) q.arrK = 0;
	q.durMs = (sg.end - ho.J) * 60 / effTempo(s) * 1000;
	q.savedQuant = fireJump(songs[ho.n].sections[q.sec].cue);
	queue = q;
	pendingSong = -1;
	var rate = effTempo(s) / tl.ref;
	var pitch = Math.pow(2, (opt(s).semis || 0) / 12);
	var offsetMs = (ho.J - tl.from) * 60 / tl.ref * 1000;
	loadTail(s);
	messnamed("setpilot_tail", "play", rate, pitch, ho.mode == TR_XFADE ? 2 : 1, q.durMs, offsetMs);
	tailPlayingUntil = clock + q.durMs + 2000 + (60000 / tempo) * barLen();
	log((ho.mode == TR_XFADE ? "crossfade " : "overlap ") + sg.name + " -> " + songs[ho.n].name + " at " + ho.J + " (" + Math.round(q.durMs) + " ms)");
}

// Crossfade: the next song comes up from silence while the tail fades out.
// Click, Guide and the SetPilot tracks keep their level.
function startRamp(ms) {
	finishRamp();
	var ids = trackIds(), list = [];
	for (var i = 0; i < ids.length; i++) {
		var id = ids[i];
		if (id == ownTrackId || id == clickTrackId || id == gateTrackId || id == tailTrackId) continue;
		trackApi.id = id;
		var nm = str(trackApi.get("name"));
		if (GUIDE_RE.test(nm) || CLICK_RE.test(nm)) continue;
		if (num(trackApi.get("is_foldable"))) continue; // groups: their tracks are faded already
		var vol = volumeParam(id);
		if (!vol) continue;
		paramApi.id = vol;
		if (num(paramApi.get("automation_state")) == 1) continue; // automated: leave it alone
		list.push({ id: vol, orig: num(paramApi.get("value")) });
	}
	ramp = { list: list, at: clock, ms: Math.max(200, ms) };
	runRamp();
}

function volumeParam(trackId) {
	trackApi.id = trackId;
	var md = trackApi.get("mixer_device");
	if (!md || md[0] != "id") return 0;
	paramApi.id = num(md[1]);
	var v = paramApi.get("volume");
	return (v && v[0] == "id") ? num(v[1]) : 0;
}

function runRamp() {
	if (!ramp) return;
	var p = (clock - ramp.at) / ramp.ms;
	if (p >= 1) { finishRamp(); return; }
	var g = Math.sin(p * Math.PI / 2);
	for (var i = 0; i < ramp.list.length; i++) {
		paramApi.id = ramp.list[i].id;
		paramApi.set("value", ramp.list[i].orig * g);
	}
}

function finishRamp() {
	if (!ramp) return;
	for (var i = 0; i < ramp.list.length; i++) {
		paramApi.id = ramp.list[i].id;
		paramApi.set("value", ramp.list[i].orig);
	}
	ramp = null;
}

// ---- tail files: the server mixes them from what the engine reads here

var loadedTail = "";
// keep the tail of the song that plays (or is ready) in SetPilot Tail's buffer
function loadTail(s) {
	if (s < 0 || !tailPresent()) return;
	var tl = tails[songs[s].name];
	if (!tl || !tl.path || tl.path == loadedTail) return;
	if (clock < tailPlayingUntil) return;
	loadedTail = tl.path;
	messnamed("setpilot_tail", "load", tl.path);
}

function tailPresent() { return tailTrackId && clock - tailSeen < 8000; }

function tailhello() {
	var was = tailPresent();
	tailTrackId = lastNum(arguments);
	tailSeen = clock;
	if (!was) { loadedTail = ""; log("tail player on track " + tailTrackId); tailDirty = true; warnedTail = {}; scanTracks(); publishStruct(); }
}

function dbOf(param, value) {
	try {
		var sv = str(param.call("str_for_value", value));
		if (/-inf/i.test(sv)) return -200;
		var m = sv.match(/-?\d+(\.\d+)?/);
		if (m) return parseFloat(m[0]);
	} catch (e) { }
	return 0;
}

function clipDb(sv) {
	if (/-inf/i.test(sv)) return -200;
	var m = String(sv).match(/-?\d+(\.\d+)?/);
	return m ? parseFloat(m[0]) : 0;
}

function markersOf(clip) {
	try {
		var raw = clip.get("warp_markers");
		var o = JSON.parse(str(raw));
		var list = o.warp_markers || o;
		var out = [];
		for (var i = 0; i < list.length; i++) out.push({ beat: num(list[i].beat_time), sec: num(list[i].sample_time) });
		return out;
	} catch (e) { return []; }
}

function tailPlan(s) {
	return mixPlan(s, tailFrom(s), songs[s].end);
}

function mixPlan(s, from, to) {
	var sg = songs[s];
	var ref = sg.bpm || baseBpm(s) || tempo;
	var stems = [], ids = trackIds();
	for (var i = 0; i < ids.length; i++) {
		var id = ids[i];
		if (id == ownTrackId || id == clickTrackId || id == gateTrackId || id == tailTrackId) continue;
		trackApi.id = id;
		var nm = str(trackApi.get("name"));
		if (GUIDE_RE.test(nm) || CLICK_RE.test(nm)) continue;
		if (num(trackApi.get("has_midi_input")) || num(trackApi.get("is_foldable")) || num(trackApi.get("mute"))) continue;
		var raw = trackApi.get("arrangement_clips") || [], clips = [];
		for (var k = 0; k < raw.length; k++) {
			if (raw[k] != "id") continue;
			clipApi.id = num(raw[k + 1]);
			k++;
			var st = num(clipApi.get("start_time")), en = num(clipApi.get("end_time"));
			if (st >= to - 0.001 || en <= from + 0.001) continue;
			if (!num(clipApi.get("is_audio_clip")) || num(clipApi.get("muted"))) continue;
			clips.push({
				file: str(clipApi.get("file_path")), start: st, end: en,
				warping: num(clipApi.get("warping")), startMarker: num(clipApi.get("start_marker")),
				looping: num(clipApi.get("looping")), loopStart: num(clipApi.get("loop_start")), loopEnd: num(clipApi.get("loop_end")),
				gainDb: clipDb(str(clipApi.get("gain_display_string"))),
				markers: markersOf(clipApi)
			});
		}
		if (!clips.length) continue;
		trackApi.id = id;
		var vol = volumeParam(id), gainDb = 0, pan = 0;
		if (vol) { paramApi.id = vol; gainDb = dbOf(paramApi, num(paramApi.get("value"))); }
		trackApi.id = id;
		var md = trackApi.get("mixer_device");
		if (md && md[0] == "id") {
			paramApi.id = num(md[1]);
			var pp = paramApi.get("panning");
			if (pp && pp[0] == "id") { paramApi.id = num(pp[1]); pan = num(paramApi.get("value")); }
		}
		stems.push({ name: nm, gainDb: gainDb, pan: pan, clips: clips });
	}
	return { song: sg.name, from: from, to: to, ref: ref, stems: stems };
}

// one song at a time; a remix (new levels) is fast because the server caches
function runTails() {
	if (!tailPresent() || !songs.length) return;
	if (tailJob) {
		if (clock - tailJob.at < 180000) return;
		log("tail timeout for " + tailJob.name);
		tailJob = null;
	}
	if (!tailDirty || clock < tailCheckAt) return;
	if (clock < tailPlayingUntil) return;
	for (var p = 0; p < order.length; p++) {
		var s = order[p];
		if (s >= MED) continue;
		var m = trMode(s);
		if (m != TR_OVERLAP && m != TR_XFADE) continue;
		// never touch the tail of the song that is about to hand over
		if (playing && s == curSong && t > tailFrom(s) - barLen() * 4) continue;
		var plan = tailPlan(s);
		if (!plan.stems.length) continue;
		var sig = JSON.stringify(plan);
		var have = tails[plan.song];
		if (have && have.sig == sig) continue;
		tailJobId++;
		tailJob = { id: tailJobId, name: plan.song, sig: sig, from: plan.from, to: plan.to, ref: plan.ref, at: clock };
		var d = new Dict(TAIL_DICT);
		d.parse(sig);
		outlet(0, "tailprep", tailJobId);
		return;
	}
	tailDirty = false;
}

function tailready(id) {
	var a = arrayfromargs(arguments);
	if (!tailJob || num(a[0]) != tailJob.id) return;
	var path = a.slice(1).join(" ");
	tails[tailJob.name] = { sig: tailJob.sig, path: path, from: tailJob.from, to: tailJob.to, ref: tailJob.ref };
	warnedTail[tailJob.name] = 0;
	tailJob = null;
	tailCheckAt = clock + 200;
	var live = playing ? curSong : armSong;
	if (live >= 0) loadTail(live);
}

function tailfired() {
	log("tail started at " + Math.round(num(getProp("current_song_time")) * 1000) / 1000);
}

function tailfailed(id) {
	if (!tailJob || num(id) != tailJob.id) return;
	log("tail failed for " + tailJob.name);
	tails[tailJob.name] = { sig: tailJob.sig, path: "", from: 0, to: 0, ref: 0 };
	tailJob = null;
}

function transition(s, m) {
	s = parseInt(s, 10); m = parseInt(m, 10);
	if (s < 0 || s >= songs.length || m < 0 || m > 5) return;
	opt(s).tr = m;
	tailDirty = true;
	saveStore();
	publishStruct();
}

function transdefault(m) {
	m = parseInt(m, 10);
	if (m < 1 || m > 5) return;
	trDefault = m;
	autoStop = m == TR_LINK ? 0 : 1;
	tailDirty = true;
	saveStore();
	publishStruct();
}

function landed() {
	var q = queue;
	queue = null;
	if (q.arrK != null && q.arrK >= 0) arrCur = { song: q.song, k: q.arrK, sec: q.sec };
	if (q.medStart != null) { med = { i: q.medStart, k: q.medFirst || 0 }; lastEntered = q.song; applyTempo(q.song); }
	else if (q.medK != null && med) med.k = q.medK;
	else if (med && !q.handover) { exitMed(); lastEntered = q.song; applyTempo(q.song); }   // a jump out of the medley
	restoreQuant(q);
	if (q.handover == TR_XFADE) startRamp(q.durMs);
	if (q.loop) setLoop(q.song, q.sec, 0);
	if (pendingSong == q.song) pendingSong = -1;
}

function send() {
	var q = queue;
	var l = loopState;
	var msg = [
		"pos", Math.round(t * 1000) / 1000, playing, tempo, sigNum, sigDen,
		curSong, curSec,
		q ? q.song : -1, q ? q.sec : -1, q ? (q.fired ? 1 : 0) : 0,
		l ? l.song : -1, l ? l.sec : -1, l ? l.once : 0, liveLoop,
		armSong, pendingSong, autoStop, structVersion,
		fade ? (fade.dir < 0 ? 1 : 2) : (faded ? 1 : 0), pre ? 1 : 0,
		(arrCur && arrCur.song == curSong) ? arrCur.k : (!playing && arrHint && arrHint.song == curSong ? arrHint.k : -1),
		q && q.arrK != null ? q.arrK : -1, q && q.auto ? 1 : 0,
		med ? med.i : -1, med ? med.k : -1, q && q.medK != null ? q.medK : (q && q.medStart != null ? 0 : -1)
	];
	var key = msg.slice(2).join(" ");
	// the dashboard runs its own clock between messages: the time alone is sent 20 times a second
	if (key == lastSent && (clock - lastPosAt < 50 || msg[1] == lastPosT)) return;
	lastSent = key;
	lastPosT = msg[1];
	lastPosAt = clock;
	outlet(0, msg);
}

// ------------------------------------------------------------------ commands from the dashboard

function play() {
	if (playing) return;
	if (armSong < 0 && order.length && order[0] >= MED && !med) prepareMedley(order[0] - MED);
	var s = armSong >= 0 ? armSong : (order.length ? order[0] : -1);
	if (s < 0 || s >= MED) { song.call("start_playing"); return; }
	var inside = curSong == s;
	guard("warpguard", warpBeforePlay)(s);
	setProp("back_to_arranger", 0);
	var from = inside ? t : songs[s].start;
	// from the middle of a section: back to where that section starts
	if (inside) {
		var sc = songs[s].sections, j0 = 0;
		for (var j = sc.length - 1; j >= 0; j--) if (from >= sc[j].start - 0.02) { j0 = j; break; }
		if (sc[j0] && Math.abs(from - sc[j0].start) > 0.02) { from = sc[j0].start; moveTo(from); }
	}
	if (!inside) moveTo(from);
	if (inside && precountBars && startCountIn(s, from)) return;
	startFrom(from);
}

// ------------------------------------------------------------------ count-in
// Starting at a section other than the first one: play from N bars earlier
// with the band muted, so the click counts in and the voice names the
// section; the band comes in on its downbeat.
function songTrackIds(withGuide) {
	var ids = trackIds(), out = [];
	for (var i = 0; i < ids.length; i++) {
		var id = ids[i];
		if (id == ownTrackId || id == clickTrackId || id == tailTrackId) continue;
		trackApi.id = id;
		var nm = str(trackApi.get("name"));
		if (CLICK_RE.test(nm)) continue;
		if (!withGuide && GUIDE_RE.test(nm)) continue;
		out.push({ id: id, name: nm });
	}
	return out;
}

function startCountIn(s, at) {
	var sg = songs[s], bl = barLen(), j = -1;
	for (var k = sg.sections.length - 1; k >= 0; k--) if (at >= sg.sections[k].start - 0.02) { j = k; break; }
	if (j < 1) return false; // the first section has its own start
	// the band comes in on a downbeat: the bar the playhead is in
	var S = sg.start + Math.floor((at - sg.start) / bl + 0.02) * bl;
	if (S < sg.sections[j].start) S = sg.sections[j].start;
	var from = Math.max(sg.start, S - precountBars * bl);
	if (from > S - bl + 0.01) return false;
	var muted = [], list = songTrackIds(true);
	for (var i = 0; i < list.length; i++) {
		trackApi.id = list[i].id;
		if (num(trackApi.get("mute"))) continue;
		trackApi.set("mute", 1);
		muted.push(list[i].id);
	}
	pre = { song: s, sec: j, S: S, from: from, ids: muted, at: clock, started: 0 };
	armedKey = null;
	moveTo(from);
	startFrom(from);
	log("count-in " + precountBars + " bars into " + sg.sections[j].name + " at " + S);
	return true;
}

function endCountIn() {
	if (!pre) return;
	for (var i = 0; i < pre.ids.length; i++) {
		trackApi.id = pre.ids[i];
		try { trackApi.set("mute", 0); } catch (e) { }
	}
	pre = null;
	armedKey = null;
}

function runCountIn() {
	// Live confirms that it plays a moment after it is asked to
	if (!playing) { if (pre.started || clock - pre.at > 1500) endCountIn(); return; }
	pre.started = 1;
	// a tick early (about 25 ms) so the band's first note is never cut, plus
	// the time Live takes to apply it
	var lead = (0.025 + writeLead) * tempo / 60;
	// Live may start from its own selection for a moment before the start is corrected
	if (wantStart && (t < pre.from - 0.5 || t > pre.S + 0.5)) return;
	if (t >= pre.S - lead || t < pre.from - 0.5) endCountIn();
}

function precount(n) {
	n = parseInt(n, 10);
	if (!(n >= 1 && n <= 2)) return; // always on: 1 or 2 bars
	precountBars = n;
	saveStore();
	publishStruct();
}

function cuesource(n) {
	cueSource = parseInt(n, 10) ? 1 : 0;
	cueMap = {}; cueNext = 2; armedKey = null;
	saveStore();
	publishStruct();
}

function cuestyle(n) {
	n = parseInt(n, 10);
	if (n < 0 || n > 1) return;
	cueStyle = n;
	armedKey = null;
	saveStore();
	publishStruct();
}

// ------------------------------------------------------------------ band fade
// Fade the band out (click, Guide and cues keep going) and bring it back.
function bandVolumes() {
	var list = songTrackIds(false), out = [];
	for (var i = 0; i < list.length; i++) {
		trackApi.id = list[i].id;
		if (num(trackApi.get("is_foldable"))) continue;
		var vol = volumeParam(list[i].id);
		if (!vol) continue;
		paramApi.id = vol;
		out.push({ id: vol, orig: num(paramApi.get("value")) });
	}
	return out;
}

function fadeout(ms) {
	ms = Math.max(300, Math.min(30000, parseInt(ms, 10) || 4000));
	if (fade && fade.dir < 0) return;
	if (!faded) faded = bandVolumes();
	startFade(-1, ms);
	log("band fade out " + ms + " ms");
}

function fadein(ms) {
	ms = Math.max(300, Math.min(30000, parseInt(ms, 10) || 3000));
	if (!faded) return;
	startFade(1, ms);
	log("band fade in " + ms + " ms");
}

function startFade(dir, ms) {
	var start = [];
	for (var i = 0; i < faded.length; i++) { paramApi.id = faded[i].id; start.push(num(paramApi.get("value"))); }
	fade = { dir: dir, at: clock, ms: ms, start: start };
	lastSent = "";
}

function runFade() {
	var p = Math.min(1, (clock - fade.at) / fade.ms);
	var e = fade.dir < 0 ? 1 - Math.pow(1 - p, 2) : p * (2 - p);
	for (var i = 0; i < faded.length; i++) {
		var target = fade.dir < 0 ? 0 : faded[i].orig;
		paramApi.id = faded[i].id;
		paramApi.set("value", fade.start[i] + (target - fade.start[i]) * e);
	}
	if (p >= 1) {
		if (fade.dir > 0) faded = null;
		fade = null;
		lastSent = "";
	}
}

// back to the mix at once (stop, another song)
function restoreFade() {
	if (!faded) return;
	for (var i = 0; i < faded.length; i++) { paramApi.id = faded[i].id; paramApi.set("value", faded[i].orig); }
	faded = null;
	fade = null;
	lastSent = "";
}

// ------------------------------------------------------------------ section automation
// Per section: mute or level for some tracks. Applied when the section
// starts; tracks go back to the mix when a section has nothing for them.
function autoFor(s, j) {
	var a = songs[s] && opt(s).auto;
	return (a && a[j]) || null;
}

function setVol(trackId, v) {
	var vol = volumeParam(trackId);
	if (!vol) return;
	if (faded) {
		for (var i = 0; i < faded.length; i++) if (faded[i].id == vol) { faded[i].orig = v; return; }
	}
	paramApi.id = vol;
	paramApi.set("value", v);
}

function getVol(trackId) {
	var vol = volumeParam(trackId);
	if (!vol) return 0;
	if (faded) for (var i = 0; i < faded.length; i++) if (faded[i].id == vol) return faded[i].orig;
	paramApi.id = vol;
	return num(paramApi.get("value"));
}

function applyAuto(s, j) {
	var key = s + ":" + j;
	if (key == autoAt) return;
	autoAt = key;
	var want = autoFor(s, j) || {};
	var list = songTrackIds(true), n = 0;
	for (var i = 0; i < list.length; i++) {
		var id = list[i].id, w = want[normTrack(list[i].name)];
		trackApi.id = id;
		if (w) {
			if (!autoState[id]) autoState[id] = { vol: getVol(id), mute: num(trackApi.get("mute")) };
			trackApi.id = id;
			var m = w.m != null ? w.m : autoState[id].mute;
			if (num(trackApi.get("mute")) != m) trackApi.set("mute", m);
			setVol(id, w.v != null ? w.v : autoState[id].vol);
			n++;
		} else if (autoState[id]) {
			trackApi.id = id;
			trackApi.set("mute", autoState[id].mute);
			setVol(id, autoState[id].vol);
			delete autoState[id];
		}
	}
	mix.dirty = true;
}

function clearAuto() {
	for (var id in autoState) {
		if (!autoState.hasOwnProperty(id)) continue;
		trackApi.id = +id;
		try { trackApi.set("mute", autoState[id].mute); setVol(+id, autoState[id].vol); } catch (e) { }
	}
	autoState = {};
	autoAt = "";
	mix.dirty = true;
}

// dashboard: song, section, track, level x1000 (-1 = keep), mute (-1 = keep)
function autoset(s, j, id, v, m) {
	s = parseInt(s, 10); j = parseInt(j, 10); v = parseInt(v, 10); m = parseInt(m, 10);
	if (!songs[s] || !songs[s].sections[j]) return;
	trackApi.id = num(id);
	var nm = str(trackApi.get("name"));
	if (!nm) return;
	var o = opt(s);
	if (!o.auto) o.auto = {};
	if (!o.auto[j]) o.auto[j] = {};
	var e = o.auto[j][normTrack(nm)] || {};
	if (v >= 0) e.v = Math.max(0, Math.min(1, v / 1000));
	if (m >= 0) e.m = m ? 1 : 0;
	o.auto[j][normTrack(nm)] = e;
	autoChanged(s, j);
}

function autoclear(s, j, id) {
	s = parseInt(s, 10); j = parseInt(j, 10);
	var o = songs[s] && opt(s);
	if (!o || !o.auto || !o.auto[j]) return;
	if (num(id) < 0) delete o.auto[j];
	else {
		trackApi.id = num(id);
		delete o.auto[j][normTrack(str(trackApi.get("name")))];
		var any = false;
		for (var k in o.auto[j]) if (o.auto[j].hasOwnProperty(k)) any = true;
		if (!any) delete o.auto[j];
	}
	autoChanged(s, j);
}

function autoChanged(s, j) {
	saveStore();
	publishStruct();
	if (playing && curSong == s) { autoAt = ""; applyAuto(curSong, curSec); }
}

// ------------------------------------------------------------------ section edit
// Move the start of a section (its locator) to a new beat. Live's locators
// can't be moved from Max, so it is deleted and made again with its name.
function movesec(s, j, at100) {
	s = parseInt(s, 10); j = parseInt(j, 10);
	var sg = songs[s];
	if (!sg || playing || job) return;
	var sec = sg.sections[j];
	if (!sec || j < 1 || sec.implicit) return;
	var at = parseInt(at100, 10) / 100;
	var prev = sg.sections[j - 1];
	var minGap = 4 / (sigDen || 4);
	if (at < prev.start + minGap - 0.001 || at > sec.end - minGap + 0.001) { log("section edge out of range"); return; }
	if (Math.abs(at - sec.start) < 0.001) return;
	var back = t;
	job = { steps: [
		{ type: "zoom", dir: 3 },
		{ type: "uncue", time: sec.start },
		{ type: "cue", time: at, name: sec.name },
		{ type: "zoom", dir: 2 },
		{ type: "fin", back: back, what: sec.name + " -> " + at }
	], i: 0, P: back, dest: {}, title: "", warp: {}, edit: 1 };
	// keep its automation with it: same section index
}

// ------------------------------------------------------------------ waveform
// The server draws the song from its stems; it needs the clips and their timing.
function wave(s) {
	s = parseInt(s, 10);
	if (!songs[s]) return;
	var sg = songs[s];
	var plan = mixPlan(s, sg.start, sg.end);
	plan.kind = "wave";
	plan.bars = Math.max(1, Math.round((sg.end - sg.start) / barLen()));
	waveId++;
	var d = new Dict(WAVE_DICT);
	d.parse(JSON.stringify(plan));
	outlet(0, "waveprep", waveId);
}

function stop() {
	if (playing) {
		song.call("stop_playing");
		playing = 0;
		if (queue) { restoreQuant(queue); queue = null; }
		finishRamp();
		endCountIn();
		restoreFade();
		clearAuto();
		if (tailPresent()) messnamed("setpilot_tail", "stop");
	} else {
		// second stop: back to the start of the song
		var s = armSong >= 0 ? armSong : curSong;
		if (s >= 0) moveTo(songs[s].start);
	}
}

function toggle() { if (playing) stop(); else play(); }

function selectsong(s, now) {
	if (s >= MED) { selectmed(s - MED, now); return; }
	if (s < 0 || s >= songs.length) return;
	if (!playing) { prepareSong(s); return; }
	if (s == curSong && !med) return;
	if (now) { queueSection(s, firstSec(s), 1, 0, arrOf(s) ? 0 : null); return; }
	pendingSong = (pendingSong == s) ? -1 : s;
}

function playsong(s) {
	if (s >= MED) { if (playing) selectmed(s - MED, 1); else { prepareMedley(s - MED); play(); } return; }
	if (s < 0 || s >= songs.length) return;
	if (playing) selectsong(s, 1); else startSong(s);
}

function section(s, j, now) { queueSection(s, j, now, 0); }

function loop(s, j) {
	if (loopState && loopState.song == s && loopState.sec == j && !loopState.once) { clearLoop(); return; }
	if (playing && s == curSong && j == curSec) { setLoop(s, j, 0); return; }
	queueSection(s, j, 0, 1);
}

function repeat(s, j) {
	if (s == undefined || s < 0) { s = curSong; j = curSec; }
	if (s < 0) return;
	if (playing && s == curSong && j == curSec) setLoop(s, j, 1);
}

function loopoff() { clearLoop(); }

function cancel() {
	if (queue && !queue.fired) queue = null;
	pendingSong = -1;
}

function nextsong() {
	var base = med ? MED + med.i : (playing ? curSong : (armSong >= 0 ? armSong : curSong));
	var p = setlistPos(base);
	var n = order[p + 1];
	if (n == undefined) return;
	if (playing) selectsong(n, 0); else prepareSong(n);
}

function prevsong() {
	var base = med ? MED + med.i : (playing ? curSong : (armSong >= 0 ? armSong : curSong));
	var p = setlistPos(base);
	if (p <= 0) { if (base >= 0 && !playing) prepareSong(base); return; }
	if (playing) selectsong(order[p - 1], 0); else prepareSong(order[p - 1]);
}

function nextsec() {
	if (curSong < 0) return;
	var n = curSec + 1;
	if (n < songs[curSong].sections.length) section(curSong, n, 0);
}

function prevsec() {
	if (curSong < 0) return;
	var n = Math.max(0, curSec - 1);
	section(curSong, n, 0);
}

function setorder() {
	var a = arrayfromargs(arguments);
	var seen = {}, res = [];
	for (var i = 0; i < a.length; i++) {
		var v = parseInt(a[i], 10);
		var ok = (v >= 0 && v < songs.length) || (v >= MED && v - MED < medleys.length);
		if (ok && !seen[v]) { seen[v] = 1; res.push(v); }
	}
	for (var k = 0; k < songs.length; k++) if (!seen[k]) res.push(k);
	for (var m = 0; m < medleys.length; m++) if (!seen[MED + m]) res.push(MED + m);
	order = res;
	tailDirty = true;
	saveStore();
	publishStruct();
}

function latency(ms) {
	writeLead = Math.max(0, Math.min(0.25, num(ms) / 1000));
	log("write latency " + Math.round(writeLead * 1000) + " ms");
}

function autostop(v) { transdefault(v ? TR_CUE : TR_LINK); }

function refresh() { dirty = true; structSig = ""; }



function anything() {
	log("unknown command", messagename);
}

// ------------------------------------------------------------------ voice cues

function cleanCue(name) {
	return String(name)
		.replace(/\s*[\(\[]?\s*x\s*\d+\s*[\)\]]?\s*$/i, "")
		.replace(/[_]+/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^\s+|\s+$/g, "");
}

function loadedCues() {
	var out = [];
	for (var k in cueMap) if (cueMap.hasOwnProperty(k)) out.push(k);
	return out;
}

// the name of the spoken file for a cue: the text alone, or with the count
// at the tempo and meter it will be said in ("Chorus@72@4")
function cueKey(text, s, mi, src) {
	if (mi == null && med && medHas(med.i, s)) mi = med.i;
	if (mi != null && medleys[mi]) {
		var mk = text;
		if (cueStyle) mk = text + "@" + Math.round((medleys[mi].bpm || effTempo(s)) * 100) / 100 + "@" + sigNum;
		return "u|" + medleys[mi].id + "|" + mk;
	}
	var k = text;
	if (cueStyle && s >= 0 && songs[s]) k = text + "@" + Math.round(effTempo(s) * 100) / 100 + "@" + sigNum;
	// the server answers with the song's own guide when it has that cue, else the Mac voice
	// (a medley's section: the guide of the song it comes from)
	if (cueSource && s >= 0 && songs[s]) k = "g|" + (src || songs[s].name) + "|" + k;
	return k;
}

function cueTexts() {
	var seen = {}, out = [];
	function add(c, s, mi, src) {
		var k = cueKey(c, s, mi, src);
		if (c && !seen[k]) { seen[k] = 1; out.push(k); }
	}
	// medleys: one voice and one tempo for all their cues
	for (var mi = 0; mi < medleys.length; mi++) {
		var sl = medSlots(mi);
		for (var q = 0; q < sl.length; q++) add(cleanCue(songs[sl[q].s].sections[sl[q].j].name), sl[q].s, mi);
	}
	for (var i = 0; i < songs.length; i++) {
		var md = medOf(i);
		for (var j = 0; j < songs[i].sections.length; j++) {
			add(cleanCue(songs[i].sections[j].name), i);
			if (md) add(cleanCue(songs[i].sections[j].name), i, null, songIdentityAt(i, songs[i].sections[j].start));
		}
		// a change of song is announced by its name (plain, never counted)
		var names = [songs[i].name];
		if (md && md.parts) for (var pk = 0; pk < md.parts.length; pk++) names.push(md.parts[pk].song);
		for (var nk = 0; nk < names.length; nk++) { var an = cleanCue(names[nk]); if (an && !seen[an]) { seen[an] = 1; out.push(an); } }
		// the next song's first section is announced in this song's tempo
		var n = order.length ? order[(setlistPos(i) + 1) % order.length] : -1;
		if (n >= MED) { var ms = medSlots(n - MED); n = ms.length ? ms[0].s : -1; }
		if (cueStyle && n >= 0 && n != i && songs[n] && songs[n].sections[firstSec(n)]) add(cleanCue(songs[n].sections[firstSec(n)].name), i);
	}
	return out;
}

// beats from the start of the arrangement -> Max transport "bars beats units"
function toBBU(T) {
	var bl = barLen(), beatLen = 4 / (sigDen || 4);
	var bar = Math.floor(T / bl + 1e-9);
	var within = T - bar * bl;
	var beat = Math.floor(within / beatLen + 1e-9);
	var units = Math.round((within - beat * beatLen) * 480);
	if (units >= Math.round(beatLen * 480)) { units = 0; beat++; }
	return [bar + 1, beat + 1, units];
}

// What really comes after the current section, and when to announce it.
function computePlan() {
	if (pre && playing && cueMode != CUE_OFF) {
		var ps = songs[pre.song], psec = ps && ps.sections[pre.sec];
		if (psec) {
			var pbl = barLen(), ptext = cleanCue(psec.name);
			var pAt = Math.max(pre.from, pre.S - (cueStyle ? 1 : cueBars) * pbl);
			return { cueAt: pAt, B: pre.S, text: ptext, natural: false, now: false, song: pre.song,
				key: "pre|" + ptext + "@" + Math.round(pAt * 1000) + "|" + cueMode };
		}
	}
	if (!playing || curSong < 0 || cueMode == CUE_OFF) return null;
	var s = songs[curSong], sec = s.sections[curSec], bl = barLen();
	if (!sec) return null;
	var B = sec.end, target = null, natural = false, now = false;

	if (queue) {
		target = songs[queue.song] && songs[queue.song].sections[queue.sec];
		natural = !!queue.contiguous;
		if (queue.now) { now = true; B = Math.ceil((t + 0.001) / bl) * bl; }
	} else if (loopState && loopState.song == curSong && loopState.sec == curSec) {
		target = sec;
	} else if (med) {
		return null;
	} else {
		var ho = handoverPlan(curSong);
		if (ho && sec.start < ho.J - 0.001 && sec.end >= ho.J - 0.001) {
			target = songs[ho.n].sections[ho.sec || 0];
			natural = ho.natural;
			B = ho.J;
		} else if (curSec + 1 < s.sections.length && arrEnd(curSong) >= s.end - 0.001) {
			target = s.sections[curSec + 1];
			natural = true;
		}
	}
	if (!target) return null;
	var cueAt = now ? t : Math.max(sec.start, B - (cueStyle ? 1 : cueBars) * bl);
	var text = cleanCue(target.name);
	// going into another song (the next part of a medley, a jump to another song's
	// section, the next song in the setlist): its name first, two bars before the
	// section's cue, so the band knows where they are going
	var ts = queue ? queue.song : (target.start >= s.end - 0.001 ? songAtTime(target.start) : curSong);
	var src = ts >= 0 ? songIdentityAt(ts, target.start) : "";
	var ann = !now && src && src != songIdentityAt(curSong, t) ? cleanCue(src) : "";
	// said once: a plan that shifts a little (the handover point, a tempo change)
	// must not say the name again over itself
	if (ann && t < cueAt - 0.25) {
		var annAt = Math.max(sec.start, cueAt - 2 * bl);
		var akey = "ann|" + ann + "@" + Math.round(annAt * 1000) + "|" + cueMode;
		if (!(annSaid && annSaid.text == ann && annSaid.key != akey && t >= annSaid.at - 0.05 && t < annSaid.B + 2 * bl))
			return { cueAt: annAt, B: cueAt, text: ann, natural: false, now: false, song: curSong, announce: 1, key: akey };
	}
	return {
		cueAt: cueAt, B: B, text: text, natural: natural, now: now, song: curSong, src: src,
		key: text + "@" + Math.round(cueAt * 1000) + "|" + (natural ? 1 : 0) + "|" + cueMode + "|" + Math.round(B * 1000)
	};
}

function gatePresent() { return gateTrackId && clock - gateSeen < 8000; }
function clickPresent() { return clickTrackId && clock - clickSeen < 8000; }

function setGate(v, force) {
	if (!gatePresent()) return;
	if (gateNow === v && !force) return;
	gateNow = v;
	messnamed("setpilot_gate", "gatenow", v);
}

// The mode in effect: "every cue" needs something to say them. Without a
// voice player SetPilot still fixes the Guide: it silences the Guide's own
// cue when the next section is not the one the Guide is about to announce.
function effCueMode() { return cueMode == CUE_ALL && !voicePlayer ? CUE_FIX : cueMode; }

function runCues() {
	var cueMode = effCueMode();
	var p = computePlan();
	var speak = p && (cueMode == CUE_ALL || !p.natural);
	var key = speak ? p.key : "";
	var gp = gatePresent();

	// no SetPilot Guide device: follow the same plan with Live's mute (less exact)
	if (cueMode == CUE_FIX && !gp) {
		var muteWin = speak && t >= p.cueAt - 0.35 && t < p.B + 0.25;
		muteTracks(guideIds, muteWin ? 1 : 0, mutedGuide);
	}

	if (key !== armedKey) {
		armedKey = key;
		if (!speak) {
			outlet(1, "cuearm", FAR[0], FAR[1], FAR[2]);
			if (gp) messnamed("setpilot_gate", "gatearm", FAR[0], FAR[1], FAR[2]);
			if (cueMode != CUE_ALL) setGate(1, true);
		} else {
			if (p.announce) annSaid = { text: p.text, at: Math.max(t, p.cueAt), B: p.B, key: p.key };
			var idx = p.announce ? (cueMap[p.text] || 0) : ((p.src && cueMap[cueKey(p.text, p.song, null, p.src)]) || cueMap[cueKey(p.text, p.song)] || cueMap[p.text] || 0);
			var beat = 4 / (sigDen || 4);
			if (cueMode == CUE_FIX && p.cueAt - 0.25 > t) setGate(1, true);
			if (!p.now && p.cueAt > t + 0.03) {
				var a = toBBU(p.cueAt);
				outlet(1, "cueidx", idx);
				outlet(1, "cuearm", a[0], a[1], a[2]);
				if (cueMode == CUE_FIX && gp) {
					var g = toBBU(Math.max(t + 0.03, p.cueAt - 0.25));
					messnamed("setpilot_gate", "gateval", 0);
					messnamed("setpilot_gate", "gatearm", g[0], g[1], g[2]);
				}
			} else if (t < p.B - beat * 0.5) {
				// decided late (inside the cue bar) or "go now": say it right away
				outlet(1, "cuearm", FAR[0], FAR[1], FAR[2]);
				if (idx) outlet(1, "play", idx);
				if (cueMode == CUE_FIX) setGate(0);
			}
		}
	}

	var msg = speak ? ("1 " + (p.natural ? 1 : 0) + " " + p.text) : (p ? "0 1 " + p.text : "0 0");
	if (msg != lastPlanMsg) {
		lastPlanMsg = msg;
		outlet(0, "cueplan", speak ? 1 : 0, p && p.natural ? 1 : 0, p ? p.text : "");
	}
}

function applyMode() {
	armedKey = null;
	var gp = gatePresent();
	if (effCueMode() == CUE_ALL) {
		if (gp) { setGate(0, true); muteTracks(guideIds, 0, mutedGuide); }
		else muteTracks(guideIds, 1, mutedGuide);
	} else {
		setGate(1, true);
		muteTracks(guideIds, 0, mutedGuide);
	}
}

function muteTracks(ids, v, map) {
	for (var k in map) {
		// forget tracks that are no longer in the list (renamed, deleted, now a companion)
		if (map.hasOwnProperty(k) && ids.indexOf(+k) < 0) {
			trackApi.id = +k;
			try { trackApi.set("mute", 0); } catch (e) { }
			delete map[k];
		}
	}
	for (var i = 0; i < ids.length; i++) {
		var id = ids[i];
		var mine = map[id];
		if (v && !mine) {
			trackApi.id = id;
			if (num(trackApi.get("mute"))) continue; // already muted by the user: leave it
			trackApi.set("mute", 1);
			map[id] = 1;
		} else if (!v && mine) {
			trackApi.id = id;
			trackApi.set("mute", 0);
			delete map[id];
		}
	}
}

function trackIds() {
	var raw = getProp("tracks") || [], ids = [];
	for (var i = 0; i < raw.length; i++) if (raw[i] == "id") { ids.push(num(raw[i + 1])); i++; }
	return ids;
}

function scanTracks() {
	try {
		var me = new LiveAPI(null, "this_device canonical_parent");
		ownTrackId = num(me.id);
		var ids = trackIds();
		var g = [], gn = [], c = [], cn = [];
		for (var i = 0; i < ids.length; i++) {
			var id = ids[i];
			if (id == ownTrackId || id == gateTrackId || id == clickTrackId || id == tailTrackId) continue;
			trackApi.id = id;
			var nm = str(trackApi.get("name"));
			if (GUIDE_RE.test(nm)) { g.push(id); gn.push(nm); }
			else if (CLICK_RE.test(nm)) { c.push(id); cn.push(nm); }
		}
		var changed = g.join() != guideIds.join() || c.join() != clickIds.join();
		guideIds = g; guideNames = gn; clickIds = c; clickNames = cn;
		if (changed) { applyMode(); applyClickMutes(); structSig = ""; dirty = true; }
	} catch (e) { log("track scan failed: " + e.message); }
}

// ------------------------------------------------------------------ mixer
// Every track's fader, mute and solo, for the dashboard's mixer.

function colorHex(c) {
	c = Math.max(0, Math.round(num(c)));
	var h = c.toString(16);
	while (h.length < 6) h = "0" + h;
	return "#" + h;
}

function mixKind(id) {
	if (id == ownTrackId) return "cues";
	if (id == clickTrackId) return "click";
	if (id == tailTrackId) return "tail";
	return "";
}

// track list and parameter ids, rebuilt when tracks come and go
function mixRefresh(ids) {
	var list = [];
	for (var i = 0; i < ids.length; i++) {
		trackApi.id = ids[i];
		var md = trackApi.get("mixer_device");
		var vol = 0;
		if (md && md[0] == "id") {
			mixApi.id = num(md[1]);
			var v = mixApi.get("volume");
			if (v && v[0] == "id") vol = num(v[1]);
		}
		list.push({ id: ids[i], vol: vol, db: "", last: -1 });
	}
	// the main output last
	try {
		mixApi.goto("live_set master_track mixer_device volume");
		list.push({ id: -1, vol: num(mixApi.id), db: "", last: -1, main: 1 });
	} catch (e) { }
	mix.tracks = list;
}

function pollMixer() {
	mix.at = clock;
	mix.dirty = false;
	var ids = trackIds(), key = ids.join(",");
	if (key != mix.ids) { mix.ids = key; mixRefresh(ids); }
	var out = [];
	for (var i = 0; i < mix.tracks.length; i++) {
		var tr = mix.tracks[i], row;
		var value = 0;
		if (tr.vol) { paramApi.id = tr.vol; value = num(paramApi.get("value")); }
		if (Math.abs(value - tr.last) > 0.0001) {
			tr.last = value;
			tr.db = "";
			if (tr.vol) try { tr.db = str(paramApi.call("str_for_value", value)); } catch (e) { }
		}
		if (tr.main) {
			row = { id: -1, name: "Main", color: "", vol: value, db: tr.db, mute: 0, solo: 0, kind: "main" };
		} else {
			trackApi.id = tr.id;
			var tname = str(trackApi.get("name"));
			row = {
				id: tr.id, name: tname, instr: mixKind(tr.id) ? "" : instrOf(tname),
				out: routeName(trackApi), color: colorHex(trackApi.get("color")),
				vol: Math.round(value * 1000) / 1000, db: tr.db,
				mute: num(trackApi.get("mute")), solo: num(trackApi.get("solo")),
				group: num(trackApi.get("is_foldable")), inGroup: num(trackApi.get("is_grouped")),
				kind: mixKind(tr.id)
			};
		}
		out.push(row);
	}
	// the volume curve (Live's dB for each fader position), so the dashboard can
	// show the number while a fader moves
	if (!mix.curve) {
		for (var ci = 0; ci < mix.tracks.length && !mix.curve; ci++) {
			if (!mix.tracks[ci].vol) continue;
			paramApi.id = mix.tracks[ci].vol;
			var cv = [];
			try {
				for (var cx = 0; cx <= 100; cx++) {
					var cs = str(paramApi.call("str_for_value", cx / 100)), cd = parseFloat(cs);
					cv.push(/inf/i.test(cs) || isNaN(cd) ? null : Math.round(cd * 100) / 100);
				}
				mix.curve = cv;
			} catch (e) { }
		}
	}
	var json = JSON.stringify({ tracks: out, curve: mix.curve || null });
	if (json == mix.sig) return;
	mix.sig = json;
	var d = new Dict(MIX_DICT);
	d.parse(json);
	outlet(0, "mixer", clock);
}

function sendMeters() {
	mix.meterAt = clock;
	var a = ["meters"];
	for (var i = 0; i < mix.tracks.length; i++) {
		var tr = mix.tracks[i];
		if (tr.main) mixApi.goto("live_set master_track");
		else mixApi.id = tr.id;
		// the level as it is (left/right) and Live's own peak hold (output_meter_level)
		var pk = num(mixApi.get("output_meter_level"));
		var lv = Math.max(num(mixApi.get("output_meter_left")), num(mixApi.get("output_meter_right")));
		if (!(lv >= 0)) lv = pk;
		a.push(tr.id, Math.round(lv * 1000) / 1000, Math.round(pk * 1000) / 1000);
	}
	outlet(0, a);
}

function mixTrack(id) {
	for (var i = 0; i < mix.tracks.length; i++) if (mix.tracks[i].id == id) return mix.tracks[i];
	return null;
}

function mixvol(id, v) {
	var tr = mixTrack(num(id));
	if (!tr || !tr.vol) return;
	if (ramp) finishRamp();
	paramApi.id = tr.vol;
	paramApi.set("value", Math.max(0, Math.min(1, num(v) / 1000)));
	mix.dirty = true;
}

function mixmute(id, v) {
	var tr = mixTrack(num(id));
	if (!tr || tr.main) return;
	trackApi.id = tr.id;
	trackApi.set("mute", num(v) ? 1 : 0);
	mix.dirty = true;
}

function mixsolo(id, v) {
	var tr = mixTrack(num(id));
	if (!tr || tr.main) return;
	trackApi.id = tr.id;
	trackApi.set("solo", num(v) ? 1 : 0);
	mix.dirty = true;
}

// the dashboard has the mixer open: send meters for a while
function mixeron() {
	mix.meterUntil = clock + 8000;
	mix.sig = "";
	mix.dirty = true;
}

// ------------------------------------------------------------------ instruments and outputs

function parseLomDict(v, key) {
	try { var o = JSON.parse(str(v)); return o[key] !== undefined ? o[key] : o; } catch (e) { return null; }
}

function routeName(api) {
	var t = parseLomDict(api.get("output_routing_type"), "output_routing_type");
	var c = parseLomDict(api.get("output_routing_channel"), "output_routing_channel");
	if (!t) return "";
	return t.display_name + (c && c.display_name ? " " + c.display_name : "");
}

// the choices: Main, every Ext. Out channel and the tracks that can be a bus.
// Ext. Out channels are only listed while a track uses Ext. Out, so SP Tail
// (silent between songs) is switched there for a moment to read them.
function routeopts() {
	var probe = tailTrackId || 0;
	var sample = 0, ids = trackIds();
	for (var i = 0; i < ids.length && !sample; i++) {
		if (ids[i] == ownTrackId || ids[i] == clickTrackId || ids[i] == tailTrackId) continue;
		trackApi.id = ids[i];
		if (!num(trackApi.get("has_midi_input"))) sample = ids[i];
	}
	if (!sample) sample = probe;
	if (!sample) return;
	trackApi.id = sample;
	var types = parseLomDict(trackApi.get("available_output_routing_types"), "available_output_routing_types") || [];
	var list = [];
	var ext = null;
	for (var k = 0; k < types.length; k++) {
		var tn = types[k].display_name;
		if (/^ext/i.test(tn)) { ext = types[k]; continue; }
		if (/^(SP Cues|SP Click|SP Tail|SetPilot (Cues|Click|Tail|Crossfade))$/.test(tn)) continue;
		// Main, then the interface's outputs, then other tracks (buses) and Sends Only
		list.push({ type: tn, chan: "", label: tn, group: list.length ? "track" : "main" });
	}
	if (ext && probe && !playing && clock > tailPlayingUntil) {
		trackApi.id = probe;
		var was = parseLomDict(trackApi.get("output_routing_type"), "output_routing_type");
		var wasChan = parseLomDict(trackApi.get("output_routing_channel"), "output_routing_channel");
		var already = was && was.identifier == ext.identifier;
		try {
			if (!already) trackApi.set("output_routing_type", { identifier: ext.identifier });
			var chans = parseLomDict(trackApi.get("available_output_routing_channels"), "available_output_routing_channels") || [];
			var extList = [];
			for (var c = 0; c < chans.length; c++) extList.push({ type: ext.display_name, chan: chans[c].display_name, label: ext.display_name + " " + chans[c].display_name, group: "out" });
			list = list.slice(0, 1).concat(extList, list.slice(1));
		} catch (e) { log("could not read the outputs: " + e.message); }
		if (was && !already) try { trackApi.set("output_routing_type", { identifier: was.identifier }); } catch (e) { }
		if (wasChan && wasChan.identifier != null) try { trackApi.set("output_routing_channel", { identifier: wasChan.identifier }); } catch (e) { }
	}
	routes.list = list;
	routes.at = clock;
	publishRoutes();
}

function publishRoutes() {
	var d = new Dict(ROUTE_DICT);
	d.parse(JSON.stringify({ kinds: INSTR, spKinds: SPK, list: routes.list, outputs: instr.outputs }));
	outlet(0, "routes", clock);
}

// point one track at the output chosen for its kind of instrument
function routeTrack(id, kind) {
	var out = instr.outputs[kind];
	if ((!out || !out.type) && SPK_FOLLOW[kind]) out = instr.outputs[SPK_FOLLOW[kind]];
	if (!out || !out.type) return false;
	trackApi.id = id;
	var types = parseLomDict(trackApi.get("available_output_routing_types"), "available_output_routing_types") || [];
	var t = null;
	for (var i = 0; i < types.length; i++) if (types[i].display_name == out.type) t = types[i];
	if (!t) { log("output " + out.type + " not available for track " + id); return false; }
	var cur = parseLomDict(trackApi.get("output_routing_type"), "output_routing_type");
	if (!cur || cur.identifier != t.identifier) trackApi.set("output_routing_type", { identifier: t.identifier });
	if (out.chan) {
		var chans = parseLomDict(trackApi.get("available_output_routing_channels"), "available_output_routing_channels") || [];
		for (var c = 0; c < chans.length; c++) {
			if (chans[c].display_name == out.chan) {
				var cc = parseLomDict(trackApi.get("output_routing_channel"), "output_routing_channel");
				if (!cc || cc.identifier != chans[c].identifier) trackApi.set("output_routing_channel", { identifier: chans[c].identifier });
			}
		}
	}
	return true;
}

// route every song track (or only those of one kind) by its instrument
function applyOutputs(onlyKind) {
	var ids = trackIds(), n = 0;
	for (var i = 0; i < ids.length; i++) {
		var id = ids[i];
		if (id == ownTrackId || id == clickTrackId || id == tailTrackId) continue;
		trackApi.id = id;
		var nm = str(trackApi.get("name"));
		var kind = instrOf(nm);
		if (onlyKind && kind != onlyKind) continue;
		if (routeTrack(id, kind)) n++;
	}
	// SetPilot's channels (theirs, or the one they follow)
	var spIds = { spclick: clickTrackId, spcues: ownTrackId, sptail: tailTrackId };
	for (var si = 0; si < SPK.length; si++) {
		var sk = SPK[si];
		if (!spIds[sk]) continue;
		if (onlyKind && onlyKind != sk && onlyKind != SPK_FOLLOW[sk]) continue;
		if (routeTrack(spIds[sk], sk)) n++;
	}
	if (n) log("outputs applied to " + n + " tracks" + (onlyKind ? " (" + onlyKind + ")" : ""));
	mix.dirty = true;
}

// dashboard: kind index, choice index (-1 = leave the tracks alone)
function setoutput(k, r) {
	k = parseInt(k, 10); r = parseInt(r, 10);
	var kind = k >= 100 ? SPK[k - 100] : INSTR[k];
	if (!kind) return;
	if (r < 0 || !routes.list[r]) delete instr.outputs[kind];
	else {
		instr.outputs[kind] = { type: routes.list[r].type, chan: routes.list[r].chan };
		applyOutputs(kind);
	}
	saveStore();
	publishRoutes();
}

function applyoutputs() { applyOutputs(""); }

// dashboard: this track is another kind of instrument
function settrackinstr(id, k) {
	var kind = INSTR[parseInt(k, 10)];
	if (!kind) return;
	trackApi.id = num(id);
	var nm = str(trackApi.get("name"));
	if (!nm) return;
	instr.tracks[normTrack(nm)] = kind;
	routeTrack(num(id), kind);
	saveStore();
	mix.dirty = true;
	mix.sig = "";
}

// ------------------------------------------------------------------ companions

function ping() {
	messnamed("setpilot_gate", "ping");
	messnamed("setpilot_click", "ping");
	messnamed("setpilot_tail", "ping");
	var gp = gatePresent(), cp = clickPresent();
	if (gp != lastGp || cp != lastCp) {
		lastGp = gp; lastCp = cp;
		scanTracks(); applyMode(); applyClickMutes(); publishStruct();
	}
}
var lastGp = false, lastCp = false;

function lastNum(args) {
	var a = arrayfromargs(args);
	return num(a[a.length - 1]);
}

function gatehello() {
	var was = gatePresent();
	gateTrackId = lastNum(arguments);
	gateSeen = clock;
	if (!was) { log("guide gate on track " + gateTrackId); lastGp = true; scanTracks(); applyMode(); publishStruct(); }
}

function clickhello() {
	var was = clickPresent();
	clickTrackId = lastNum(arguments);
	clickSeen = clock;
	if (!was) { log("click on track " + clickTrackId); lastCp = true; scanTracks(); sendClick(); applyClickMutes(); publishStruct(); }
}

var tickLog = 0, wasPlaying = 0;
function clicktick() {
	if (playing && tickLog < 9) {
		tickLog++;
		log("click tick at " + Math.round(num(getProp("current_song_time")) * 100) / 100);
	}
}

// ------------------------------------------------------------------ click

function accentsFor(n) {
	var a = click.accents || [];
	if (a.length == n) return a;
	var out = [];
	for (var i = 0; i < n; i++) out.push(i < a.length ? a[i] : (i == 0 ? 2 : 1));
	click.accents = out;
	return out;
}

function sendClick() {
	var acc = accentsFor(sigNum), accMask = 0, muteMask = 0;
	for (var i = 0; i < acc.length; i++) {
		if (acc[i] == 2) accMask += Math.pow(2, i);
		if (acc[i] == 0) muteMask += Math.pow(2, i);
	}
	var P = ["on", click.on ? 1 : 0, "beats", sigNum, "sub", click.sub, "accmask", accMask, "mutemask", muteMask,
		"lvlacc", click.acc / 100, "lvlbeat", click.beat / 100, "lvlsub", click.subl / 100,
		"sound", click.sound, "gain", click.gain / 100,
		// songs' click stems land on this track too: heard only when SetPilot's click doesn't replace them
		"thru", click.on && click.muteSong ? 0 : 1];
	for (var k = 0; k < P.length; k += 2) messnamed("setpilot_click", "param", P[k], P[k + 1]);
}

function applyClickMutes() {
	var v = click.on && click.muteSong && clickPresent() ? 1 : 0;
	muteTracks(clickIds, v, mutedClick);
}

function clickChanged() {
	sendClick();
	applyClickMutes();
	saveStore();
	publishStruct();
}

function clickon(v) { click.on = v ? 1 : 0; clickChanged(); }
function clicksound(v) { click.sound = Math.max(0, Math.min(2, parseInt(v, 10) || 0)); clickChanged(); }
function clicksub(v) { v = parseInt(v, 10); if ([1, 2, 3, 4].indexOf(v) >= 0) { click.sub = v; clickChanged(); } }
function clickmute(v) { click.muteSong = v ? 1 : 0; clickChanged(); }
function clickaccent(i, state) {
	var a = accentsFor(sigNum);
	i = parseInt(i, 10); state = parseInt(state, 10);
	if (i < 0 || i >= a.length || [0, 1, 2].indexOf(state) < 0) return;
	a[i] = state;
	clickChanged();
}
function clicklevel(which, v) {
	v = Math.max(0, Math.min(150, parseInt(v, 10) || 0));
	var k = ["acc", "beat", "subl", "gain"][parseInt(which, 10)];
	if (!k) return;
	click[k] = v;
	clickChanged();
}

// ------------------------------------------------------------------ tempo and key

function opt(s) {
	var n = songs[s].name;
	if (!songOpts[n]) songOpts[n] = { bpm: 0, semis: 0 };
	return songOpts[n];
}

function baseBpm(s) {
	return songs[s].bpm || baseCache[songs[s].name] || 0;
}

// Called when a song starts or is prepared. SetPilot owns the tempo of every
// song that has a BPM (from the locator or chosen in the dashboard); other
// songs go back to the set's own tempo automation.
function applyTempo(s) {
	if (s < 0 || s >= songs.length) return;
	var o = opt(s), sg = songs[s];
	var target = medOf(s) ? medTempoAt(s, (t >= sg.start && t < sg.end) ? t : sg.start) : (medBpmFor(s) || o.bpm || sg.bpm);
	if (target) {
		if (Math.abs(tempo - target) > 0.004) { setProp("tempo", target); tempo = target; }
		tempoOverridden = true;
	} else {
		if (tempoOverridden) {
			try { song.call("re_enable_automation"); } catch (e) { }
			tempoOverridden = false;
		}
		if (!baseCache[sg.name]) baseCache[sg.name] = num(getProp("tempo"));
	}
}

function temposet(s, bpm10) {
	s = parseInt(s, 10);
	if (s < 0 || s >= songs.length) return;
	if (playing && s == curSong) { log("tempo and key are locked while the song plays"); return; }
	var o = opt(s);
	var v = parseInt(bpm10, 10) / 10;
	o.bpm = v > 0 ? Math.max(20, Math.min(300, v)) : 0;
	tailDirty = true;
	var live = playing ? curSong : (armSong >= 0 ? armSong : curSong);
	if (s == live) applyTempo(s);
	saveStore();
	publishStruct();
}

function keyset(s, semis) {
	s = parseInt(s, 10);
	if (s < 0 || s >= songs.length) return;
	if (playing && s == curSong) { log("tempo and key are locked while the song plays"); return; }
	semis = Math.max(-12, Math.min(12, parseInt(semis, 10) || 0));
	opt(s).semis = semis;
	applyKey(s);
	tailDirty = true;
	saveStore();
	publishStruct();
}

// Transposes the audio clips of one song, leaving click, guide and percussion alone.
function applyKey(s, override) {
	var sg = songs[s], semis = override == null ? (opt(s).semis || 0) : override;
	var ids = trackIds(), changed = 0;
	for (var i = 0; i < ids.length; i++) {
		var id = ids[i];
		if (id == ownTrackId || id == gateTrackId || id == clickTrackId || id == tailTrackId) continue;
		trackApi.id = id;
		if (NONPITCH_RE.test(str(trackApi.get("name")))) continue;
		if (num(trackApi.get("has_midi_input"))) continue;
		var raw = trackApi.get("arrangement_clips") || [];
		for (var k = 0; k < raw.length; k++) {
			if (raw[k] != "id") continue;
			clipApi.id = num(raw[k + 1]);
			k++;
			var st = num(clipApi.get("start_time"));
			if (st < sg.start - 0.01 || st >= sg.end - 0.01) continue;
			if (!num(clipApi.get("is_audio_clip"))) continue;
			var want = medOf(s) ? Math.max(-48, Math.min(48, medPitchAt(s, st) + semis)) : semis;
			if (num(clipApi.get("pitch_coarse")) != want) { clipApi.set("pitch_coarse", want); changed++; }
			if (want && num(clipApi.get("warping")) && num(clipApi.get("warp_mode")) != 6) clipApi.set("warp_mode", 6);
		}
	}
	if (changed || override == null) log("key " + sg.name + " " + (semis > 0 ? "+" : "") + semis + " (" + changed + " clips)");
}

function applyAllKeys() {
	for (var s = 0; s < songs.length; s++) if (opt(s).semis) applyKey(s);
}

// sent by the server when a cue file is ready (generated voice or custom file)
function cuefile(text, path) {
	text = str(text);
	var idx = cueMap[text];
	if (!idx) { idx = cueNext++; cueMap[text] = idx; }
	outlet(1, "preload", idx, str(path));
	armedKey = null; // re-arm with the right sample number
}

function cuefired(idx) { log("cue " + idx + " at " + Math.round(t * 100) / 100); }
function cuedone() { }
function cueaudio() { log("cue audio playing at " + Math.round(t * 100) / 100); }

function voiceplayer(v) {
	voicePlayer = num(v) ? 1 : 0;
	log("voice player " + (voicePlayer ? "present" : "absent"));
	applyMode();
}

function cuemode(m) {
	m = parseInt(m, 10);
	if (m < 0 || m > 2) return;
	cueMode = m;
	applyMode();
	saveStore();
	publishStruct();
}

function cuebars(n) {
	n = parseInt(n, 10);
	if (n < 1 || n > 2) return;
	cueBars = n;
	armedKey = null;
	saveStore();
	publishStruct();
}

function cuelang(n) {
	n = parseInt(n, 10);
	if (n < 0 || n > 2) return;
	cueLang = n;
	cueMap = {};
	cueNext = 2;
	saveStore();
	publishStruct();
}

function notifydeleted() {
	try { finishRamp(); endCountIn(); restoreFade(); clearAuto(); muteTracks([], 0, mutedGuide); muteTracks([], 0, mutedClick); } catch (e) { }
	if (task) task.cancel();
}



// ------------------------------------------------------------------ song import
// The server parses a song's Live Set (a MultiTracks download, for example)
// into a plan in the "setpilot_import" dict. Here it is appended to the show:
// a gap after the last song, stems on the tracks with the same name (new
// tracks when missing), clips warped straight at the song's tempo, and the
// song's markers turned into SetPilot locators.

var IMPORT_DICT = "setpilot_import";
var importDict = null;
var job = null;
var SYN = { click: "click", clic: "click", metronome: "click", metronomo: "click",
	guide: "guide", guides: "guide", cue: "guide", cues: "guide", guia: "guide", "vocal cues": "guide" };

function normTrack(n) {
	n = String(n).toLowerCase();
	n = n.replace(/[áàä]/g, "a").replace(/[éèë]/g, "e").replace(/[íìï]/g, "i").replace(/[óòö]/g, "o").replace(/[úùü]/g, "u");
	n = n.replace(/^[\s\d]+[-_.)\s]+/, "");
	if (n.indexOf(" - ") >= 0) n = n.slice(n.lastIndexOf(" - ") + 3);
	n = n.replace(/\([^)]*\)/g, " ").replace(/\btrack\b/g, " ").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
	return SYN[n] || n;
}

function importMsg(kind, a, b, c) {
	outlet(0, "importmsg", kind, a === undefined ? "" : a, b === undefined ? "" : b, c === undefined ? "" : c);
}

// end of the real content: last clip or last locator
function songEndBeats() {
	var last = 0;
	var ids = trackIds();
	for (var t = 0; t < ids.length; t++) {
		trackApi.id = ids[t];
		var raw = trackApi.get("arrangement_clips") || [];
		for (var k = 0; k < raw.length; k++) {
			if (raw[k] != "id") continue;
			clipApi.id = num(raw[k + 1]);
			k++;
			last = Math.max(last, num(clipApi.get("end_time")));
		}
	}
	var cues = readCues();
	for (var i = 0; i < cues.length; i++) last = Math.max(last, cues[i].time);
	return last;
}

function importplan() {
	if (job) { importMsg("error", "busy"); return; }
	if (playing) { importMsg("error", "playing"); return; }
	var plan;
	try { plan = JSON.parse(new Dict(IMPORT_DICT).stringify()); } catch (e) { importMsg("error", "plan"); return; }
	if (!plan || !plan.tracks) { importMsg("error", "plan"); return; }

	var bl = barLen();
	var last = songEndBeats();
	var gap = Math.max(0, parseInt(plan.gap, 10) || 16);
	var P = last > 0 ? Math.ceil(last / bl - 1e-6) * bl + gap * bl : 0;

	// destination tracks by normalized name (never the SetPilot cue/click tracks)
	var dest = {}, ids = trackIds(), spClick = 0;
	for (var i = 0; i < ids.length; i++) {
		var id = ids[i];
		if (id == ownTrackId || id == clickTrackId) continue;
		trackApi.id = id;
		if (num(trackApi.get("has_midi_input"))) continue;
		var tnm = str(trackApi.get("name"));
		if (tnm == "SetPilot Click") { spClick = id; continue; }
		var key = normTrack(tnm);
		if (!dest[key]) dest[key] = id;
	}
	// one click track: a song's click stem goes onto SetPilot Click (its plug-in
	// plays SetPilot's click there, or lets the stem through when that is off)
	if (!dest.click && (clickTrackId || spClick)) dest.click = clickTrackId || spClick;

	var steps = [{ type: "tempo", bpm: plan.bpm }];
	var created = 0, matched = 0, missing = 0;
	for (var ti = 0; ti < plan.tracks.length; ti++) {
		var src = plan.tracks[ti];
		var k = normTrack(src.name);
		var target = dest[k];
		if (!target) { steps.push({ type: "track", name: src.name, key: k }); dest[k] = "new:" + k; created++; }
		else if (String(target).indexOf("new:") < 0) matched++;
		for (var c = 0; c < src.clips.length; c++) {
			var cl = src.clips[c];
			if (!cl.file) { missing++; continue; }
			steps.push({ type: "clip", key: k, file: cl.file, pos: P + cl.time, startBeat: cl.startBeat || 0,
				length: cl.length || 0, maxEnd: cl.length > 0 ? P + cl.time + cl.length : 0, markers: cl.markers || (plan.bpm ? [[0, 0], [60 / plan.bpm, 1]] : null),
				mode: NONPITCH_RE.test(src.name) && !/guide|cue|gu[ií]a/i.test(src.name) ? 0 : 6, name: src.name });
		}
	}
	steps.push({ type: "verify" });
	steps.push({ type: "tempoback" });
	// new locators snap to the arrangement grid, which follows the zoom: zoom in while placing them
	steps.push({ type: "zoom", dir: 3 });
	steps.push({ type: "cue", time: P, name: header(plan) });
	for (var l = 0; l < plan.locators.length; l++) {
		var loc = plan.locators[l];
		if (loc.time <= 0.001) continue;          // the header takes the song start
		steps.push({ type: "cue", time: P + loc.time, name: loc.name });
	}
	var stopAt = Math.ceil(plan.end / bl - 1e-6) * bl;
	for (var m = 0; m < plan.locators.length; m++) if (Math.abs(plan.locators[m].time - stopAt) < 0.01) stopAt += bl;
	steps.push({ type: "cue", time: P + stopAt, name: "STOP" });
	steps.push({ type: "zoom", dir: 2 });
	steps.push({ type: "done" });

	if (plan.instr) for (var nmK in plan.instr) if (plan.instr.hasOwnProperty(nmK) && INSTR.indexOf(plan.instr[nmK]) >= 0) instr.tracks[normTrack(nmK)] = plan.instr[nmK];
	job = { steps: steps, i: 0, P: P, dest: dest, title: plan.title, savedTempo: tempo, warp: {} };
	importMsg("start", plan.title, steps.length, Math.round(P / bl) + 1);
	log("import " + plan.title + " at bar " + (Math.round(P / bl) + 1) + ": " + matched + " tracks matched, " + created + " new, " + missing + " missing files");
}

// Live may auto-warp a new clip with its own tempo guess (and even move the
// downbeat). Max can't add warp markers, but it can move them: put every
// marker Live made on the beat the original set gives its sample time.
function beatForSec(markers, sec) {
	var m = markers, i = 0;
	if (sec <= m[0][0]) i = 0;
	else { while (i < m.length - 2 && sec > m[i + 1][0]) i++; }
	var a = m[i], b = m[i + 1];
	return a[1] + (sec - a[0]) * (b[1] - a[1]) / (b[0] - a[0]);
}

function isStraight(src) {
	if (src.length < 3) return true;
	var k0 = (src[1][1] - src[0][1]) / (src[1][0] - src[0][0]);
	for (var i = 2; i < src.length; i++) {
		var k = (src[i][1] - src[i - 1][1]) / (src[i][0] - src[i - 1][0]);
		if (Math.abs(k - k0) > k0 * 0.001) return false;
	}
	return true;
}

function rewarp(clip, step) {
	var src = step.markers;
	if (!src || src.length < 2) return;
	var cur = markersOf(clip);
	if (!cur.length) return;
	var before = cur.length;
	// a straight original only needs two markers: drop the ones Live guessed in between
	if (isStraight(src) && cur.length > 2) {
		for (var d = cur.length - 2; d >= 1; d--) {
			try { clip.call("remove_warp_marker", cur[d].beat); } catch (e) { }
		}
		cur = markersOf(clip);
	}
	// one real marker (Live adds a helper 1/32 beat later): its tempo can't be moved,
	// so put a second marker at the end of the file (Live 12) and move that one
	var endSec = 0;
	try { endSec = num(clip.get("sample_length")) / (num(clip.get("sample_rate")) || 44100); } catch (e) { }
	if (cur.length == 2 && cur[1].beat - cur[0].beat < 0.1 && endSec > cur[1].sec + 1 && Math.abs(cur[1].beat - beatForSec(src, cur[1].sec)) > 0.0005) {
		var guess = cur[0].beat + (endSec - cur[0].sec) * (cur[1].beat - cur[0].beat) / (cur[1].sec - cur[0].sec);
		try { clip.call("add_warp_marker", { beat_time: guess, sample_time: endSec }); } catch (e) { }
		cur = markersOf(clip);
		if (cur.length == 2) { try { clip.call("add_warp_marker", guess, endSec); } catch (e) { } cur = markersOf(clip); }
		// the helper goes away once there is a real second marker
	}
	var plan = [];
	for (var i = 0; i < cur.length; i++) plan.push({ beat: cur[i].beat, sec: cur[i].sec, target: beatForSec(src, cur[i].sec) });
	var moved = 0;
	// rightward moves from the last marker back, then leftward moves from the first: no marker crosses another
	// Live's own helper ("shadow") marker, 1/32 beat after another, can't be
	// moved (Live 12 says so); skip it, and never let one refusal stop the rest
	var refused = 0;
	function move(m) {
		try { clip.call("move_warp_marker", m.beat, m.target - m.beat); moved++; }
		catch (e) { refused++; }
	}
	for (var r = plan.length - 1; r >= 0; r--) {
		if (r > 0 && plan[r].beat - plan[r - 1].beat < 0.1) continue;
		if (plan[r].target > plan[r].beat + 0.0005) move(plan[r]);
	}
	for (var l = 0; l < plan.length; l++) {
		if (l > 0 && plan[l].beat - plan[l - 1].beat < 0.1) continue;
		if (plan[l].target < plan[l].beat - 0.0005) move(plan[l]);
	}
	// check: every marker where it should be
	var after = markersOf(clip), worst = 0, bad = -1;
	for (var k = 0; k < after.length; k++) {
		var off = Math.abs(after[k].beat - beatForSec(src, after[k].sec));
		if (off > worst) { worst = off; if (off > 0.01 && bad < 0) bad = k; }
	}
	var msg = "rewarp " + step.name + ": " + before + " -> " + after.length + " markers, " + moved + " moved" + (refused ? ", " + refused + " refused by Live" : "") + ", off by " + Math.round(worst * 1000) / 1000 + " beats";
	if (bad >= 0) {
		var f = function (x) { return x ? x.beat.toFixed(3) + "@" + x.sec.toFixed(3) + "->" + beatForSec(src, x.sec).toFixed(3) : "-"; };
		msg += " (first bad #" + bad + ": " + f(after[bad - 1]) + " | " + f(after[bad]) + " | " + f(after[bad + 1]) + ")";
	}
	log(msg);
	fitClipEnd(clip, src, step.maxEnd, step.length || step.len || 0);
	return worst;
}

// Live keeps a clip's length in the arrangement when its warp changes: a clip
// warped too fast ends early (its last bars cut off), too slow runs on. Put the
// end where the audio ends on the new timing, never into the next song.
function fitClipEnd(clip, src, maxEnd, fixedLen) {
	try {
		if (num(clip.get("looping"))) return;
		var st = num(clip.get("start_time")), sm = num(clip.get("start_marker")), endBeat;
		if (fixedLen > 0) endBeat = sm + fixedLen;   // an imported clip: as long as in its own session
		else {
			var sr = num(clip.get("sample_rate")) || 44100, len = num(clip.get("sample_length"));
			if (!(len > 0)) return;
			endBeat = beatForSec(src, len / sr);
			if (maxEnd > 0) endBeat = Math.min(endBeat, sm + (maxEnd - st));
		}
		if (!(endBeat > sm + 0.1)) return;
		if (Math.abs(num(clip.get("end_marker")) - endBeat) > 0.01) clip.set("end_marker", endBeat);
		if (Math.abs(num(clip.get("loop_end")) - endBeat) > 0.01) clip.set("loop_end", endBeat);
	} catch (e) { log("clip end: " + e.message); }
}

// fix the clips of a song that is already in the set, with the timing kept at import
var rewarpQueue = [];
function rewarpsong(s) {
	s = parseInt(s, 10);
	var sg = songs[s];
	if (!sg) return;
	var o = opt(s), map = o.warp || {};
	var straight = [[0, 0], [60 / (sg.bpm || baseBpm(s) || tempo), 1]];
	var ids = trackIds();
	for (var i = 0; i < ids.length; i++) {
		if (ids[i] == ownTrackId || ids[i] == tailTrackId) continue;
		trackApi.id = ids[i];
		if (num(trackApi.get("has_midi_input"))) continue;
		var nm = str(trackApi.get("name"));
		var raw = trackApi.get("arrangement_clips") || [];
		for (var k = 0; k < raw.length; k++) {
			if (raw[k] != "id") continue;
			clipApi.id = num(raw[k + 1]); k++;
			var st = num(clipApi.get("start_time"));
			if (st < sg.start - 0.01 || st >= sg.end - 0.01 || !num(clipApi.get("is_audio_clip"))) continue;
			var file = str(clipApi.get("file_path"));
			rewarpQueue.push({ clip: num(raw[k]), name: nm, markers: map[file] || straight, maxEnd: sg.end });
		}
	}
	log("rewarp " + sg.name + ": " + rewarpQueue.length + " clips");
	// from now on this is the song's reference: the guard keeps it
	var store = {};
	for (var q = 0; q < rewarpQueue.length; q++) {
		clipApi.id = rewarpQueue[q].clip;
		store[str(clipApi.get("file_path"))] = compactWarp(rewarpQueue[q].markers);
	}
	if (rewarpQueue.length) warpGuard.fixing = { name: sg.name, n: rewarpQueue.length, store: store };
}

// ------------------------------------------------------------------ warp guard
// Every imported song keeps a reference of its stems' timing. While stopped,
// SetPilot checks the songs one by one and before playing it checks the song
// that starts: a clip whose warp changed (an Undo, Live re-analysing a file)
// is put back and the dashboard says so.
function compactWarp(src) {
	if (!src || src.length < 3) return src;
	return isStraight(src) ? [src[0], src[src.length - 1]] : src;
}

function songIndex(name) {
	for (var i = 0; i < songs.length; i++) if (songs[i].name == name) return i;
	return -1;
}

function songAudioClips(s) {
	var sg = songs[s], out = [], ids = trackIds();
	for (var i = 0; i < ids.length; i++) {
		if (ids[i] == ownTrackId || ids[i] == tailTrackId) continue;
		trackApi.id = ids[i];
		if (num(trackApi.get("has_midi_input"))) continue;
		var nm = str(trackApi.get("name"));
		var raw = trackApi.get("arrangement_clips") || [];
		for (var k = 0; k < raw.length; k++) {
			if (raw[k] != "id") continue;
			clipApi.id = num(raw[k + 1]); k++;
			var st = num(clipApi.get("start_time"));
			if (st < sg.start - 0.01 || st >= sg.end - 0.01 || !num(clipApi.get("is_audio_clip"))) continue;
			out.push({ id: num(raw[k]), name: nm, file: str(clipApi.get("file_path")) });
		}
	}
	return out;
}

// how far the clip clipApi points at is from its reference, in beats
function clipWarpOff(src) {
	if (!src || src.length < 2) return 0;
	if (!num(clipApi.get("warping"))) return 99;
	var cur = markersOf(clipApi);
	if (!cur.length) return 99;
	if (isStraight(src) && cur.length > 2) return 98;
	var worst = 0;
	for (var i = 0; i < cur.length; i++) worst = Math.max(worst, Math.abs(cur[i].beat - beatForSec(src, cur[i].sec)));
	return worst;
}

// how far the clip's end is from where its audio ends (unlooped clips)
function clipEndOff(src, maxEnd) {
	if (num(clipApi.get("looping"))) return 0;
	var sr = num(clipApi.get("sample_rate")) || 44100, len = num(clipApi.get("sample_length"));
	if (!(len > 0)) return 0;
	var endBeat = beatForSec(src, len / sr), st = num(clipApi.get("start_time")), sm = num(clipApi.get("start_marker"));
	if (maxEnd > 0) endBeat = Math.min(endBeat, sm + (maxEnd - st));
	return Math.abs(num(clipApi.get("loop_end")) - endBeat);
}

function warpRefOf(s) {
	var w = opt(s).warp;
	if (!w) return null;
	for (var k in w) if (w.hasOwnProperty(k)) return w;
	return null;
}

function warpBad(s) {
	var ref = warpRefOf(s);
	if (!ref) return [];
	var list = songAudioClips(s), bad = [];
	for (var i = 0; i < list.length; i++) {
		var src = ref[list[i].file];
		if (!src) continue;
		clipApi.id = list[i].id;
		if (warpGuard.gaveUp[list[i].id]) continue;
		if (clipWarpOff(src) > 0.01 || clipEndOff(src, songs[s].end) > 0.01) bad.push({ clip: list[i].id, name: list[i].name, markers: src, maxEnd: songs[s].end });
	}
	return bad;
}

// a song imported before the reference existed, or warped by hand: if its
// stems are clean and agree with each other (two markers on one tempo, or the
// very same markers on every stem), that becomes the reference
function adoptWarp(s) {
	var list = songAudioClips(s), ref = {}, first = null, rate = 0;
	if (!list.length) return false;
	for (var i = 0; i < list.length; i++) {
		clipApi.id = list[i].id;
		if (!num(clipApi.get("warping"))) return false;
		var m = markersOf(clipApi);
		if (m.length < 2) return false;
		if (m.length == 2) {
			if (m[1].sec <= m[0].sec) return false;
			var r = (m[1].beat - m[0].beat) / (m[1].sec - m[0].sec);
			if (rate && Math.abs(r - rate) > rate * 0.002) return false;
			rate = rate || r;
			if (first && first.length > 2) return false;
		} else {
			if (first && first.length != m.length) return false;
			if (first) for (var q = 0; q < m.length; q++) {
				if (Math.abs(m[q].beat - first[q].beat) > 0.001 || Math.abs(m[q].sec - first[q].sec) > 0.0005) return false;
			}
		}
		if (!first) first = m;
		var src = [];
		for (var k = 0; k < m.length; k++) src.push([m[k].sec, m[k].beat]);
		ref[list[i].file] = compactWarp(src);
	}
	opt(s).warp = ref;
	saveStore();
	log("warp guard: " + songs[s].name + " is clean, keeping it as the reference");
	return true;
}

function runWarpGuard() {
	if (playing || job || rewarpQueue.length || clearCues >= 0 || !songs.length) return;
	var s = -1;
	for (var q = 0; q < warpGuard.soon.length; q++) {
		if (clock >= warpGuard.soon[q].at) { s = songIndex(warpGuard.soon[q].name); warpGuard.soon.splice(q, 1); break; }
	}
	if (s < 0) {
		warpGuard.rr++;
		s = (warpGuard.rr % 2 && armSong >= 0) ? armSong : (warpGuard.rr >> 1) % songs.length;
	}
	if (!songs[s]) return;
	if (!warpRefOf(s)) { adoptWarp(s); return; }
	var bad = warpBad(s);
	if (!bad.length) return;
	log("warp guard: " + bad.length + " clips of " + songs[s].name + " changed their timing, fixing");
	for (var b = 0; b < bad.length; b++) rewarpQueue.push(bad[b]);
	warpGuard.fixing = { name: songs[s].name, n: bad.length };
}

// right before a song plays: fix it now, whatever it takes
function warpBeforePlay(s) {
	if (!songs[s] || !warpRefOf(s)) return;
	var bad = warpBad(s);
	if (!bad.length) return;
	for (var b = 0; b < bad.length; b++) {
		clipApi.id = bad[b].clip;
		if (!num(clipApi.get("warping"))) clipApi.set("warping", 1);
		rewarp(clipApi, bad[b]);
	}
	var left = warpBad(s), still = left.length;
	for (var g = 0; g < left.length; g++) warpGuard.gaveUp[left[g].clip] = 1;
	guideSent[songs[s].name] = "";
	log("warp guard: " + bad.length + " clips of " + songs[s].name + " fixed before playing" + (still ? ", " + still + " still off" : ""));
	outlet(0, "notice", "warpfixed", songs[s].name, bad.length, still);
}

function warpcheck(s) {
	s = parseInt(s, 10);
	if (!songs[s]) return;
	if (!warpRefOf(s)) { if (!adoptWarp(s)) { log("warp check " + songs[s].name + ": no reference and the clips are not clean"); outlet(0, "notice", "warpnoref", songs[s].name); } return; }
	var bad = warpBad(s);
	log("warp check " + songs[s].name + ": " + bad.length + " clips off");
	if (bad.length && !playing) { for (var b = 0; b < bad.length; b++) rewarpQueue.push(bad[b]); warpGuard.fixing = { name: songs[s].name, n: bad.length }; }
}

// ------------------------------------------------------------------ the song's own cues
// The server cuts each section's spoken name from the song's Guide stem. It
// needs the Guide clip with its timing and the sections in beats.
function guidePlan(s) {
	var sg = songs[s], ids = trackIds(), best = null;
	for (var i = 0; i < ids.length; i++) {
		if (ids[i] == ownTrackId || ids[i] == tailTrackId) continue;
		trackApi.id = ids[i];
		if (num(trackApi.get("has_midi_input"))) continue;
		if (!GUIDE_RE.test(str(trackApi.get("name")))) continue;
		var raw = trackApi.get("arrangement_clips") || [];
		for (var k = 0; k < raw.length; k++) {
			if (raw[k] != "id") continue;
			clipApi.id = num(raw[k + 1]); k++;
			var st = num(clipApi.get("start_time")), en = num(clipApi.get("end_time"));
			var cover = Math.min(en, sg.end) - Math.max(st, sg.start);
			if (cover <= 0 || !num(clipApi.get("is_audio_clip"))) continue;
			if (!best || cover > best.cover) best = { cover: cover, clip: {
				file: str(clipApi.get("file_path")), start: st, end: en,
				warping: num(clipApi.get("warping")), startMarker: num(clipApi.get("start_marker")),
				looping: num(clipApi.get("looping")), loopStart: num(clipApi.get("loop_start")), loopEnd: num(clipApi.get("loop_end")),
				markers: markersOf(clipApi)
			} };
		}
	}
	if (!best) return null;
	var secs = [];
	for (var j = 0; j < sg.sections.length; j++) {
		var sc = sg.sections[j];
		secs.push({ text: cleanCue(sc.name), start: sc.start, end: sc.end, first: j == 0 ? 1 : 0 });
	}
	return { song: sg.name, ref: sg.bpm || baseBpm(s) || tempo, bl: barLen(), end: sg.end, sections: secs, clip: best.clip };
}

// one song at a time; the server skips songs whose guide it already cut
function runGuides() {
	if (job) return;
	for (var i = 0; i < songs.length; i++) {
		var sg = songs[i];
		var sig = sg.start + ":" + sg.end + ":" + sg.sections.length;
		if (guideSent[sg.name] === sig) continue;
		guideSent[sg.name] = sig;
		var plan = guidePlan(i);
		if (!plan) return;
		// one dict per song: the server works through them one at a time
		var d = new Dict(GUIDE_DICT + "_" + i);
		d.parse(JSON.stringify(plan));
		outlet(0, "guideprep", i);
		return;
	}
}

function guideready(name, found, total) {
	log("guide cues for " + str(name) + ": " + found + "/" + total);
	outlet(0, "notice", "guideready", str(name), found, total);
}

// diagnostics: every audio clip of a song as Live has it now, one line per clip in the log
function clipinfo(s) {
	s = parseInt(s, 10);
	var sg = songs[s];
	if (!sg) return;
	var ids = trackIds(), n = 0;
	log("clipinfo " + sg.name + " " + sg.start + "-" + sg.end + " tempo " + tempo + " song bpm " + (sg.bpm || baseBpm(s)));
	for (var i = 0; i < ids.length; i++) {
		trackApi.id = ids[i];
		var nm = str(trackApi.get("name"));
		var raw = trackApi.get("arrangement_clips") || [];
		for (var k = 0; k < raw.length; k++) {
			if (raw[k] != "id") continue;
			clipApi.id = num(raw[k + 1]); k++;
			var st = num(clipApi.get("start_time")), en = num(clipApi.get("end_time"));
			if (en <= sg.start + 0.01 || st >= sg.end - 0.01) continue;
			var audio = num(clipApi.get("is_audio_clip"));
			var line = "clip | " + nm + " | " + str(clipApi.get("name")) + " | " + st.toFixed(3) + "-" + en.toFixed(3) +
				" | markers " + num(clipApi.get("start_marker")).toFixed(3) + "/" + num(clipApi.get("end_marker")).toFixed(3) +
				" loop " + num(clipApi.get("looping")) + " " + num(clipApi.get("loop_start")).toFixed(3) + "/" + num(clipApi.get("loop_end")).toFixed(3);
			if (audio) {
				var wm = markersOf(clipApi);
				line += " | warp " + num(clipApi.get("warping")) + " mode " + num(clipApi.get("warp_mode")) + " pitch " + num(clipApi.get("pitch_coarse")) +
					" | sr " + num(clipApi.get("sample_rate")) + " len " + num(clipApi.get("sample_length")) +
					" | wm " + wm.length + " " + wm.map(function (m) { return m.beat.toFixed(3) + "@" + m.sec.toFixed(4); }).join(" ") +
					" | " + str(clipApi.get("file_path")).split("/").pop();
			} else line += " | midi";
			log(line);
			n++;
		}
	}
	log("clipinfo done: " + n + " clips");
}

function runRewarp() {
	var job1 = rewarpQueue.shift();
	clipApi.id = job1.clip;
	if (!num(clipApi.get("warping"))) clipApi.set("warping", 1);
	rewarp(clipApi, job1);
	if (!rewarpQueue.length) {
		structSig = ""; dirty = true; tailDirty = true;
		var f = warpGuard.fixing;
		if (f) {
			warpGuard.fixing = null;
			var s1 = songIndex(f.name), left = s1 >= 0 ? warpBad(s1) : [], still = left.length;
			for (var g = 0; g < left.length; g++) { warpGuard.gaveUp[left[g].clip] = 1; log("warp guard: can't fix " + left[g].name + " in " + f.name + ", leaving it"); }
			guideSent[f.name] = "";
			log("warp guard: " + f.name + ": " + f.n + " clips fixed" + (still ? ", " + still + " still off" : ""));
			if (f.store && s1 >= 0) { opt(s1).warp = f.store; saveStore(); }
			outlet(0, "notice", "warpfixed", f.name, f.n, still);
		}
	}
}

function header(plan) {
	var h = "# " + plan.title;
	if (plan.bpm) h += " | " + (Math.round(plan.bpm * 100) / 100);
	if (plan.key) h += " | " + plan.key;
	if (plan.meter && plan.meter != "4/4") h += " | " + plan.meter;
	return h;
}

// A step Live keeps refusing must not hold the import forever: after three
// failures it is skipped and the import goes on (and says so at the end).
function runJobSafe() {
	var at = job.i;
	try { runJob(); }
	catch (e) {
		log("error in import: " + e.message);
		if (!job) return;
		var step = job.steps[at];
		if (step && job.i === at) {
			step.errors = (step.errors || 0) + 1;
			if (step.errors >= 3) {
				log("import: skipped " + (step.name || step.type) + " after 3 errors");
				job.warnings = (job.warnings || 0) + 1;
				job.i++;
			}
		}
	}
}

function runJob() {
	var step = job.steps[job.i];
	if (!step) { job = null; return; }
	if (step.type == "tempo") {
		if (step.bpm) setProp("tempo", step.bpm);
	} else if (step.type == "zoom") {
		try {
			var av = new LiveAPI(null, "live_app view");
			for (var z = 0; z < 20; z++) av.call("zoom_view", step.dir, "Arranger", 0);
		} catch (e) { log("zoom failed " + e.message); }
	} else if (step.type == "tempoback") {
		if (job.savedTempo) setProp("tempo", job.savedTempo);
	} else if (step.type == "track") {
		song.call("create_audio_track", -1);
		var ids = trackIds();
		var id = ids[ids.length - 1];
		trackApi.id = id;
		trackApi.set("name", step.name);
		job.dest[step.key] = id;
	} else if (step.type == "clip") {
		var tid = job.dest[step.key];
		trackApi.id = tid;
		// once only: a failure after this point must not put the clip in twice
		if (step.created) { job.i++; return; }
		step.created = 1;
		trackApi.call("create_audio_clip", step.file, step.pos);
		var raw = trackApi.get("arrangement_clips") || [];
		for (var k = 0; k < raw.length; k++) {
			if (raw[k] != "id") continue;
			clipApi.id = num(raw[k + 1]);
			k++;
			if (Math.abs(num(clipApi.get("start_time")) - step.pos) > 0.01) continue;
			if (!num(clipApi.get("warping"))) clipApi.set("warping", 1);
			if (num(clipApi.get("warp_mode")) != step.mode) clipApi.set("warp_mode", step.mode);
			rewarp(clipApi, step);
			job.warp[step.file] = compactWarp(step.markers);
			(job.clips = job.clips || []).push({ clip: num(raw[k]), name: step.name, markers: step.markers, pos: step.pos, tries: 0, len: step.length || 0, maxEnd: step.maxEnd });
			// Live refuses a start marker past the current end: when the clip
			// starts later in its file, move the end out first
			if (step.length > 0 && step.startBeat + step.length > num(clipApi.get("end_marker"))) {
				try { clipApi.set("end_marker", step.startBeat + step.length); clipApi.set("loop_end", step.startBeat + step.length); } catch (e) { }
			}
			// Live 12 drives an arrangement clip that doesn't loop by loop_start (the start marker follows it)
			if (step.startBeat > 0) { clipApi.set("loop_start", step.startBeat); try { clipApi.set("start_marker", step.startBeat); } catch (e) { } }
			if (step.length > 0) {
				var wantEnd = step.startBeat + step.length;
				if (Math.abs(num(clipApi.get("end_marker")) - wantEnd) > 0.01) {
					try { clipApi.set("end_marker", wantEnd); } catch (e) { }
				}
				fitClipEnd(clipApi, step.markers, step.maxEnd, step.length);
			}
		}
	} else if (step.type == "dup") {
		runDup(step);
	} else if (step.type == "rmclips") {
		rmClips(step.from, step.to);
	} else if (step.type == "meddone") {
		medDone();
		return;
	} else if (step.type == "cue" && cueOps) {
		song.call("add_cue", step.time, step.name);
	} else if (step.type == "uncue" && cueOps) {
		song.call("delete_cue", step.time);
	} else if (step.type == "cue") {
		// Live applies a new playhead position on its own schedule, so a locator
		// takes three ticks: move, create, name.
		step.phase = step.phase || 0;
		var found = null, cues = readCues();
		for (var c = 0; c < cues.length; c++) if (Math.abs(cues[c].time - step.time) < 0.01) found = cues[c];
		if (step.phase == 0) {
			if (found) step.phase = 2;
			else { setProp("current_song_time", step.time); step.phase = 1; return; }
		}
		if (step.phase == 1) {
			if (Math.abs(num(getProp("current_song_time")) - step.time) > 0.01) {
				step.tries = (step.tries || 0) + 1;
				if (step.tries < 25) { setProp("current_song_time", step.time); return; }
				log("could not place locator " + step.name);
				job.i++;
				return;
			}
			step.before = readCues().map(function (q) { return q.id; }).join();
			song.call("set_or_delete_cue");
			step.phase = 2;
			return;
		}
		if (!found) {
			step.tries = (step.tries || 0) + 1;
			if (step.tries < 25) return;
			log("locator missing: " + step.name);
			job.warnings = (job.warnings || 0) + 1;
		} else {
			cueApi.id = found.id;
			cueApi.set("name", step.name);
		}
	} else if (step.type == "uncue") {
		// delete the locator at a time: put the playhead on it, toggle it
		step.phase = step.phase || 0;
		var here = null, all = readCues();
		for (var u = 0; u < all.length; u++) if (Math.abs(all[u].time - step.time) < 0.01) here = all[u];
		if (!here) { job.i++; return; }
		if (step.phase == 0) { setProp("current_song_time", step.time); step.phase = 1; return; }
		if (Math.abs(num(getProp("current_song_time")) - step.time) > 0.01) {
			step.tries = (step.tries || 0) + 1;
			if (step.tries < 25) { setProp("current_song_time", step.time); return; }
			log("could not reach the locator to move it");
			job = null;
			return;
		}
		song.call("set_or_delete_cue");
		step.phase = 2;
		step.tries = 0;
		return;
	} else if (step.type == "fin") {
		setProp("current_song_time", step.back);
		job = null;
		structSig = "";
		dirty = true;
		tailDirty = true;
		log("section moved: " + step.what);
		return;
	} else if (step.type == "verify") {
		// every clip where it belongs and on the original timing, or it is warped again
		var list = job.clips || [], bad = 0, pending = 0;
		for (var v = 0; v < list.length; v++) {
			var c1 = list[v];
			if (c1.ok) continue;
			clipApi.id = c1.clip;
			var off = Math.max(clipWarpOff(c1.markers), c1.len ? Math.abs(num(clipApi.get("loop_end")) - num(clipApi.get("start_marker")) - c1.len) : 0), posOff = Math.abs(num(clipApi.get("start_time")) - c1.pos);
			if (off <= 0.01 && posOff < 0.01) { c1.ok = 1; continue; }
			if (c1.tries++ < 3) { if (!num(clipApi.get("warping"))) clipApi.set("warping", 1); rewarp(clipApi, c1); pending++; }
			else { bad++; log("import check: " + c1.name + " off by " + Math.round(off * 1000) / 1000 + " beats, position off by " + Math.round(posOff * 1000) / 1000); }
		}
		if (pending) { importMsg("progress", job.i, job.steps.length, "check"); return; }  // check again next tick
		job.checked = { ok: list.length - bad, total: list.length };
	} else if (step.type == "done") {
		setProp("current_song_time", job.P);
		var title = job.title;
		var ck = job.checked || { ok: 0, total: 0 };
		// keep each stem's original timing, to repair the warp later if needed
		if (!songOpts[title]) songOpts[title] = { bpm: 0, semis: 0 };
		songOpts[title].warp = job.warp;
		needStore = true;
		job = null;
		guard("outputs", applyOutputs)("");
		structSig = "";
		dirty = true;
		importMsg("done", title, ck.ok, ck.total);
		log("import done: " + title + " (" + ck.ok + "/" + ck.total + " clips checked)");
		// Live may finish analysing a long file after the import: look again soon
		warpGuard.soon.push({ name: title, at: clock + 3000 }, { name: title, at: clock + 20000 });
		guideSent[title] = "";
		return;
	}
	job.i++;
	if (job.i % 2 == 0 || step.type == "clip") importMsg("progress", job.i, job.steps.length, step.name || step.type);
}

// maintenance: remove every clip and locator from a bar on (to redo an import)
function clearfrom(bar) {
	var X = (parseInt(bar, 10) - 1) * barLen();
	if (!(X > 0)) return;
	var ids = trackIds(), n = 0;
	for (var t = 0; t < ids.length; t++) {
		trackApi.id = ids[t];
		var raw = trackApi.get("arrangement_clips") || [], del = [];
		for (var k = 0; k < raw.length; k++) {
			if (raw[k] != "id") continue;
			clipApi.id = num(raw[k + 1]);
			k++;
			if (num(clipApi.get("start_time")) >= X - 0.001) del.push(clipApi.id);
		}
		for (var d = 0; d < del.length; d++) { trackApi.call("delete_clip", "id", del[d]); n++; }
	}
	clearCues = X;
	log("clearfrom bar " + bar + ": " + n + " clips removed");
}
var clearCues = -1;

function clearCueStep() {
	var cues = readCues(), target = null;
	for (var i = 0; i < cues.length; i++) if (cues[i].time >= clearCues - 0.001) { target = cues[i]; break; }
	if (!target) { log("clear: locators removed"); clearCues = -1; structSig = ""; dirty = true; return; }
	if (!cueOps && Math.abs(num(getProp("current_song_time")) - target.time) > 0.01) { setProp("current_song_time", target.time); return; }
	log("clear locator " + target.name + " at " + target.time);
	if (cueOps) { song.call("delete_cue", target.time); return; }
	song.call("set_or_delete_cue");
}


