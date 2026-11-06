// Lists the Mac's audio devices that have outputs, with the name of each
// output channel as the interface reports it ("Monitor L", "Line Out 3"...),
// as JSON on stdout. SetPilot uses it to name Live's Ext. Out channels.
//
//   clang -arch arm64 -arch x86_64 -O2 -o sp-audio-outputs audio_outputs.c -framework CoreAudio -framework CoreFoundation

#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <stdlib.h>

static void put_json_string(CFStringRef s) {
	char buf[512];
	if (!s || !CFStringGetCString(s, buf, sizeof buf, kCFStringEncodingUTF8)) buf[0] = 0;
	putchar('"');
	for (char *p = buf; *p; p++) {
		unsigned char c = (unsigned char)*p;
		if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
		else if (c < 0x20) printf("\\u%04x", c);
		else putchar(c);
	}
	putchar('"');
}

static CFStringRef get_string(AudioObjectID obj, AudioObjectPropertySelector sel, AudioObjectPropertyScope scope, UInt32 element) {
	AudioObjectPropertyAddress a = { sel, scope, element };
	if (!AudioObjectHasProperty(obj, &a)) return NULL;
	CFStringRef s = NULL;
	UInt32 size = sizeof s;
	if (AudioObjectGetPropertyData(obj, &a, 0, NULL, &size, &s) != noErr) return NULL;
	return s;
}

static UInt32 output_channels(AudioObjectID dev) {
	AudioObjectPropertyAddress a = { kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeOutput, kAudioObjectPropertyElementMain };
	UInt32 size = 0;
	if (AudioObjectGetPropertyDataSize(dev, &a, 0, NULL, &size) != noErr || !size) return 0;
	AudioBufferList *bl = malloc(size);
	UInt32 n = 0;
	if (AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, bl) == noErr)
		for (UInt32 i = 0; i < bl->mNumberBuffers; i++) n += bl->mBuffers[i].mNumberChannels;
	free(bl);
	return n;
}

int main(void) {
	AudioObjectPropertyAddress a = { kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
	UInt32 size = 0;
	if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, NULL, &size) != noErr) { puts("{\"devices\":[]}"); return 0; }
	UInt32 count = size / sizeof(AudioObjectID);
	AudioObjectID *ids = malloc(size);
	AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, ids);

	AudioObjectID def = 0;
	AudioObjectPropertyAddress da = { kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
	UInt32 ds = sizeof def;
	AudioObjectGetPropertyData(kAudioObjectSystemObject, &da, 0, NULL, &ds, &def);

	printf("{\"devices\":[");
	int first = 1;
	for (UInt32 i = 0; i < count; i++) {
		UInt32 n = output_channels(ids[i]);
		if (!n) continue;
		if (!first) putchar(',');
		first = 0;
		printf("{\"name\":");
		CFStringRef name = get_string(ids[i], kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain);
		put_json_string(name);
		if (name) CFRelease(name);
		printf(",\"maker\":");
		CFStringRef maker = get_string(ids[i], kAudioObjectPropertyManufacturer, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain);
		put_json_string(maker);
		if (maker) CFRelease(maker);
		printf(",\"default\":%s,\"outputs\":%u,\"channels\":[", ids[i] == def ? "true" : "false", (unsigned)n);
		for (UInt32 c = 1; c <= n; c++) {
			if (c > 1) putchar(',');
			CFStringRef cn = get_string(ids[i], kAudioObjectPropertyElementName, kAudioObjectPropertyScopeOutput, c);
			put_json_string(cn);
			if (cn) CFRelease(cn);
		}
		printf("]}");
	}
	printf("]}\n");
	free(ids);
	return 0;
}
