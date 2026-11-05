const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("setpilot", {
	status: () => ipcRenderer.invoke("status"),
	open: what => ipcRenderer.invoke("open", what)
});
