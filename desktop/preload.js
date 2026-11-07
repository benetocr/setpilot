const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("setpilot", {
	status: () => ipcRenderer.invoke("status"),
	open: what => ipcRenderer.invoke("open", what),
	prepare: () => ipcRenderer.invoke("prepare"),
	// where a dropped or picked file is on disk (the stems assistant needs it)
	pathFor: file => { try { return webUtils.getPathForFile(file) || ""; } catch (e) { return ""; } }
});
