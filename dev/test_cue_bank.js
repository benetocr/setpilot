// The cue bank: a section's name, in English or Spanish, finds its recording;
// a number the bank lacks is the name and then the number; names it has no
// recording for give nothing (SetPilot stays quiet rather than guess).
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { makeBank } = require("../core/cue_bank.js");
const { readWav } = require("../core/setpilot_tail.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-bank-"));
function tone(file, hz, rate, bits) {
	const n = Math.round(rate * 0.7), bps = bits / 8, b = Buffer.alloc(44 + n * bps * 2);
	b.write("RIFF", 0); b.writeUInt32LE(36 + n * bps * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
	b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * bps * 2, 28); b.writeUInt16LE(bps * 2, 32); b.writeUInt16LE(bits, 34); b.write("data", 36); b.writeUInt32LE(n * bps * 2, 40);
	for (let i = 0; i < n; i++) {
		const v = i > rate * 0.1 && i < rate * 0.5 ? Math.sin(2 * Math.PI * hz * i / rate) * 0.4 : 0;
		for (let c = 0; c < 2; c++) { if (bits === 16) b.writeInt16LE(Math.round(v * 32767), 44 + (i * 2 + c) * 2); else b.writeIntLE(Math.round(v * 8388607), 44 + (i * 2 + c) * 3, 3); }
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, b);
}
["Verse", "Verse 1", "Chorus", "Chorus 2", "Pre Chorus", "Bridge", "Ending", "Acapella", "Refrain", "Interlude"].forEach((n, i) => tone(path.join(dir, "Sections", n + ".wav"), 300 + 30 * i, 44100, 16));
["2", "3", "4", "5"].forEach((n, i) => tone(path.join(dir, "Sections", n + ".wav"), 600 + 30 * i, 48000, 24));
tone(path.join(dir, "Dynamics", "Build.wav"), 900, 44100, 16);
const bank = makeBank({ dirs: [null, path.join(dir, "missing"), dir], cacheDir: path.join(dir, ".ready") });
assert.strictEqual(bank.count, 15);
const P = t => bank.partsFor(t);
assert.deepStrictEqual(P("Verse 1"), ["verse-1"]);
assert.deepStrictEqual(P("Coro"), ["chorus"]);
assert.deepStrictEqual(P("Coro 2"), ["chorus-2"]);
assert.deepStrictEqual(P("Pre-Coro"), ["pre-chorus"]);
assert.deepStrictEqual(P("Puente"), ["bridge"]);
assert.deepStrictEqual(P("Final"), ["ending"]);
assert.deepStrictEqual(P("A Cappella"), ["acapella"]);
assert.deepStrictEqual(P("Estribillo"), ["refrain"]);
assert.deepStrictEqual(P("Chorus 5"), ["chorus", "5"], "a number without its own recording: the name, then the number");
assert.deepStrictEqual(P("Verso 3"), ["verse", "3"]);
assert.deepStrictEqual(P("Verse 9"), ["verse"], "no recording of the number: the name alone");
assert.deepStrictEqual(P("Build"), ["build"]);
assert.strictEqual(P("Grande y Fiel"), null);
assert.strictEqual(P("Count Off"), null);
console.log("ok   names in English and Spanish find their recordings");
const one = bank.cue("Coro"), w1 = readWav(one);
assert.strictEqual(w1.rate, 44100);
assert.ok(w1.frames / w1.rate > 0.3 && w1.frames / w1.rate < 0.5, "trimmed to its sound: " + w1.frames / w1.rate);
const two = bank.cue("Chorus 5"), w2 = readWav(two);
assert.strictEqual(w2.rate, 44100, "a 48 kHz, 24 bit number joins a 44.1 kHz name");
assert.ok(w2.frames > w1.frames * 1.8, "the name and the number, one after the other");
assert.strictEqual(bank.cue("Chorus 5"), two, "made once");
assert.ok(bank.number(2) && !bank.number(8));
assert.strictEqual(bank.cue("Whatever Song"), null);
console.log("ok   every cue comes out trimmed, at one rate; joined ones are made once");
console.log("\nall passing");
