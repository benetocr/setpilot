// SetPilot Audio: the sound side of SetPilot, inside Live's audio thread.
//
// One plugin, four jobs (its "Role" parameter):
//   Click  the click, on the beat grid of Live's own playhead
//   Cues   SetPilot's spoken cues, started on the exact sample of their beat
//   Guide  a gate on the song's Guide track, closed/opened on a beat
//   Tail   the end of the previous song, played over the next one's start,
//          and the pads that carry a medley from one key to the next
//
// Everything is scheduled in beats (Live's song time) and rendered from the
// host's playhead each block, so timing is sample-accurate no matter how late
// the app's message arrived, as long as it arrived before the beat.
//
// This file has no JUCE in it so it can be tested on its own.

#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <mutex>
#include <vector>

namespace sp {

enum class Role { Click = 0, Cues = 1, Guide = 2, Tail = 3 };

struct Transport {
	bool playing = false;
	double ppq = 0.0;       // song position in beats at the first sample of the block
	double bpm = 120.0;
	int sigNum = 4, sigDen = 4;
};

// mono or stereo audio already at the host's sample rate
struct Sample {
	std::vector<float> l, r;
	size_t size() const { return l.size(); }
};
using SamplePtr = std::shared_ptr<const Sample>;

struct ClickParams {
	bool on = true;
	int beats = 4;          // beats in the bar (from the song)
	int sub = 1;            // 1 quarter, 2 eighths, 3 triplets, 4 sixteenths
	uint32_t accMask = 1;   // beats with an accent
	uint32_t muteMask = 0;  // silent beats
	float lvlAcc = 1.0f, lvlBeat = 0.8f, lvlSub = 0.5f;
	int sound = 0;          // 0 beep, 1 wood, 2 rim
	float gain = 1.0f;
	bool thru = false;      // let the track's own audio (a song's click stem) through
};

// Commands from the app. The network thread pushes, the audio thread pops.
struct Command {
	enum Type { None, ClickSet, CueSlot, CueArm, CueDisarm, CuePlay, GateArm, GateNow, TailLoad, TailPlay, TailStop, PadEvent, PadClear, PadLoad } type = None;
	int idx = 0;
	double beat = 0, a = 0, b = 0, c = 0, d = 0;
	ClickParams click;
	SamplePtr sample;
};

// Single producer / single consumer queue; the audio thread never waits.
template <size_t N>
class CommandQueue {
public:
	bool push(Command c) {
		std::lock_guard<std::mutex> g(pushLock);   // producers serialize among themselves only
		size_t w = write.load(std::memory_order_relaxed), nx = (w + 1) % N;
		if (nx == read.load(std::memory_order_acquire)) return false;
		buf[w] = std::move(c);
		write.store(nx, std::memory_order_release);
		return true;
	}
	bool pop(Command& c) {
		size_t r = read.load(std::memory_order_relaxed);
		if (r == write.load(std::memory_order_acquire)) return false;
		c = std::move(buf[r]);
		buf[r] = Command();
		read.store((r + 1) % N, std::memory_order_release);
		return true;
	}
private:
	std::array<Command, N> buf;
	std::atomic<size_t> read{0}, write{0};
	std::mutex pushLock;
};

class Core {
public:
	static constexpr double FAR = 1e12;

	void prepare(double sr) { sampleRate = sr; clickVoice.active = false; }
	void setRole(Role r) { role = r; }
	Role getRole() const { return role; }
	bool push(Command c) { return queue.push(std::move(c)); }

	// events the app wants to hear about (cue started...), read by the network thread
	std::atomic<int> firedCue{-1};
	std::atomic<double> firedAt{0};
	std::atomic<int> firedCount{0};

	// in/out: 2 channels. in may be null (no input).
	void process(const float* const* in, float* const* out, int numCh, int n, const Transport& tr) {
		drain();
		const double beatsPerSample = tr.bpm / 60.0 / sampleRate;
		// samples that are about to be released go away outside the loop
		for (int ch = 0; ch < numCh; ++ch) {
			if ((role == Role::Guide || (role == Role::Click && click.thru)) && in && in[ch]) std::copy(in[ch], in[ch] + n, out[ch]);
			else std::fill(out[ch], out[ch] + n, 0.0f);
		}

		switch (role) {
			case Role::Click: renderClick(out, numCh, n, tr, beatsPerSample); break;
			case Role::Cues: renderCues(out, numCh, n, tr, beatsPerSample); break;
			case Role::Guide: renderGate(out, numCh, n, tr, beatsPerSample); break;
			case Role::Tail: renderTail(out, numCh, n); renderPad(out, numCh, n, tr, beatsPerSample); break;
		}
	}

