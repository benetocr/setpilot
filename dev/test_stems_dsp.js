// The ears of the stems assistant, on made-up audio: a click with an accent,
// a chord progression, and stems that come and go.
const assert = require("assert");
const D = require("../core/ui/stems_dsp.js");
let bad = 0;
const test = (n, f) => { try { f(); console.log("ok   " + n); } catch (e) { bad++; console.log("FAIL " + n + "\n     " + e.message); } };
const SR = 22050;

function clickTrack({ bpm, start, beats = 4, bars = 40, accent = true, sr = SR, jitter = 0 }) {
	const P = 60 / bpm, len = Math.ceil((start + bars * beats * P + 1) * sr), x = new Float32Array(len);
	for (let i = 0; i < bars * beats; i++) {
		const one = i % beats === 0, f = accent && one ? 1600 : 1000, amp = accent && one ? 0.9 : 0.55;
		const t0 = start + i * P + (jitter ? (Math.random() - 0.5) * jitter : 0), a = Math.round(t0 * sr);
		for (let k = 0; k < sr * 0.03; k++) x[a + k] += amp * Math.sin(2 * Math.PI * f * k / sr) * Math.exp(-k / (sr * 0.006));
	}
	return x;
}

test("the click: 72 BPM, 4/4, beat one where the accent is", () => {
	const x = clickTrack({ bpm: 72, start: 1.3 });
	const r = D.tempoFromClick(D.clickOnsets(x, SR));
	assert.strictEqual(r.bpm, 72);
	assert.strictEqual(r.meter, "4/4");
	assert.ok(Math.abs(r.downbeat - 1.3) < 0.005, r.downbeat);
	assert.ok(r.steady && r.accented);
});
test("the click starting on beat 3 of a bar: beat one is the next accent", () => {
	const x = clickTrack({ bpm: 120, start: 0.5, bars: 30 });
	// cut the first two clicks: it now starts on beat 3
	const cut = Math.round((0.5 + 2 * 0.5 - 0.1) * SR);
	const r = D.tempoFromClick(D.clickOnsets(x.subarray(cut), SR));
	assert.strictEqual(r.bpm, 120);
	assert.ok(Math.abs(r.downbeat - (0.5 + 4 * 0.5 - cut / SR)) < 0.005, r.downbeat);
});
test("3/4 and a tempo with a decimal", () => {
	const r = D.tempoFromClick(D.clickOnsets(clickTrack({ bpm: 68.5, start: 0.8, beats: 3 }), SR));
	assert.strictEqual(r.bpm, 68.5);
	assert.strictEqual(r.meter, "3/4");
	assert.ok(Math.abs(r.downbeat - 0.8) < 0.006, r.downbeat);
});
test("a click with no accent: the tempo, and it says so", () => {
	const r = D.tempoFromClick(D.clickOnsets(clickTrack({ bpm: 128, start: 0.2, accent: false }), SR));
	assert.strictEqual(r.bpm, 128);
	assert.strictEqual(r.accented, false);
});
test("a click played a little loose still gives the tempo", () => {
	const r = D.tempoFromClick(D.clickOnsets(clickTrack({ bpm: 76, start: 2, jitter: 0.006 }), SR));
	assert.strictEqual(r.bpm, 76);
});

function chords(roots, sr = 11025, secEach = 2) {
	const x = new Float32Array(roots.length * secEach * sr);
	roots.forEach((ch, c) => ch.forEach(m => {
		const f = 440 * Math.pow(2, (m - 69) / 12);
		for (let i = 0; i < secEach * sr; i++) x[c * secEach * sr + i] += 0.2 * (Math.sin(2 * Math.PI * f * i / sr) + 0.4 * Math.sin(4 * Math.PI * f * i / sr));
	}));
	return x;
}
test("the key from the chords: G major", () => {
	const G = [55, 59, 62], C = [60, 64, 67], Dm = [62, 66, 69], Em = [64, 67, 71];
	const x = chords([G, C, G, Dm, Em, C, Dm, G, G, C, Dm, G]);
	assert.strictEqual(D.keyFromChroma(D.chroma(x, 11025)).key, "G");
});
test("the key from the chords: Bb major", () => {
	const Bb = [58, 62, 65], Eb = [63, 67, 70], F = [65, 69, 72], Gm = [55, 58, 62];
	const x = chords([Bb, Eb, F, Bb, Gm, Eb, F, Bb, Bb, F]);
	assert.strictEqual(D.keyFromChroma(D.chroma(x, 11025)).key, "Bb");
});
test("the key from the chords: A minor", () => {
	const Am = [57, 60, 64], Dm = [62, 65, 69], E = [64, 68, 71], F = [53, 57, 60];
	const x = chords([Am, Dm, E, Am, F, E, Am, Dm, E, Am, Am, E]);
	assert.strictEqual(D.keyFromChroma(D.chroma(x, 11025)).key, "Am");
});

