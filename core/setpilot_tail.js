// Song tails for Overlap and Crossfade transitions.
//
// In one Arrangement each track plays one clip at a time, so the end of a
// song can't sound while the next song already plays on the same tracks.
// SetPilot mixes the last seconds of the song's stems into one stereo file
// ahead of time. When the transition comes, Live jumps to the next song and
// SetPilot Tail plays that file on its own track, starting on the same
// downbeat, so the ending keeps ringing under the new song.
//
// The engine sends a plan: the window [from, to] in arrangement beats, the
// tempo the beats are counted in, and for every track its gain, pan and the
// audio clips inside the window (file, warp markers, start marker, loop).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const RATE = 44100;

// ------------------------------------------------------------ WAV in and out

function readWav(file) {
	const fd = fs.openSync(file, "r");
	try {
		const head = Buffer.alloc(12);
		fs.readSync(fd, head, 0, 12, 0);
		if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a wav file");
		let off = 12, fmt = null, dataOff = 0, dataLen = 0;
		const size = fs.fstatSync(fd).size;
		const ch = Buffer.alloc(8);
		while (off + 8 <= size) {
			fs.readSync(fd, ch, 0, 8, off);
			const id = ch.toString("ascii", 0, 4), len = ch.readUInt32LE(4);
			if (id === "fmt ") {
				const b = Buffer.alloc(Math.min(len, 40));
				fs.readSync(fd, b, 0, b.length, off + 8);
				let format = b.readUInt16LE(0);
				if (format === 0xfffe && b.length >= 26) format = b.readUInt16LE(24);
				fmt = { format, channels: b.readUInt16LE(2), rate: b.readUInt32LE(4), bits: b.readUInt16LE(14) };
			} else if (id === "data") {
				dataOff = off + 8;
				dataLen = Math.min(len, size - dataOff);
				break;
			}
			off += 8 + len + (len & 1);
		}
		if (!fmt || !dataOff) throw new Error("bad wav file");
		return { fd: null, file, ...fmt, dataOff, frames: Math.floor(dataLen / (fmt.channels * fmt.bits / 8)) };
	} finally { fs.closeSync(fd); }
}

// frames [a, b) of a wav file as one Float32Array per channel
function readFrames(info, a, b) {
	a = Math.max(0, Math.floor(a));
	b = Math.min(info.frames, Math.ceil(b));
	const n = Math.max(0, b - a);
	const bps = info.bits / 8, stride = bps * info.channels;
	const buf = Buffer.alloc(n * stride);
	if (n) {
		const fd = fs.openSync(info.file, "r");
		try { fs.readSync(fd, buf, 0, buf.length, info.dataOff + a * stride); } finally { fs.closeSync(fd); }
	}
	const out = [];
	for (let c = 0; c < info.channels; c++) out.push(new Float32Array(n));
	for (let i = 0; i < n; i++) {
		for (let c = 0; c < info.channels; c++) {
			const p = i * stride + c * bps;
			let v;
			if (info.format === 3 && bps === 4) v = buf.readFloatLE(p);
			else if (bps === 2) v = buf.readInt16LE(p) / 32768;
			else if (bps === 3) v = buf.readIntLE(p, 3) / 8388608;
			else if (bps === 4) v = buf.readInt32LE(p) / 2147483648;
			else v = (buf[p] - 128) / 128;
			out[c][i] = v;
		}
	}
	return { start: a, data: out };
}

function writeWavFloat(file, L, R, rate) {
	const n = L.length;
	const buf = Buffer.alloc(44 + n * 8);
	buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 8, 4); buf.write("WAVE", 8);
	buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(2, 22);
	buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 8, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34);
	buf.write("data", 36); buf.writeUInt32LE(n * 8, 40);
	for (let i = 0; i < n; i++) { buf.writeFloatLE(L[i], 44 + i * 8); buf.writeFloatLE(R[i], 48 + i * 8); }
	fs.writeFileSync(file, buf);
}

// ------------------------------------------------------------ decoding

// Any audio file -> a temporary 32 bit float wav at 44.1 kHz (afconvert is
// built into macOS). Tests pass their own decoder.
function afconvertDecoder(tmpDir) {
	return (file) => new Promise((resolve, reject) => {
		fs.mkdirSync(tmpDir, { recursive: true });
		const out = path.join(tmpDir, "decode-" + process.pid + "-" + Date.now() + ".wav");
		execFile("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEF32@" + RATE, file, out], { timeout: 180000 }, err => {
			if (err) { try { fs.unlinkSync(out); } catch (e) { } return reject(err); }
			resolve({ path: out, temp: true });
		});
	});
}

