// g++ -std=c++17 -O2 -I plugin/src plugin/tests/core_test.cpp -o /tmp/core_test && /tmp/core_test
#include "Core.h"
#include <cstdio>
#include <string>

using namespace sp;
static int failures = 0;
#define CHECK(c, msg) do { if (!(c)) { failures++; std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, msg); } } while (0)

struct Run {
	Core core;
	double sr = 48000, bpm = 120, ppq = 0;
	int block = 512;
	bool playing = true;
	std::vector<float> L, R, inL, inR;
	explicit Run(Role r) { core.prepare(sr); core.setRole(r); }
	// render `seconds`, collecting the output
	void go(double seconds, float inputLevel = 0) {
		int total = (int)(seconds * sr);
		std::vector<float> l(block), r(block), il(block, inputLevel), ir(block, inputLevel);
		for (int done = 0; done < total; done += block) {
			Transport t; t.playing = playing; t.ppq = ppq; t.bpm = bpm;
			const float* in[2] = { il.data(), ir.data() };
			float* out[2] = { l.data(), r.data() };
			core.process(in, out, 2, block, t);
			L.insert(L.end(), l.begin(), l.end());
			R.insert(R.end(), r.begin(), r.end());
			if (playing) ppq += bpm / 60.0 / sr * block;
		}
	}
	// first sample at or after `from` whose level passes `thr`
	long onset(long from = 0, float thr = 0.01f) const {
		for (size_t i = from; i < L.size(); ++i) if (std::fabs(L[i]) > thr) return (long)i;
		return -1;
	}
	long beatSample(double beat) const { return std::lround(beat * 60.0 / bpm * sr); }
};

static SamplePtr tone(double sr, double secs) {
	auto s = std::make_shared<Sample>();
	for (int i = 0; i < (int)(secs * sr); ++i) { float x = 0.5f * (float)std::cos(i * 0.05); s->l.push_back(x); s->r.push_back(x); }
	return s;
}

static void testClickOnTheGrid() {
	Run r(Role::Click);
	r.go(2.1);                             // 120 bpm: beats at 0, 0.5 s, 1 s, 1.5 s, 2 s
	for (int b = 0; b < 4; ++b) {
		long want = r.beatSample(b), got = r.onset(want > 50 ? want - 50 : 0, 1e-7f);
		CHECK(got >= want && got - want <= 2, ("beat " + std::to_string(b) + " at its sample").c_str());
	}
}

static void testClickNotBetweenBeats() {
	Run r(Role::Click);
	r.go(1.0);
	// between 0.1 s and 0.45 s (after the first click died away, before the second) all silent
	float peak = 0;
	for (long i = (long)(0.1 * r.sr); i < (long)(0.45 * r.sr); ++i) peak = std::max(peak, std::fabs(r.L[i]));
	CHECK(peak < 1e-4, "silence between quarter clicks");
}

static void testClickAccentAndMute() {
	Run r(Role::Click);
	Command c; c.type = Command::ClickSet; c.click.accMask = 1; c.click.muteMask = 1u << 2; c.click.lvlAcc = 1; c.click.lvlBeat = 0.5f;
	r.core.push(c);
	r.go(2.1);
	auto peakNear = [&](int beat) { float p = 0; long s = r.beatSample(beat); for (long i = s; i < s + 2000; ++i) p = std::max(p, std::fabs(r.L[i])); return p; };
	CHECK(peakNear(0) > peakNear(1) * 1.5f, "accent louder on beat 1");
	CHECK(peakNear(2) < 1e-4, "beat 3 muted");
	CHECK(peakNear(3) > 0.05f, "beat 4 back");
}

static void testClickSubdivision() {
	Run r(Role::Click);
	Command c; c.type = Command::ClickSet; c.click.sub = 2; r.core.push(c);
	r.go(1.0);
	long want = r.beatSample(0.5), got = r.onset(want - 50, 1e-7f);
	CHECK(got >= want && got - want <= 2, "eighth note at half a beat");
}

static void testClickSilentWhenStopped() {
	Run r(Role::Click);
	r.playing = false;
	r.go(1.0);
	CHECK(r.onset() < 0, "no click while stopped");
}