	// state, for tests and the editor
	ClickParams clickParams() const { return click; }
	double cueArmBeat() const { return cueArm; }
	float gateGain() const { return gate; }
	float padLevel() const { return padAmp; }
	int padLoopRoot() const { return padCur >= 0 ? padVoice[(size_t)padCur].root : -1; }
	bool padHasLoops() const { for (auto& s : padBank) if (s) return true; return false; }
	double padFreq(int i) const { return padOsc[(size_t)i].freq; }

private:
	double sampleRate = 48000;
	Role role = Role::Click;
	CommandQueue<512> queue;

	// ------------------------------------------------------------ commands
	// Samples are shared with the network thread, which keeps its own
	// reference for a minute after sending one: dropping ours here never
	// frees memory on the audio thread.
	std::array<SamplePtr, 256> cueSlots;

	void drain() {
		Command c;
		while (queue.pop(c)) {
			switch (c.type) {
				case Command::ClickSet: click = c.click; break;
				case Command::CueSlot:
					if (c.idx >= 0 && c.idx < (int)cueSlots.size()) cueSlots[(size_t)c.idx] = c.sample;
					break;
				case Command::CueArm: cueArm = c.beat; cueArmIdx = c.idx; break;
				case Command::CueDisarm: cueArm = FAR; break;
				case Command::CuePlay: startCue(c.idx, 0); break;
				case Command::GateArm: gateArm = c.beat; gateArmVal = (float)c.a; break;
				case Command::GateNow: gateTarget = (float)c.a; gateArm = FAR; break;
				case Command::TailLoad: tail = c.sample; tailPos = -1; break;
				case Command::TailPlay:
					tailPos = c.d / 1000.0 * sampleRate;      // offset ms
					tailRate = c.a > 0 ? c.a : 1.0;
					tailMode = (int)c.c;
					tailFadeSamples = c.b > 0 ? c.b / 1000.0 * sampleRate : 0;   // duration ms
					tailPlayed = 0;
					break;
				case Command::TailStop: tailStopping = true; break;
				// beat < 0: now (the Pad button), playing or stopped
				case Command::PadEvent: if (c.beat < 0) padChord((((int)c.a % 12) + 12) % 12, (int)c.b); else addPadEvent(c.beat, (int)c.a, (int)c.b); break;
				case Command::PadClear: padEvN = 0; padAmpTarget = 0; break;
				case Command::PadLoad: if (c.idx >= 0 && c.idx < 12) padBank[(size_t)c.idx] = c.sample; break;
				case Command::None: break;
			}
		}
	}

	// crossing test for a beat inside this block: returns the sample offset or -1
	static int crossing(double target, double ppq, double bps, int n) {
		if (target >= FAR || target < ppq - 1e-9) return -1;
		double s = (target - ppq) / bps;
		if (s >= n) return -1;
		return std::max(0, (int)std::floor(s + 1e-6));
	}

	// ------------------------------------------------------------ click
	ClickParams click;
	struct ClickVoice { bool active = false; int pos = 0; float level = 0; int kind = 0; double phase = 0; uint32_t noise = 12345; } clickVoice;