// The few seconds of a file a tail needs, cached as a small wav so a remix
// (new fader levels, another transition) does not decode the stem again.
async function getSegment(file, lo, hi, decode, cacheDir) {
	let st;
	try { st = fs.statSync(file); } catch (e) { throw new Error("missing file"); }
	const a = Math.max(0, Math.floor(lo * 10) / 10 - 0.1), b = Math.ceil(hi * 10) / 10 + 0.1;
	const key = crypto.createHash("sha1").update([file, st.size, st.mtimeMs, a, b].join("|")).digest("hex").slice(0, 20);
	const seg = path.join(cacheDir, key + ".wav");
	if (fs.existsSync(seg)) {
		const w = readWav(seg);
		const fr = readFrames(w, 0, w.frames);
		return { rate: w.rate, start: a, data: fr.data };
	}
	const d = await decode(file);
	const src = typeof d === "string" ? { path: d, temp: false } : d;
	try {
		const w = readWav(src.path);
		const fr = readFrames(w, a * w.rate, b * w.rate);
		const start = fr.start / w.rate;
		const L = fr.data[0], R = fr.data[1] || fr.data[0];
		fs.mkdirSync(cacheDir, { recursive: true });
		writeWavFloat(seg, L, R, w.rate);
		return { rate: w.rate, start, data: [L, R] };
	} finally {
		if (src.temp) fs.unlink(src.path, () => {});
	}
}

// ------------------------------------------------------------ clip timing

// beat inside the clip -> seconds in the file, through the warp markers
function makeBeatToSec(clip, ref) {
	const m = (clip.markers || []).slice().sort((a, b) => a.beat - b.beat);
	if (!clip.warping) {
		// unwarped clips play at the file's own speed: the start marker is in seconds
		return (clipBeatFromStart) => clip.startMarker + clipBeatFromStart * 60 / ref;
	}
	if (m.length < 2) {
		const b0 = m.length ? m[0].beat : 0, s0 = m.length ? m[0].sec : 0;
		return (beat) => s0 + (beat - b0) * 60 / ref;
	}
	return (beat) => {
		let i = 0;
		while (i < m.length - 2 && beat > m[i + 1].beat) i++;
		const a = m[i], b = m[i + 1];
		return a.sec + (beat - a.beat) * (b.sec - a.sec) / (b.beat - a.beat);
	};
}

// arrangement beat -> seconds in the clip's file (null when the clip is silent there)
function clipSecAt(clip, ref, b2s) {
	return (beat) => {
		if (beat < clip.start - 1e-9 || beat >= clip.end - 1e-9) return null;
		const into = beat - clip.start;
		if (!clip.warping) return b2s(into);
		let cb = clip.startMarker + into;
		if (clip.looping && clip.loopEnd > clip.loopStart && cb >= clip.loopEnd) {
			const L = clip.loopEnd - clip.loopStart;
			cb = clip.loopStart + ((cb - clip.loopStart) % L);
		}
		return b2s(cb);
	};
}

function panGains(p) {
	p = Math.max(-1, Math.min(1, Number(p) || 0));
	const a = (p + 1) * Math.PI / 4;
	return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2].map(g => Math.min(1, g));
}

// ------------------------------------------------------------ mixing

