// What whisper writes for a guide's cue, as the part's name (English or Spanish in, English out).
const assert = require("assert");
const { partName } = require("../core/cue_words.js");
const cases = [
	["Verse one.", "Verse 1"], [" Verse 2", "Verse 2"], ["Chorus!", "Chorus"], ["Pre-chorus.", "Pre-Chorus"], ["Bridge", "Bridge"],
	["Coro", "Chorus"], ["Verso dos.", "Verse 2"], ["Puente.", "Bridge"], ["Pune. Pune.", "Bridge"], ["Pre coro", "Pre-Chorus"], ["Precoro.", "Pre-Chorus"], ["Final.", "Ending"],
	["Interludio", "Interlude"], ["Instrumental.", "Instrumental"], ["Tag.", "Tag"], ["Intro", "Intro"], ["Introducción", "Intro"],
	["Verse, one, two, three, four.", "Verse"], ["One, two, one, two, three, four.", "Count In"], ["Uno, dos, uno, dos, tres, cuatro.", "Count In"],
	["1, 2, 1, 2, 3, 4", "Count In"], ["Turnaround", "Turnaround"], ["Ending.", "Ending"], ["Outro", "Outro"], ["Chorus 2", "Chorus 2"],
	["[BLANK_AUDIO]", null], ["Thank you.", null], ["", null]
];
let bad = 0;
for (const [t, want] of cases) {
	const r = partName(t);
	const got = r ? r.name : null;
	if (got !== want) { bad++; console.log("FAIL " + JSON.stringify(t) + " -> " + got + " (want " + want + ")"); }
}
console.log(bad ? bad + " failing" : "all passing");
process.exit(bad ? 1 : 0);
