#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include "Core.h"

class AppLink;

class SetPilotProcessor : public juce::AudioProcessor {
public:
	SetPilotProcessor();
	~SetPilotProcessor() override;

	void prepareToPlay(double sampleRate, int samplesPerBlock) override;
	void releaseResources() override {}
	bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
	void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

	juce::AudioProcessorEditor* createEditor() override;
	bool hasEditor() const override { return true; }
	const juce::String getName() const override { return "SetPilot Audio"; }
	bool acceptsMidi() const override { return false; }
	bool producesMidi() const override { return false; }
	double getTailLengthSeconds() const override { return 0; }
	int getNumPrograms() override { return 1; }
	int getCurrentProgram() override { return 0; }
	void setCurrentProgram(int) override {}
	const juce::String getProgramName(int) override { return {}; }
	void changeProgramName(int, const juce::String&) override {}
	void getStateInformation(juce::MemoryBlock&) override;
	void setStateInformation(const void*, int) override;

	sp::Core core;
	juce::AudioParameterChoice* role = nullptr;
	std::unique_ptr<AppLink> link;
	double currentSampleRate() const { return sampleRate.load(); }
	static const juce::StringArray roleNames;

private:
	std::atomic<double> sampleRate{48000};
	JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SetPilotProcessor)
};