async function buildTail(plan, { outDir, cacheDir, decode, log = () => {} }) {
	const ref = Number(plan.ref) || 120;
	const beats = plan.to - plan.from;
	const n = Math.max(1, Math.round(beats * 60 / ref * RATE));
	const L = new Float32Array(n), R = new Float32Array(n);
	let used = 0;
	const beatAt = i => plan.from + (i / RATE) * ref / 60;
	for (const stem of plan.stems || []) {
		const g = Math.pow(10, (Number(stem.gainDb) || 0) / 20);
		if (g < 1e-4) continue;
		const [pl, pr] = panGains(stem.pan);
		for (const clip of stem.clips || []) {
			if (!clip.file) continue;
			const cg = g * Math.pow(10, (Number(clip.gainDb) || 0) / 20);
			const at = clipSecAt(clip, ref, makeBeatToSec(clip, ref));
			// output samples this clip covers
			const i0 = Math.max(0, Math.ceil((clip.start - plan.from) * 60 / ref * RATE));
			const i1 = Math.min(n, Math.floor((clip.end - plan.from) * 60 / ref * RATE));
			if (i1 <= i0) continue;
			let lo = Infinity, hi = -Infinity;
			const step = Math.max(1, Math.floor((i1 - i0) / 64));
			for (let i = i0; i <= i1; i += step) {
				const s = at(beatAt(Math.min(i, i1 - 1)));
				if (s != null) { lo = Math.min(lo, s); hi = Math.max(hi, s); }
			}
			if (!isFinite(lo)) continue;
			let seg;
			try { seg = await getSegment(clip.file, lo, hi, decode, cacheDir || path.join(outDir, "cache")); }
			catch (e) { log("tail: can't read " + clip.file + ": " + e.message); continue; }
			const chL = seg.data[0], chR = seg.data[1] || seg.data[0];
			const len = chL.length;
			for (let i = i0; i < i1; i++) {
				const s = at(beatAt(i));
				if (s == null) continue;
				const x = (s - seg.start) * seg.rate;
				const k = Math.floor(x);
				if (k < 0 || k + 1 >= len) continue;
				const f = x - k;
				L[i] += (chL[k] + (chL[k + 1] - chL[k]) * f) * cg * pl;
				R[i] += (chR[k] + (chR[k + 1] - chR[k]) * f) * cg * pr;
			}
			used++;
		}
	}
	// short fade at the very end so a cut-off ring never clicks
	const fade = Math.min(n, Math.round(RATE * 0.03));
	for (let i = 0; i < fade; i++) { const k = n - 1 - i, g = i / fade; L[k] *= g; R[k] *= g; }
	fs.mkdirSync(outDir, { recursive: true });
	const file = path.join(outDir, crypto.createHash("sha1").update(JSON.stringify(plan)).digest("hex").slice(0, 16) + ".wav");
	writeWavFloat(file, L, R, RATE);
	return { file, clips: used, seconds: n / RATE };
}

module.exports = { buildTail, afconvertDecoder, getSegment, readWav, readFrames, writeWavFloat, RATE };

// ------------------------------------------------------------ waveforms
// A song's overview: the loudness of its stems over time, in beats, through
// each clip's warp. Each file is reduced once to an envelope (RMS every
// 10 ms at 11 kHz mono) and cached, so redrawing a song is instant.

const ENV_RATE = 11025, ENV_HOP = 110;

function envelopeFor(file, cacheDir) {
	return new Promise((resolve, reject) => {
		let st;
		try { st = fs.statSync(file); } catch (e) { return reject(new Error("missing file")); }
		const key = crypto.createHash("sha1").update([file, st.size, st.mtimeMs].join("|")).digest("hex").slice(0, 20);
		const out = path.join(cacheDir, key + ".env");
		if (fs.existsSync(out)) {
			const b = fs.readFileSync(out);
			return resolve(new Float32Array(b.buffer, b.byteOffset, b.length / 4));
		}
		fs.mkdirSync(cacheDir, { recursive: true });
		const tmp = path.join(cacheDir, key + "-" + process.pid + ".tmp.wav");
		execFile("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEF32@" + ENV_RATE, "-c", "1", file, tmp], { timeout: 180000 }, err => {
			if (err) { try { fs.unlinkSync(tmp); } catch (e) { } return reject(err); }
			try {
				const w = readWav(tmp);
				const n = Math.ceil(w.frames / ENV_HOP), env = new Float32Array(n);
				const CH = ENV_HOP * 2000;
				for (let a = 0; a < w.frames; a += CH) {
					const fr = readFrames(w, a, Math.min(w.frames, a + CH)).data[0];
					for (let i = 0; i < fr.length; i += ENV_HOP) {
						let sum = 0, m = Math.min(fr.length, i + ENV_HOP);
						for (let k = i; k < m; k++) sum += fr[k] * fr[k];
						env[(a + i) / ENV_HOP] = sum / Math.max(1, m - i);
					}
				}
				fs.writeFileSync(out, Buffer.from(env.buffer));
				resolve(env);
			} catch (e) { reject(e); }
			finally { fs.unlink(tmp, () => {}); }
		});
	});
}

