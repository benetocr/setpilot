#include "AppLink.h"
#include "PluginProcessor.h"

static juce::File discoveryFile() {
	return juce::File::getSpecialLocation(juce::File::userHomeDirectory).getChildFile(".setpilot").getChildFile("app.json");
}

AppLink::AppLink(SetPilotProcessor& p) : juce::Thread("SetPilot link"), proc(p) {
	formats.registerBasicFormats();
	startThread();
}

AppLink::~AppLink() {
	signalThreadShouldExit();
	if (sock) sock->close();
	stopThread(3000);
}

void AppLink::sampleRateChanged(double s) {
	// decoded audio is kept at the host's rate: decode again when it changes
	if (std::abs(s - sr.load()) > 0.5) { sr.store(s); juce::ScopedLock l(statusLock); cache.clear(); lastRole = -1; }
}

juce::String AppLink::statusText() const {
	juce::ScopedLock l(statusLock);
	return lastError;
}

void AppLink::run() {
	while (!threadShouldExit()) {
		if (!connectOnce()) { wait(1500); continue; }
		juce::MemoryBlock line;
		juce::String buf;
		char chunk[8192];
		while (!threadShouldExit() && sock && sock->isConnected()) {
			// say who we are again whenever the role changes
			const int role = proc.role->getIndex();
			if (role != lastRole) {
				lastRole = role;
				juce::DynamicObject::Ptr o = new juce::DynamicObject();
				o->setProperty("t", "hello");
				o->setProperty("role", SetPilotProcessor::roleNames[role].toLowerCase());
				o->setProperty("sr", sr.load());
				o->setProperty("v", 1);
				send(juce::var(o.get()));
			}
			// tell the app when a cue actually started
			const int fired = proc.core.firedCount.load();
			if (fired != lastFired) {
				lastFired = fired;
				juce::DynamicObject::Ptr o = new juce::DynamicObject();
				o->setProperty("t", "fired");
				o->setProperty("idx", proc.core.firedCue.load());
				send(juce::var(o.get()));
			}
			// let go of samples nobody can be playing any more
			const auto now = juce::Time::getMillisecondCounter();
			while (!held.empty() && now - held.front().first > 60000 && held.size() > 8) held.pop_front();

			const int ready = sock->waitUntilReady(true, 50);
			if (ready < 0) break;
			if (ready == 0) continue;
			const int n = sock->read(chunk, sizeof(chunk), false);
			if (n <= 0) break;
			buf += juce::String::fromUTF8(chunk, n);
			int nl;
			while ((nl = buf.indexOfChar('\n')) >= 0) {
				const auto text = buf.substring(0, nl);
				buf = buf.substring(nl + 1);
				if (text.isNotEmpty()) handle(juce::JSON::parse(text));
			}
		}
		connected.store(false);
		{ juce::ScopedLock l(statusLock); lastError = "SetPilot app not running"; }
		if (sock) sock->close();
		sock.reset();
		lastRole = -1;
		wait(1000);
	}
}

bool AppLink::connectOnce() {
	auto info = juce::JSON::parse(discoveryFile());
	const int port = (int)info.getProperty("plugins", 0);
	if (port <= 0) { juce::ScopedLock l(statusLock); lastError = "SetPilot app not running"; return false; }
	sock = std::make_unique<juce::StreamingSocket>();
	if (!sock->connect("127.0.0.1", port, 1000)) { sock.reset(); juce::ScopedLock l(statusLock); lastError = "SetPilot app not answering"; return false; }
	connected.store(true);
	{ juce::ScopedLock l(statusLock); lastError = {}; }
	return true;
}

void AppLink::send(const juce::var& msg) {
	if (!sock) return;
	const auto text = juce::JSON::toString(msg, true) + "\n";
	sock->write(text.toRawUTF8(), (int)text.getNumBytesAsUTF8());
}

void AppLink::hold(const sp::SamplePtr& s) {
	if (s) held.emplace_back(juce::Time::getMillisecondCounter(), s);
}