	void renderClick(float* const* out, int numCh, int n, const Transport& tr, double bps) {
		int done = 0;    // samples of this block already rendered
		if (tr.playing && click.on) {
			const int sub = std::max(1, std::min(4, click.sub));
			const int beats = std::max(1, click.beats);
			const double step = 4.0 / tr.sigDen / sub;   // one subdivision, in quarter-note beats
			for (double g = std::ceil(tr.ppq / step - 1e-9) * step; ; g += step) {
				int s = crossing(g, tr.ppq, bps, n);
				if (s < 0) break;
				long long k = std::llround(g / step);
				int beatInBar = (int)(((k / sub) % beats + beats) % beats);
				float lvl;
				int kind;
				if (k % sub != 0) { lvl = click.lvlSub; kind = 2; }
				else if (click.muteMask >> beatInBar & 1u) continue;
				else if (click.accMask >> beatInBar & 1u) { lvl = click.lvlAcc; kind = 0; }
				else { lvl = click.lvlBeat; kind = 1; }
				renderClickVoice(out, numCh, done, s);
				uint32_t nz = clickVoice.noise;
				clickVoice = ClickVoice{true, 0, lvl * click.gain, kind, 0, nz};
				done = s;
			}
		}
		renderClickVoice(out, numCh, done, n);
	}
	void renderClickVoice(float* const* out, int numCh, int from, int to) {
		ClickVoice& v = clickVoice;
		if (!v.active) return;
		const int len = (int)(0.045 * sampleRate);
		const double freq = v.kind == 0 ? 1600.0 : v.kind == 1 ? 1100.0 : 800.0;
		for (int i = from; i < to; ++i) {
			if (v.pos >= len) { v.active = false; break; }
			const double t = v.pos / sampleRate;
			const double env = std::exp(-t * (click.sound == 0 ? 90.0 : 160.0)) * std::min(1.0, v.pos / (0.0008 * sampleRate));
			double x;
			if (click.sound == 0) x = std::sin(v.phase);
			else {
				v.noise = v.noise * 1664525u + 1013904223u;
				double nz = ((v.noise >> 9) / 4194304.0) * 2.0 - 1.0;
				x = 0.6 * std::sin(v.phase) + (click.sound == 1 ? 0.4 : 0.7) * nz * std::exp(-t * 400.0);
			}
			v.phase += 2 * M_PI * freq / sampleRate;
			const float s = (float)(x * env * v.level * 0.5);
			for (int ch = 0; ch < numCh; ++ch) out[ch][i] += s;
			++v.pos;
		}
	}

	// ------------------------------------------------------------ cues
	double cueArm = FAR;
	int cueArmIdx = 0;
	struct Voice { SamplePtr s; double pos = 0; bool active = false; };
	std::array<Voice, 4> cueVoices;

	void startCue(int idx, int at) {
		if (idx <= 0 || idx >= (int)cueSlots.size() || !cueSlots[(size_t)idx]) return;
		// one cue at a time: a new one cuts the previous
		for (auto& v : cueVoices) v.active = false;
		cueVoices[0] = Voice{cueSlots[(size_t)idx], (double)-at, true};
		firedCue.store(idx);
		firedCount.fetch_add(1);
	}

	void renderCues(float* const* out, int numCh, int n, const Transport& tr, double bps) {
		if (tr.playing) {
			int s = crossing(cueArm, tr.ppq, bps, n);
			if (s >= 0) { firedAt.store(cueArm); cueArm = FAR; startCue(cueArmIdx, s); }
		}
		for (auto& v : cueVoices) {
			if (!v.active) continue;
			const Sample& smp = *v.s;
			for (int i = 0; i < n; ++i) {
				if (v.pos < 0) { v.pos += 1; continue; }
				size_t p = (size_t)v.pos;
				if (p >= smp.size()) { v.active = false; break; }
				out[0][i] += smp.l[p];
				if (numCh > 1) out[1][i] += smp.r.empty() ? smp.l[p] : smp.r[p];
				v.pos += 1;
			}
		}
	}

	// ------------------------------------------------------------ guide gate
	double gateArm = FAR;
	float gateArmVal = 1, gateTarget = 1, gate = 1;

	void renderGate(float* const* out, int numCh, int n, const Transport& tr, double bps) {
		int s = tr.playing ? crossing(gateArm, tr.ppq, bps, n) : -1;
		const float stepPerSample = (float)(1.0 / (0.004 * sampleRate));   // 4 ms ramp: no clicks
		for (int i = 0; i < n; ++i) {
			if (i == s) { gateTarget = gateArmVal; gateArm = FAR; }
			if (gate < gateTarget) gate = std::min(gateTarget, gate + stepPerSample);
			else if (gate > gateTarget) gate = std::max(gateTarget, gate - stepPerSample);
			for (int ch = 0; ch < numCh; ++ch) out[ch][i] *= gate;
		}
	}

	// ------------------------------------------------------------ tail
	SamplePtr tail;
	double tailPos = -1, tailRate = 1, tailFadeSamples = 0, tailPlayed = 0;
	int tailMode = 1;
	bool tailStopping = false;
	float tailStopGain = 1;