async function buildWave(plan, { cacheDir, envelope, log = () => {} }) {
	const ref = Number(plan.ref) || 120;
	const bars = Number(plan.bars) || 1;
	const n = Math.max(32, Math.min(4000, bars * 16));
	const span = plan.to - plan.from, bw = span / n;
	const energy = new Float64Array(n);
	const getEnv = envelope || (f => envelopeFor(f, cacheDir));
	for (const stem of plan.stems || []) {
		const g = Math.pow(10, (Number(stem.gainDb) || 0) / 20);
		if (g < 1e-4) continue;
		for (const clip of stem.clips || []) {
			if (!clip.file) continue;
			let env;
			try { env = await getEnv(clip.file); } catch (e) { log("wave: can't read " + clip.file + ": " + e.message); continue; }
			const at = clipSecAt(clip, ref, makeBeatToSec(clip, ref));
			const cg = g * Math.pow(10, (Number(clip.gainDb) || 0) / 20);
			const k0 = Math.max(0, Math.floor((clip.start - plan.from) / bw)), k1 = Math.min(n, Math.ceil((clip.end - plan.from) / bw));
			for (let k = k0; k < k1; k++) {
				const s0 = at(plan.from + k * bw), s1 = at(Math.min(plan.from + (k + 1) * bw, clip.end - 1e-6));
				if (s0 == null || s1 == null) continue;
				const i0 = Math.max(0, Math.floor(s0 * ENV_RATE / ENV_HOP)), i1 = Math.min(env.length, Math.max(i0 + 1, Math.ceil(s1 * ENV_RATE / ENV_HOP)));
				let sum = 0;
				for (let i = i0; i < i1; i++) sum += env[i];
				if (i1 > i0) energy[k] += (sum / (i1 - i0)) * cg * cg;
			}
		}
	}
	let max = 0;
	const peaks = new Array(n);
	for (let k = 0; k < n; k++) { peaks[k] = Math.sqrt(energy[k]); if (peaks[k] > max) max = peaks[k]; }
	for (let k = 0; k < n; k++) peaks[k] = max > 0 ? Math.round(Math.pow(peaks[k] / max, 0.7) * 1000) / 1000 : 0;
	return { song: plan.song, from: plan.from, to: plan.to, peaks };
}

// ------------------------------------------------------------ counted cues
// "Chorus, two, three, four": the name on beat 1, the count on the others,
// laid out at the song's tempo.
function buildCounted(nameFile, numberFiles, bpm, out) {
	const beat = 60 / bpm;
	const parts = [nameFile].concat(numberFiles);
	let len = 0;
	const datas = parts.map((f, i) => {
		const w = readWav(f), fr = readFrames(w, 0, w.frames);
		const start = Math.round(i * beat * w.rate);
		len = Math.max(len, start + fr.data[0].length);
		return { start, data: fr.data[0], rate: w.rate };
	});
	const rate = datas[0].rate;
	// a long name ("Turnaround") takes the beats it needs: the count goes on after it
	const nameEnd = datas[0].data.length - Math.round(rate * 0.04);
	for (let i = 1; i < datas.length; i++) if (datas[i].start < nameEnd) datas[i].skip = true;
	const L = new Float32Array(len);
	for (const d of datas) if (!d.skip) for (let i = 0; i < d.data.length; i++) L[d.start + i] += d.data[i];
	const fadeN = Math.min(L.length, Math.round(rate * 0.01));
	for (let i = 0; i < fadeN; i++) L[L.length - 1 - i] *= i / fadeN;
	writeWavFloat(out, L, L, rate);
	return out;
}

module.exports.buildWave = buildWave;
module.exports.envelopeFor = envelopeFor;
module.exports.buildCounted = buildCounted;

// ------------------------------------------------------------ speech: level and timing
// Every cue (the Mac voice, a session's own guide, a custom recording) is
// trimmed to its words and brought to the same speech level, so no cue is
// louder or quieter than the next one.

const SPEECH_DB = -18;     // RMS of the spoken parts
const CEILING_DB = -1;     // never above this peak

function frameDb(x, rate, ms) {
	const hop = Math.max(1, Math.round(rate * (ms || 10) / 1000));
	const n = Math.floor(x.length / hop), out = new Float32Array(n);
	for (let k = 0; k < n; k++) {
		let s = 0;
		for (let i = k * hop; i < (k + 1) * hop; i++) s += x[i] * x[i];
		out[k] = 10 * Math.log10(s / hop + 1e-12);
	}
	return { db: out, hop };
}

