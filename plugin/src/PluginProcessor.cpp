#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "AppLink.h"

const juce::StringArray SetPilotProcessor::roleNames { "Click", "Cues", "Guide", "Tail" };

SetPilotProcessor::SetPilotProcessor()
	: AudioProcessor(BusesProperties()
		.withInput("Input", juce::AudioChannelSet::stereo(), true)
		.withOutput("Output", juce::AudioChannelSet::stereo(), true)) {
	// "SetPilot Role" is how the app finds which track each instance is on
	addParameter(role = new juce::AudioParameterChoice({ "role", 1 }, "SetPilot Role", roleNames, 1));
	link = std::make_unique<AppLink>(*this);
}

SetPilotProcessor::~SetPilotProcessor() { link.reset(); }

bool SetPilotProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const {
	auto out = layouts.getMainOutputChannelSet();
	if (out != juce::AudioChannelSet::stereo() && out != juce::AudioChannelSet::mono()) return false;
	auto in = layouts.getMainInputChannelSet();
	return in.isDisabled() || in == out;
}

void SetPilotProcessor::prepareToPlay(double sr, int) {
	sampleRate.store(sr);
	core.prepare(sr);
	link->sampleRateChanged(sr);
}

void SetPilotProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) {
	juce::ScopedNoDenormals noDenormals;
	core.setRole((sp::Role)role->getIndex());
	sp::Transport tr;
	if (auto* ph = getPlayHead()) {
		if (auto pos = ph->getPosition()) {
			tr.playing = pos->getIsPlaying();
			if (auto p = pos->getPpqPosition()) tr.ppq = *p;
			if (auto b = pos->getBpm()) tr.bpm = *b;
			if (auto ts = pos->getTimeSignature()) { tr.sigNum = ts->numerator; tr.sigDen = ts->denominator; }
		}
	}
	const int n = buffer.getNumSamples(), ch = std::min(2, buffer.getNumChannels());
	float* chans[2] = { buffer.getWritePointer(0), ch > 1 ? buffer.getWritePointer(1) : nullptr };
	const bool hasInput = getTotalNumInputChannels() > 0;
	const float* ins[2] = { hasInput ? chans[0] : nullptr, hasInput && ch > 1 ? chans[1] : nullptr };
	core.process(hasInput ? ins : nullptr, chans, ch, n, tr);
}

void SetPilotProcessor::getStateInformation(juce::MemoryBlock& dest) {
	juce::MemoryOutputStream(dest, true).writeInt(role->getIndex());
}

void SetPilotProcessor::setStateInformation(const void* data, int size) {
	if (size >= 4) {
		juce::MemoryInputStream in(data, (size_t)size, false);
		*role = juce::jlimit(0, 3, in.readInt());
	}
}

juce::AudioProcessorEditor* SetPilotProcessor::createEditor() { return new SetPilotEditor(*this); }

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new SetPilotProcessor(); }