	void renderTail(float* const* out, int numCh, int n) {
		if (!tail || tailPos < 0) { tailStopping = false; tailStopGain = 1; return; }
		const Sample& smp = *tail;
		for (int i = 0; i < n; ++i) {
			size_t p = (size_t)tailPos;
			if (p + 1 >= smp.size()) { tailPos = -1; break; }
			const double fr = tailPos - p;
			float l = (float)(smp.l[p] + (smp.l[p + 1] - smp.l[p]) * fr);
			const auto& rr = smp.r.empty() ? smp.l : smp.r;
			float r = (float)(rr[p] + (rr[p + 1] - rr[p]) * fr);
			float g = 1;
			if (tailMode == 2 && tailFadeSamples > 0) g = (float)std::max(0.0, 1.0 - tailPlayed / tailFadeSamples);   // crossfade
			if (tailStopping) { tailStopGain = std::max(0.0f, tailStopGain - (float)(1.0 / (0.05 * sampleRate))); g *= tailStopGain; }
			out[0][i] += l * g;
			if (numCh > 1) out[1][i] += r * g;
			tailPos += tailRate;
			tailPlayed += 1;
			if (g <= 0 && (tailStopping || tailMode == 2)) { tailPos = -1; tailStopping = false; tailStopGain = 1; break; }
		}
	}
	// ------------------------------------------------------------ pad
	// A soft chord on the Tail track, scheduled in beats: the bridge between
	// two parts of a medley in different keys. Five voices (bass, root, fifth,
	// octave, third), two slightly detuned saws each, through a gentle low
	// pass; chords glide into each other, the level swells in and out.
	struct PadEv { double beat; int root; int q; };
	std::array<PadEv, 64> padEv{};
	int padEvN = 0;
	struct PadOsc { double freq = 0, target = 0, ph1 = 0, ph2 = 0; float gain = 1; };
	std::array<PadOsc, 5> padOsc{};
	float padAmp = 0, padAmpTarget = 0;
	double lpL1 = 0, lpL2 = 0, lpR1 = 0, lpR2 = 0;
	bool padHasChord = false;
	// recorded pads, one loop per key (C = 0): when the key has one, it plays
	// instead of the synth; a change of key crossfades from one loop to the next
	std::array<SamplePtr, 12> padBank{};
	struct PadVoice { SamplePtr s; int root = -1; double pos = 0; float g = 0, gTarget = 0; };
	std::array<PadVoice, 2> padVoice{};
	int padCur = -1;
	bool padSampled = false;

	void addPadEvent(double beat, int root, int q) {
		if (padEvN >= (int)padEv.size()) return;
		int i = padEvN++;
		while (i > 0 && padEv[(size_t)i - 1].beat > beat) { padEv[(size_t)i] = padEv[(size_t)i - 1]; --i; }
		padEv[(size_t)i] = PadEv{beat, ((root % 12) + 12) % 12, q};
	}

	void padChord(int root, int q) {
		if (q == 0) { padAmpTarget = 0; return; }
		if (padBank[(size_t)root]) {
			const bool fresh = !padSampled || padAmp < 0.001f;
			if (padCur < 0 || padVoice[(size_t)padCur].root != root || fresh) {
				const int nx = padCur < 0 ? 0 : 1 - padCur;
				if (padCur >= 0) padVoice[(size_t)padCur].gTarget = 0;
				auto& v = padVoice[(size_t)nx];
				// a new pad starts at a point of its loop that moves on each time, so it never sounds the same twice
				v.s = padBank[(size_t)root]; v.root = root;
				v.pos = fresh ? 0 : std::fmod(padVoice[(size_t)std::max(0, padCur)].pos, (double)v.s->size());
				v.g = fresh ? 1.0f : 0.0f; v.gTarget = 1.0f;
				if (fresh && padCur >= 0) padVoice[(size_t)padCur].g = 0;
				padCur = nx;
			}
			padSampled = true;
			padAmpTarget = 1;
			return;
		}
		padSampled = false;
		int r = 48 + root;                // C3..B3, the top of a voicing that stays warm
		if (root > 7) r -= 12;
		const int third = q == 2 ? 3 : 4;
		const int notes[5] = { r - 12, r, r + 7, r + 12, r + 12 + third };
		const float gains[5] = { 0.55f, 1.0f, 0.85f, 0.7f, 0.55f };
		const bool snap = !padHasChord || padAmp < 0.001f;
		for (size_t i = 0; i < 5; ++i) {
			const double f = 440.0 * std::pow(2.0, (notes[i] - 69) / 12.0);
			padOsc[i].target = f;
			padOsc[i].gain = gains[i];
			if (snap) padOsc[i].freq = f;
		}
		padHasChord = true;
		padAmpTarget = 1;
	}

