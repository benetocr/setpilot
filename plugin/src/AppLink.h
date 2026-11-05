#pragma once
#include <juce_core/juce_core.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <deque>
#include "Core.h"

class SetPilotProcessor;

// The plugin's line to the SetPilot app: finds it through ~/.setpilot/app.json,
// connects on 127.0.0.1, says which role it plays and turns the app's
// messages into commands for the audio thread. Reconnects on its own.
class AppLink : private juce::Thread {
public:
	explicit AppLink(SetPilotProcessor& p);
	~AppLink() override;
	void sampleRateChanged(double sr);
	bool isConnected() const { return connected.load(); }
	juce::String statusText() const;

private:
	void run() override;
	bool connectOnce();
	void handle(const juce::var& msg);
	void send(const juce::var& msg);
	sp::SamplePtr load(const juce::String& path);
	void hold(const sp::SamplePtr& s);

	SetPilotProcessor& proc;
	std::unique_ptr<juce::StreamingSocket> sock;
	std::atomic<bool> connected{false};
	std::atomic<double> sr{48000};
	juce::AudioFormatManager formats;
	// every sample we gave the audio thread stays referenced here for a while,
	// so the audio thread never frees memory
	std::deque<std::pair<juce::uint32, sp::SamplePtr>> held;
	std::map<juce::String, sp::SamplePtr> cache;   // path -> decoded audio
	int lastRole = -1, lastFired = 0;
	juce::String lastError;
	mutable juce::CriticalSection statusLock;
};
