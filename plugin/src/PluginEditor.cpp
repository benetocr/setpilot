#include "PluginEditor.h"
#include "AppLink.h"

namespace {
const juce::Colour cStage(0xff15171f), cDeck(0xff1c1f29), cRaise(0xff252a37), cEdge(0xff323849);
const juce::Colour cText(0xfff3f4f8), cDim(0xff9ca2b6), cLive(0xff5be49b), cQueued(0xffffb547);
}

SetPilotEditor::SetPilotEditor(SetPilotProcessor& p) : AudioProcessorEditor(p), proc(p) {
	for (int i = 0; i < SetPilotProcessor::roleNames.size(); ++i) {
		auto* b = roles.add(new juce::TextButton(SetPilotProcessor::roleNames[i]));
		b->setClickingTogglesState(false);
		b->setColour(juce::TextButton::buttonColourId, cRaise);
		b->setColour(juce::TextButton::buttonOnColourId, cLive);
		b->setColour(juce::TextButton::textColourOffId, cText);
		b->setColour(juce::TextButton::textColourOnId, cStage);
		b->onClick = [this, i] { *proc.role = i; timerCallback(); };
		addAndMakeVisible(b);
	}
	setSize(360, 120);
	startTimerHz(4);
	timerCallback();
}

void SetPilotEditor::timerCallback() {
	const int r = proc.role->getIndex();
	for (int i = 0; i < roles.size(); ++i) roles[i]->setToggleState(i == r, juce::dontSendNotification);
	const bool c = proc.link && proc.link->isConnected();
	const auto s = c ? juce::String("Connected to SetPilot") : (proc.link ? proc.link->statusText() : juce::String());
	if (c != connected || s != status) { connected = c; status = s; repaint(); }
}

void SetPilotEditor::paint(juce::Graphics& g) {
	g.fillAll(cStage);
	g.setColour(cText);
	g.setFont(juce::FontOptions(15.0f, juce::Font::bold));
	g.drawText("SetPilot Audio", 16, 12, 200, 20, juce::Justification::left);
	g.setColour(connected ? cLive : cQueued);
	g.fillEllipse(16.0f, 92.0f, 8.0f, 8.0f);
	g.setColour(cDim);
	g.setFont(juce::FontOptions(12.0f));
	g.drawText(status.isEmpty() ? "Looking for the SetPilot app" : status, 32, 86, 300, 20, juce::Justification::left);
}

void SetPilotEditor::resized() {
	auto area = juce::Rectangle<int>(16, 42, getWidth() - 32, 32);
	const int w = area.getWidth() / roles.size();
	for (auto* b : roles) b->setBounds(area.removeFromLeft(w).reduced(2, 0));
}