	void renderPad(float* const* out, int numCh, int n, const Transport& tr, double bps) {
		// everything due by the end of this block happens now (a few ms early at most;
		// after a jump forward this catches up to the right chord)
		if (tr.playing && padEvN > 0) {
			const double end = tr.ppq + n * bps;
			int used = 0;
			while (used < padEvN && padEv[(size_t)used].beat <= end) { padChord(padEv[(size_t)used].root, padEv[(size_t)used].q); ++used; }
			if (used) {
				for (int i = used; i < padEvN; ++i) padEv[(size_t)(i - used)] = padEv[(size_t)i];
				padEvN -= used;
			}
		}
		if (padAmp <= 0 && padAmpTarget <= 0) return;
		if (padSampled) { renderPadLoops(out, numCh, n); return; }
		const double sr = sampleRate;
		const float up = (float)(1.0 / (1.2 * sr)), down = (float)(1.0 / (2.0 * sr));
		const double glide = 1.0 - std::exp(-1.0 / (0.12 * sr));
		const double a = 1.0 - std::exp(-2.0 * M_PI * 1100.0 / sr);
		for (int i = 0; i < n; ++i) {
			if (padAmp < padAmpTarget) padAmp = std::min(padAmpTarget, padAmp + up);
			else if (padAmp > padAmpTarget) padAmp = std::max(padAmpTarget, padAmp - down);
			double l = 0, r = 0;
			for (auto& o : padOsc) {
				o.freq += (o.target - o.freq) * glide;
				o.ph1 += o.freq * 1.0035 / sr; if (o.ph1 >= 1) o.ph1 -= 1;
				o.ph2 += o.freq * 0.9965 / sr; if (o.ph2 >= 1) o.ph2 -= 1;
				l += (2.0 * o.ph1 - 1.0) * o.gain;
				r += (2.0 * o.ph2 - 1.0) * o.gain;
			}
			lpL1 += (l - lpL1) * a; lpL2 += (lpL1 - lpL2) * a;
			lpR1 += (r - lpR1) * a; lpR2 += (lpR1 - lpR2) * a;
			const double g = 0.09 * padAmp * padAmp;
			out[0][i] += (float)(lpL2 * g);
			if (numCh > 1) out[1][i] += (float)(lpR2 * g);
		}
		if (padAmp <= 0 && padAmpTarget <= 0) { padHasChord = false; lpL1 = lpL2 = lpR1 = lpR2 = 0; }
	}

	void renderPadLoops(float* const* out, int numCh, int n) {
		const double sr = sampleRate;
		const float up = (float)(1.0 / (1.2 * sr)), down = (float)(1.0 / (2.0 * sr));
		const float xf = (float)(1.0 / (1.5 * sr));     // one key into the next: 1.5 s
		for (int i = 0; i < n; ++i) {
			if (padAmp < padAmpTarget) padAmp = std::min(padAmpTarget, padAmp + up);
			else if (padAmp > padAmpTarget) padAmp = std::max(padAmpTarget, padAmp - down);
			float l = 0, r = 0;
			for (auto& v : padVoice) {
				if (!v.s || v.s->size() < 2) continue;
				if (v.g < v.gTarget) v.g = std::min(v.gTarget, v.g + xf);
				else if (v.g > v.gTarget) v.g = std::max(v.gTarget, v.g - xf);
				if (v.g <= 0 && v.gTarget <= 0) continue;
				const Sample& smp = *v.s;
				const size_t p = (size_t)v.pos;
				// equal power between the two keys
				const float eg = std::sin(v.g * 1.5707963f);
				l += smp.l[p] * eg;
				r += (smp.r.empty() ? smp.l[p] : smp.r[p]) * eg;
				v.pos += 1;
				if (v.pos >= (double)smp.size()) v.pos -= (double)smp.size();   // the loop's own crossfade makes the seam
			}
			const float g = 0.8f * padAmp * padAmp;
			out[0][i] += l * g;
			if (numCh > 1) out[1][i] += r * g;
		}
		if (padAmp <= 0 && padAmpTarget <= 0) {
			padSampled = false;
			for (auto& v : padVoice) { v.g = v.gTarget = 0; v.root = -1; }
			padCur = -1;
		}
	}
};

}  // namespace sp
