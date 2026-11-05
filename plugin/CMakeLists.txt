cmake_minimum_required(VERSION 3.22)
project(SetPilotAudio VERSION 0.1.0)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")

if(NOT SP_FORMATS)
  if(APPLE)
    set(SP_FORMATS AU VST3)
  else()
    set(SP_FORMATS VST3)
  endif()
endif()

include(FetchContent)
FetchContent_Declare(juce GIT_REPOSITORY https://github.com/juce-framework/JUCE.git GIT_TAG 8.0.4 GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(juce)

juce_add_plugin(SetPilotAudio
    COMPANY_NAME "SetPilot"
    COMPANY_WEBSITE "https://setpilot.app"
    BUNDLE_ID "app.setpilot.audio"
    PLUGIN_MANUFACTURER_CODE Stpl
    PLUGIN_CODE Spau
    PRODUCT_NAME "SetPilot Audio"
    FORMATS ${SP_FORMATS}
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE
    VST3_CATEGORIES Fx Tools
    AU_MAIN_TYPE kAudioUnitType_Effect)

target_sources(SetPilotAudio PRIVATE src/PluginProcessor.cpp src/PluginEditor.cpp src/AppLink.cpp)
target_include_directories(SetPilotAudio PRIVATE src)
target_compile_definitions(SetPilotAudio PUBLIC
    JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_VST3_CAN_REPLACE_VST2=0 JUCE_DISPLAY_SPLASH_SCREEN=0)
target_link_libraries(SetPilotAudio PRIVATE juce::juce_audio_utils juce::juce_audio_formats
    PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_lto_flags juce::juce_recommended_warning_flags)

# the DSP core's own tests (no JUCE)
add_executable(core_test tests/core_test.cpp)
target_include_directories(core_test PRIVATE src)
