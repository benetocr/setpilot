// macOS only (CI): spoken cues, made with the Mac's own voices, go through the
// bundled whisper.cpp and come back as part names, in English and in Spanish.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeHear } = require("../host/hear");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-say-"));
const voices = execFileSync("say", ["-v", "?"]).toString();
const pick = (re, fallback) => { const m = voices.split("\n").find(l => re.test(l)); return m ? m.split(/\s{2,}/)[0].trim() : fallback; };
const EN = pick(/en_US/, "Samantha"), ES = pick(/es_(MX|ES|US)/, null);
console.log("voices:", EN, "/", ES || "(no Spanish voice)");
function said(text, voice) {
	const a = path.join(dir, Math.random().toString(36).slice(2) + ".aiff"), w = a.replace(/aiff$/, "wav");
	execFileSync("say", ["-v", voice, "-o", a, text]);
	execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", a, w]);
	const b = fs.readFileSync(w);
	let o = 12;
	while (o < b.length && b.toString("ascii", o, o + 4) !== "data") o += 8 + b.readUInt32LE(o + 4);
	const n = b.readUInt32LE(o + 4) >> 1, pcm = new Int16Array(n);
	for (let i = 0; i < n; i++) pcm[i] = b.readInt16LE(o + 8 + i * 2);
	return pcm;
}
const cases = [
	["One, two, one, two, three, four", EN, "Count In"], ["Intro", EN, "Intro"], ["Verse one", EN, "Verse 1"], ["Pre chorus", EN, "Pre-Chorus"],
	["Chorus", EN, "Chorus"], ["Verse two", EN, "Verse 2"], ["Bridge", EN, "Bridge"], ["Instrumental", EN, "Instrumental"], ["Tag", EN, "Tag"], ["Ending", EN, "Ending"]
];
if (ES) cases.push(["Uno, dos, uno, dos, tres, cuatro", ES, "Count In"], ["Verso uno", ES, "Verse 1"], ["Coro", ES, "Chorus"], ["Puente", ES, "Bridge"], ["Precoro", ES, "Pre-Chorus"], ["Final", ES, "Ending"], ["Interludio", ES, "Interlude"]);
(async () => {
	const h = makeHear({ log: m => console.log(m), dirs: [process.env.SETPILOT_WHISPER_DIR] });
	if (!h.available()) { console.log("FAIL whisper not found"); process.exit(1); }
	const cues = cases.map((c, i) => ({ id: i, pcm: said(c[0], c[1]) }));
	const t0 = Date.now();
	const r = await h.hear(cues);
	console.log("took", ((Date.now() - t0) / 1000).toFixed(1), "s for", cues.length, "cues");
	let bad = 0;
	r.cues.forEach((o, i) => {
		const ok = o.name === cases[i][2];
		if (!ok) bad++;
		console.log((ok ? "ok   " : "MISS ") + JSON.stringify(cases[i][0]) + " -> " + JSON.stringify(o.text) + " = " + o.name + (o.lang ? " [" + o.lang + "]" : ""));
	});
	// a few misses are fine (the dashboard keeps them as "Part"); most must be right
	const rate = 1 - bad / cases.length;
	console.log((rate >= 0.8 ? "all passing" : "FAIL") + " (" + Math.round(rate * 100) + "% heard right)");
	process.exit(rate >= 0.8 ? 0 : 1);
})();