function trimSpeech(x, rate) {
	const { db, hop } = frameDb(x, rate, 10);
	let peak = -120;
	for (const v of db) if (v > peak) peak = v;
	const thr = Math.max(peak - 40, -70);
	let a = 0, b = db.length - 1;
	while (a < db.length && db[a] < thr) a++;
	while (b > a && db[b] < thr) b--;
	if (a >= db.length) return x;
	const s = Math.max(0, a * hop - Math.round(rate * 0.012)), e = Math.min(x.length, (b + 1) * hop + Math.round(rate * 0.06));
	return x.slice(s, e);
}

function normalizeSpeech(x, rate, target, ceiling) {
	target = target == null ? SPEECH_DB : target;
	ceiling = ceiling == null ? CEILING_DB : ceiling;
	const { db } = frameDb(x, rate, 10);
	let peakF = -120;
	for (const v of db) if (v > peakF) peakF = v;
	const gate = Math.max(peakF - 25, -60);
	let sum = 0, cnt = 0;
	for (const v of db) if (v >= gate) { sum += Math.pow(10, v / 10); cnt++; }
	if (!cnt) return x;
	const level = 10 * Math.log10(sum / cnt);
	let peak = 0;
	for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
	const g = Math.pow(10, Math.min(target - level, ceiling - 20 * Math.log10(peak + 1e-12)) / 20);
	const out = new Float32Array(x.length);
	for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
	return out;
}

function fadeEdges(x, rate, inMs, outMs) {
	const a = Math.min(x.length, Math.round(rate * (inMs || 5) / 1000)), b = Math.min(x.length, Math.round(rate * (outMs || 20) / 1000));
	for (let i = 0; i < a; i++) x[i] *= i / a;
	for (let i = 0; i < b; i++) x[x.length - 1 - i] *= i / b;
	return x;
}

// any wav -> mono, trimmed to the words, at the common speech level
function normalizeCueFile(inFile, outFile) {
	const w = readWav(inFile), fr = readFrames(w, 0, w.frames);
	let x = fr.data[0];
	if (fr.data.length > 1) { x = new Float32Array(x.length); for (let i = 0; i < x.length; i++) x[i] = (fr.data[0][i] + fr.data[1][i]) / 2; }
	x = fadeEdges(normalizeSpeech(trimSpeech(x, w.rate), w.rate), w.rate, 4, 25);
	writeWavFloat(outFile || inFile, x, x, w.rate);
	return outFile || inFile;
}

// spoken stretches inside [a, b) seconds of a mono signal; nearby words are joined
function speechParts(x, rate, start, a, b, thr, joinSec) {
	const hop = Math.round(rate * 0.01);
	const i0 = Math.max(0, Math.floor((a - start) * rate / hop)), i1 = Math.min(Math.floor(x.length / hop), Math.ceil((b - start) * rate / hop));
	const parts = [];
	let cur = null, quiet = 0;
	for (let k = i0; k < i1; k++) {
		let s = 0;
		for (let i = k * hop; i < (k + 1) * hop; i++) s += x[i] * x[i];
		const loud = 10 * Math.log10(s / hop + 1e-12) >= thr;
		const t = start + k * hop / rate;
		if (loud) {
			if (!cur) cur = { a: t, b: t + 0.01 };
			cur.b = t + 0.01;
			quiet = 0;
		} else if (cur) {
			quiet += 0.01;
			if (quiet > (joinSec || 0.3)) { parts.push(cur); cur = null; quiet = 0; }
		}
	}
	if (cur) parts.push(cur);
	return parts.filter(p => p.b - p.a >= 0.08);
}

