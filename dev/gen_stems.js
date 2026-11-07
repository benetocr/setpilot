// made-up stems for a song: Grace Song - 72bpm - G
const fs = require("fs"), path = require("path");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const SR = 22050, bpm = 72, beat = 60 / bpm, bar = 4 * beat, start = 0.5;
const FORM = [["Count", 1, []], ["Intro", 4, ["keys"]], ["Verse", 8, ["keys", "bass", "vox"]], ["Chorus", 8, ["keys", "bass", "drums", "vox"]], ["Verse", 8, ["keys", "bass", "vox"]], ["Chorus", 8, ["keys", "bass", "drums", "vox"]], ["Bridge", 4, ["keys", "vox"]], ["Chorus", 8, ["keys", "bass", "drums", "vox"]], ["Outro", 4, ["keys"]]];
const bars = FORM.reduce((n, f) => n + f[1], 0), len = Math.ceil((start + bars * bar + 2) * SR);
const tracks = { click: new Float32Array(len), guide: new Float32Array(len), drums: new Float32Array(len), bass: new Float32Array(len), keys: new Float32Array(len), vox: new Float32Array(len) };
const prog = [[55, 59, 62], [60, 64, 67], [62, 66, 69], [64, 67, 71]];
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
let b = 0;
FORM.forEach(([name, n, on]) => {
	for (let k = 0; k < n; k++, b++) {
		const t0 = start + b * bar;
		for (let q = 0; q < 4; q++) { // click
			const a = Math.round((t0 + q * beat) * SR), f = q === 0 ? 1600 : 1000, amp = q === 0 ? 0.8 : 0.5;
			for (let i = 0; i < SR * 0.03; i++) tracks.click[a + i] += amp * Math.sin(2 * Math.PI * f * i / SR) * Math.exp(-i / (SR * 0.006));
		}
		const ch = prog[b % 4];
		const a = Math.round(t0 * SR), z = Math.round((t0 + bar) * SR);
		if (on.includes("keys")) for (let i = a; i < z; i++) { const t = (i - a) / SR; tracks.keys[i] = ch.reduce((s, m) => s + 0.12 * Math.sin(2 * Math.PI * hz(m) * t), 0); }
		if (on.includes("bass")) for (let i = a; i < z; i++) { const t = (i - a) / SR; tracks.bass[i] = 0.3 * Math.sin(2 * Math.PI * hz(ch[0] - 24) * t); }
		if (on.includes("vox")) for (let i = a; i < z; i++) { const t = (i - a) / SR; tracks.vox[i] = 0.15 * Math.sin(2 * Math.PI * hz(ch[2] + 12) * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * t)); }
		if (on.includes("drums")) for (let q = 0; q < 4; q++) { const s = Math.round((t0 + q * beat) * SR); for (let i = 0; i < SR * 0.15; i++) tracks.drums[s + i] += (q % 2 ? 0.4 * (Math.random() * 2 - 1) : 0.8 * Math.sin(2 * Math.PI * 60 * i / SR)) * Math.exp(-i / (SR * 0.04)); }
	}
	// the guide says the next part on beats 3-4 of the bar before it
});
let bb = 0;
FORM.forEach(([name, n], idx) => { if (idx > 0) { const t0 = start + (bb - 0.5) * bar, t1 = start + (bb - 0.08) * bar; for (let i = Math.round(t0 * SR); i < Math.round(t1 * SR); i++) tracks.guide[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / SR) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 7 * i / SR)); } bb += n; });
function wav(x) {
	const b = Buffer.alloc(44 + x.length * 2);
	b.write("RIFF", 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(x.length * 2, 40);
	for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
	return b;
}
const NAMES = { click: "Click", guide: "Guide", drums: "Drums", bass: "Bass", keys: "Keys", vox: "Lead Vox" };
for (const k in tracks) fs.writeFileSync(path.join(out, "Grace Song - " + NAMES[k] + ".wav"), wav(tracks[k]));
console.log("bars", bars, "dur", (len / SR).toFixed(1));