static void testCueStartsOnItsBeat() {
	Run r(Role::Cues);
	Command s; s.type = Command::CueSlot; s.idx = 3; s.sample = tone(r.sr, 0.3); r.core.push(s);
	Command a; a.type = Command::CueArm; a.idx = 3; a.beat = 2.37; r.core.push(a);
	r.go(2.0);
	long want = r.beatSample(2.37), got = r.onset(0, 1e-6);
	CHECK(got >= want - 1 && got <= want + 1, ("cue at its sample: want " + std::to_string(want) + " got " + std::to_string(got)).c_str());
	CHECK(r.core.firedCount.load() == 1 && r.core.firedCue.load() == 3, "reported as fired");
}

static void testCueDisarmAndPlayNow() {
	Run r(Role::Cues);
	Command s; s.type = Command::CueSlot; s.idx = 1; s.sample = tone(r.sr, 0.2); r.core.push(s);
	Command a; a.type = Command::CueArm; a.idx = 1; a.beat = 1; r.core.push(a);
	Command d; d.type = Command::CueDisarm; r.core.push(d);
	r.go(1.0);
	CHECK(r.onset() < 0, "disarmed cue is silent");
	Command p; p.type = Command::CuePlay; p.idx = 1; r.core.push(p);
	long before = (long)r.L.size();
	r.go(0.1);
	CHECK(r.onset(before, 1e-6) == before, "play now starts with the next block");
}

static void testGateClosesOnItsBeat() {
	Run r(Role::Guide);
	Command a; a.type = Command::GateArm; a.beat = 1.0; a.a = 0; r.core.push(a);
	r.go(1.0, 0.5f);
	long b = r.beatSample(1.0);
	CHECK(std::fabs(r.L[b - 10] - 0.5f) < 1e-6, "guide passes before the beat");
	CHECK(std::fabs(r.L[b + (long)(0.005 * r.sr)]) < 1e-6, "closed 5 ms after the beat (4 ms ramp)");
	CHECK(r.L[b + 50] < 0.5f && r.L[b + 50] > 0, "ramps, no hard cut");
}

static void testGateNow() {
	Run r(Role::Guide);
	Command a; a.type = Command::GateNow; a.a = 0; r.core.push(a);
	r.go(0.1, 0.5f);
	CHECK(std::fabs(r.L.back()) < 1e-6, "gatenow closes");
}

static void testTailCrossfade() {
	Run r(Role::Tail);
	Command l; l.type = Command::TailLoad; l.sample = tone(r.sr, 3.0); r.core.push(l);
	Command p; p.type = Command::TailPlay; p.a = 1.0; p.b = 1000; p.c = 2; p.d = 0; r.core.push(p);
	r.go(1.5);
	float early = 0, late = 0;
	for (long i = 0; i < 4800; ++i) early = std::max(early, std::fabs(r.L[i]));
	for (long i = (long)(1.05 * r.sr); i < (long)(1.4 * r.sr); ++i) late = std::max(late, std::fabs(r.L[i]));
	CHECK(early > 0.4f, "tail starts at full level");
	CHECK(late < 1e-6, "crossfade ends after its duration");
}

static void testTailRate() {
	Run r(Role::Tail);
	auto s = std::make_shared<Sample>();
	for (int i = 0; i < 48000; ++i) { s->l.push_back(1.0f); }
	Command l; l.type = Command::TailLoad; l.sample = s; r.core.push(l);
	Command p; p.type = Command::TailPlay; p.a = 2.0; p.c = 1; r.core.push(p);
	r.go(1.0);
	long last = -1;
	for (size_t i = 0; i < r.L.size(); ++i) if (r.L[i] > 0.5f) last = (long)i;
	CHECK(std::abs(last - 24000) < 600, "twice the speed ends at half the time");
}

int main() {
	testClickOnTheGrid(); testClickNotBetweenBeats(); testClickAccentAndMute(); testClickSubdivision(); testClickSilentWhenStopped();
	testCueStartsOnItsBeat(); testCueDisarmAndPlayNow();
	testGateClosesOnItsBeat(); testGateNow();
	testTailCrossfade(); testTailRate();
	std::printf(failures ? "\n%d failing\n" : "\nall passing\n", failures);
	return failures ? 1 : 0;
}