// ------------------------------------------------------------ a session's own cues
// Multitrack guides say the next section on the downbeat of the bar before it,
// and count the song in ("one, two, one two three four"). From the Guide stem
// SetPilot keeps, per section name, the spoken name, and from the count-off
// the words for two, three and four, all in the guide's own voice.
async function extractGuide(plan, { decode, cacheDir, outDir, log = () => {} }) {
	const ref = Number(plan.ref) || 120, bl = Number(plan.bl) || 4, beat = 60 / ref;
	const clip = plan.clip;
	const at = clipSecAt(clip, ref, makeBeatToSec(clip, ref));
	const secs = (plan.sections || []).filter(s => s.start >= clip.start - 0.01 && s.start <= clip.end + 0.01);
	if (!secs.length) return { cues: {}, nums: null, found: 0, total: 0 };
	let lo = Infinity, hi = -Infinity;
	for (let b = Math.max(clip.start, secs[0].start - bl); b < Math.min(clip.end, plan.end || clip.end); b += 0.5) {
		const s = at(b);
		if (s != null) { lo = Math.min(lo, s); hi = Math.max(hi, s); }
	}
	if (!isFinite(lo)) return { cues: {}, nums: null, found: 0, total: 0 };
	const seg = await getSegment(clip.file, lo, hi + 1, decode, cacheDir);
	const L = seg.data[0], R = seg.data[1] || seg.data[0];
	const x = new Float32Array(L.length);
	for (let i = 0; i < x.length; i++) x[i] = (L[i] + R[i]) / 2;
	const rate = seg.rate;
	// the guide's speech level: loud frames of the whole song
	const { db } = frameDb(x, rate, 10);
	const sorted = Array.from(db).sort((p, q) => q - p);
	const speech = sorted[Math.floor(sorted.length * 0.03)] || -30;
	const thr = Math.max(speech - 26, -60);
	fs.mkdirSync(outDir, { recursive: true });
	const cues = {}, slugOf = t => String(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cue";
	const cut = (a, b, file) => {
		const s = Math.max(0, Math.round((a - 0.015 - seg.start) * rate)), e = Math.min(x.length, Math.round((b + 0.05 - seg.start) * rate));
		if (e - s < rate * 0.05) return null;
		const y = fadeEdges(normalizeSpeech(x.slice(s, e), rate), rate, 4, 25);
		writeWavFloat(file, y, y, rate);
		return file;
	};
	let found = 0, total = 0;
	for (let j = 0; j < secs.length; j++) {
		const sec = secs[j];
		if (sec.first) continue;           // nothing announces the first section
		total++;
		if (cues[sec.text]) { found++; continue; }
		// right after the count-off the bar before is the count itself, not a name
		const prev = secs[j - 1];
		if (prev && /^count/i.test(prev.text) && prev.end >= sec.start - 0.01) continue;
		const a = at(sec.start - bl), b = at(sec.start - 0.02);
		if (a == null || b == null || b <= a) continue;
		const parts = speechParts(x, rate, seg.start, a, b, thr, 0.3);
		// the name starts in the first half of the bar and lasts like a word or two
		const p = parts.find(q => q.a < a + (b - a) * 0.6 && q.b - q.a >= 0.15 && q.b - q.a <= 1.7);
		if (!p) continue;
		const f = cut(p.a, Math.min(p.b, b), path.join(outDir, slugOf(sec.text) + ".wav"));
		if (f) { cues[sec.text] = f; found++; }
	}
	// two, three, four: the last bar of the count-off, one word on each beat
	let nums = null;
	const co = secs.find(s => /^count/i.test(s.text));
	if (co && co.end - co.start >= bl - 0.01) {
		const a = at(co.end - bl), b = at(co.end - 0.02);
		if (a != null && b != null) {
			// stricter here: the count's words follow each other closely
			const words = speechParts(x, rate, seg.start, a, b, Math.min(thr + 12, speech - 14), 0.05);
			const onBeat = [0, 1, 2, 3].map(k => words.find(w => Math.abs(w.a - (a + k * beat)) < beat * 0.35));
			if (onBeat.every(Boolean)) {
				nums = [];
				for (let k = 1; k < 4; k++) {
					const w = onBeat[k], end = Math.min(w.b, w.a + beat * 0.95);
					const f = cut(w.a, end, path.join(outDir, "n-" + (k + 1) + ".wav"));
					if (!f) { nums = null; break; }
					nums.push(f);
				}
			}
		}
	}
	log("guide cues " + plan.song + ": " + found + "/" + total + " sections" + (nums ? ", count from the guide" : ""));
	return { cues, nums, found, total };
}

module.exports.normalizeCueFile = normalizeCueFile;
module.exports.normalizeSpeech = normalizeSpeech;
module.exports.trimSpeech = trimSpeech;
module.exports.speechParts = speechParts;
module.exports.extractGuide = extractGuide;
