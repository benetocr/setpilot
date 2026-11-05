#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include "PluginProcessor.h"

// Small panel: which job this instance does, and whether it found the app.
class SetPilotEditor : public juce::AudioProcessorEditor, private juce::Timer {
public:
	explicit SetPilotEditor(SetPilotProcessor&);
	void paint(juce::Graphics&) override;
	void resized() override;

private:
	void timerCallback() override;
	SetPilotProcessor& proc;
	juce::OwnedArray<juce::TextButton> roles;
	bool connected = false;
	juce::String status;
};