// stems that come and go: per bar, which play (keys, bass, drums, vox, pad)
const FORM = [
	["Intro", 8, [1, 0, 0, 0, 1]],
	["Verse", 8, [1, 1, 0, 1, 0]],
	["Chorus", 8, [1, 1, 1, 1, 1]],
	["Verse", 8, [1, 1, 0, 1, 0]],
	["Chorus", 8, [1, 1, 1, 1, 1]],
	["Bridge", 8, [0, 0, 0, 1, 1]],
	["Chorus", 8, [1, 1, 1, 1, 1]],
	["Outro", 4, [1, 0, 0, 0, 1]]
];
function stemEnvs(fps, barSec, downbeat) {
	const bars = FORM.reduce((n, f) => n + f[1], 0), len = Math.ceil((downbeat + bars * barSec + 1) * fps);
	const envs = [0, 1, 2, 3, 4].map(() => new Float32Array(len));
	let b = 0;
	FORM.forEach(([, n, on]) => {
		for (let k = 0; k < n; k++, b++) on.forEach((v, s) => { if (!v) return; for (let i = Math.round((downbeat + b * barSec) * fps); i < Math.round((downbeat + (b + 1) * barSec) * fps); i++) envs[s][i] = (0.2 + 0.05 * Math.random()) * (s === 2 ? 1.5 : 1); });
	});
	return { envs, bars };
}
const expected = () => { let b = 0; return FORM.map(f => { const r = b; b += f[1]; return r; }); };

test("the parts from instruments coming and going", () => {
	const fps = 100, barSec = 4 * 60 / 72, { envs, bars } = stemEnvs(fps, barSec, 1);
	const A = D.barActivity(envs, fps, 1, barSec, bars);
	const nb = D.noveltyBounds(A);
	assert.deepStrictEqual([0].concat(nb), expected());
	const names = D.nameParts(A, [0].concat(nb)).map(p => p.name);
	assert.deepStrictEqual(names, ["Intro", "Verse 1", "Chorus", "Verse 2", "Chorus", "Bridge", "Chorus", "Outro"]);
});
test("the parts from the guide's cues (said on beats 3 and 4 of the bar before)", () => {
	const fps = 100, barSec = 4 * 60 / 72, down = 1, ex = expected(), len = Math.ceil((down + 70 * barSec) * fps), g = new Float32Array(len);
	ex.slice(1).forEach(b => { const a = down + (b - 0.5) * barSec, z = down + (b - 0.1) * barSec; for (let i = Math.round(a * fps); i < Math.round(z * fps); i++) g[i] = 0.3; });
	assert.deepStrictEqual(D.guideBounds(g, fps, down, barSec, 68), ex.slice(1));
});
test("no click: the tempo and the beat from the music", () => {
	const fps = 100, bpm = 84, P = 60 / bpm, start = 0.37, env = new Float32Array(60 * fps), low = new Float32Array(60 * fps);
	for (let i = 0; i * P + start < 59; i++) { const f = Math.round((start + i * P) * fps); for (let k = 0; k < 8; k++) env[f + k] = (i % 4 === 0 ? 1 : 0.6) * Math.exp(-k / 3); if (i % 4 === 0) for (let k = 0; k < 8; k++) low[f + k] = Math.exp(-k / 3); }
	const oc = D.onsetCurve(env);
	assert.ok(Math.abs(D.tempoGuess(oc, fps) - bpm) < 1, D.tempoGuess(oc, fps));
	const one = D.beatPhase(oc, fps, bpm, D.onsetCurve(low));
	assert.ok(Math.abs(((one - start) % (4 * P) + 4 * P) % (4 * P)) < 0.03 || Math.abs(((one - start) % (4 * P)) - 4 * P) < 0.03, one);
});
console.log(bad ? `\n${bad} failing` : "\nall passing");
process.exit(bad ? 1 : 0);