// decodes a WAV/AIFF into memory at the host's sample rate
sp::SamplePtr AppLink::load(const juce::String& path, juce::int64 maxLen) {
	auto it = cache.find(path);
	if (it != cache.end()) return it->second;
	juce::File f(path);
	std::unique_ptr<juce::AudioFormatReader> r(formats.createReaderFor(f));
	if (!r || r->lengthInSamples <= 0 || r->lengthInSamples > (juce::int64)r->sampleRate * 600) return nullptr;
	const juce::int64 len = maxLen > 0 ? std::min(maxLen, r->lengthInSamples) : r->lengthInSamples;
	juce::AudioBuffer<float> b((int)std::min<unsigned>(2, r->numChannels), (int)len + 1);
	r->read(&b, 0, (int)len, 0, true, true);
	// a loop: the sample after the last is the first (for the interpolation below)
	for (int ch = 0; ch < b.getNumChannels(); ++ch) b.setSample(ch, (int)len, maxLen > 0 ? b.getSample(ch, 0) : b.getSample(ch, (int)len - 1));
	auto s = std::make_shared<sp::Sample>();
	const double ratio = r->sampleRate / sr.load();
	const int outLen = (int)std::floor((double)len / ratio);
	s->l.resize((size_t)std::max(0, outLen));
	if (b.getNumChannels() > 1) s->r.resize(s->l.size());
	for (int i = 0; i < outLen; ++i) {
		const double x = i * ratio;
		const int p = (int)x;
		const float fr = (float)(x - p);
		s->l[(size_t)i] = b.getSample(0, p) + (b.getSample(0, p + 1) - b.getSample(0, p)) * fr;
		if (b.getNumChannels() > 1) s->r[(size_t)i] = b.getSample(1, p) + (b.getSample(1, p + 1) - b.getSample(1, p)) * fr;
	}
	cache[path] = s;
	return s;
}

void AppLink::handle(const juce::var& m) {
	const auto t = m.getProperty("t", "").toString();
	sp::Command c;
	if (t == "click") {
		const auto p = m.getProperty("p", juce::var());
		auto& k = c.click;
		k.on = (int)p.getProperty("on", 1) != 0;
		k.beats = (int)p.getProperty("beats", 4);
		k.sub = (int)p.getProperty("sub", 1);
		k.accMask = (juce::uint32)(int)p.getProperty("accmask", 1);
		k.muteMask = (juce::uint32)(int)p.getProperty("mutemask", 0);
		k.lvlAcc = (float)(double)p.getProperty("lvlacc", 1.0);
		k.lvlBeat = (float)(double)p.getProperty("lvlbeat", 0.8);
		k.lvlSub = (float)(double)p.getProperty("lvlsub", 0.5);
		k.sound = (int)p.getProperty("sound", 0);
		k.gain = (float)(double)p.getProperty("gain", 1.0);
		k.thru = (int)p.getProperty("thru", 0) != 0;
		c.type = sp::Command::ClickSet;
	} else if (t == "preload") {
		c.type = sp::Command::CueSlot;
		c.idx = (int)m.getProperty("idx", 0);
		c.sample = load(m.getProperty("path", "").toString());
		hold(c.sample);
	} else if (t == "arm") {
		c.type = sp::Command::CueArm; c.idx = (int)m.getProperty("idx", 0); c.beat = (double)m.getProperty("beat", sp::Core::FAR);
	} else if (t == "disarm") {
		c.type = sp::Command::CueDisarm;
	} else if (t == "play") {
		c.type = sp::Command::CuePlay; c.idx = (int)m.getProperty("idx", 0);
	} else if (t == "gatearm") {
		c.type = sp::Command::GateArm; c.beat = (double)m.getProperty("beat", sp::Core::FAR); c.a = (double)m.getProperty("v", 1.0);
	} else if (t == "gatenow") {
		c.type = sp::Command::GateNow; c.a = (double)m.getProperty("v", 1.0);
	} else if (t == "tailload") {
		c.type = sp::Command::TailLoad; c.sample = load(m.getProperty("path", "").toString()); hold(c.sample);
	} else if (t == "tailplay") {
		c.type = sp::Command::TailPlay;
		c.a = (double)m.getProperty("rate", 1.0); c.b = (double)m.getProperty("durMs", 0.0);
		c.c = (double)m.getProperty("mode", 1.0); c.d = (double)m.getProperty("offsetMs", 0.0);
	} else if (t == "tailstop") {
		c.type = sp::Command::TailStop;
	} else if (t == "padev") {
		c.type = sp::Command::PadEvent;
		c.beat = (double)m.getProperty("beat", sp::Core::FAR);
		c.a = (double)m.getProperty("root", 0); c.b = (double)m.getProperty("q", 0);
	} else if (t == "padclear") {
		c.type = sp::Command::PadClear;
	} else if (t == "padlevel") {
		c.type = sp::Command::PadLevel;
		c.a = (double)m.getProperty("v", 0.8);
	} else if (t == "padload") {
		// one recorded pad loop: exactly "len" samples of the file loop (encoders pad the end)
		c.type = sp::Command::PadLoad;
		c.idx = (int)m.getProperty("root", -1);
		c.sample = load(m.getProperty("path", "").toString(), (juce::int64)(double)m.getProperty("len", 0.0));
		hold(c.sample);
	} else return;
	proc.core.push(std::move(c));
}
