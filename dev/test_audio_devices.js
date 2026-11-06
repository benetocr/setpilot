// The interface Live plays through (from Live's log) and its outputs' names
// (from the helper), as the dashboard gets them.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { makeAudioInfo, liveOutputDevice } = require("../host/audio_devices");

(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-aud-"));
	fs.writeFileSync(path.join(dir, "Log.txt"), "x\ninfo: Audio In Out: Output Device: MacBook Speakers (0 In, 2 Out)\nlater\ninfo: Audio In Out: Output Device: Scarlett 18i20 USB (18 In, 20 Out)\n");
	assert.deepStrictEqual(liveOutputDevice([{ dir }]), { name: "Scarlett 18i20 USB", outputs: 20 });
	const helper = path.join(dir, "helper.sh");
	fs.writeFileSync(helper, "#!/bin/sh\necho '{\"devices\":[{\"name\":\"MacBook Speakers\",\"outputs\":2,\"channels\":[\"\",\"\"]},{\"name\":\"Scarlett 18i20 USB\",\"outputs\":4,\"channels\":[\"Monitor L\",\"Monitor R\",\"Line 3\",\"Line 4\"]}]}'\n");
	fs.chmodSync(helper, 0o755);
	process.env.SETPILOT_AUDIO_HELPER = helper;
	const real = process.platform;
	Object.defineProperty(process, "platform", { value: "darwin" });
	const info = await makeAudioInfo({ prefsDirs: [{ dir }] }).refresh();
	Object.defineProperty(process, "platform", { value: real });
	assert.deepStrictEqual(info, { device: "Scarlett 18i20 USB", outputs: 4, channels: ["Monitor L", "Monitor R", "Line 3", "Line 4"], known: true });
	console.log("ok   the interface Live uses and its outputs' names\n\nall passing");
})().catch(e => { console.log("FAIL " + e.message); process.exit(1); });
