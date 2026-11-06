// SetPilot desktop app: lives in the menu bar, starts with the computer,
// connects to Live by itself and serves the dashboard. Nothing to configure.

const { app, Tray, Menu, BrowserWindow, nativeImage, shell, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

if (!app.requestSingleInstanceLock()) { app.quit(); return; }

const ES = /^es/i.test(app.getLocale ? app.getLocale() : "") || /^es/i.test(process.env.LANG || "");
const T = ES ? {
	searching: "Buscando Live…", connecting: "Conectando con Live…", connected: v => "Conectado a Live " + v,
	answers: ms => "Live responde en " + ms + " ms", openMain: "Abrir SetPilot", openDash: "Abrir en el navegador", showStatus: "Estado y código QR…",
	atLogin: "Abrir al iniciar sesión", quit: "Salir de SetPilot", title: "SetPilot"
} : {
	searching: "Looking for Live…", connecting: "Connecting to Live…", connected: v => "Connected to Live " + v,
	answers: ms => "Live answers in " + ms + " ms", openMain: "Open SetPilot", openDash: "Open in the browser", showStatus: "Status and QR code…",
	atLogin: "Open at login", quit: "Quit SetPilot", title: "SetPilot"
};

let host = null, tray = null, win = null, main = null, quitting = false;
const ASSETS = path.join(__dirname, "assets");
const icon = name => { const i = nativeImage.createFromPath(path.join(ASSETS, name)); i.setTemplateImage(true); return i; };

function liveLine(st) {
	if (st.live === "connected") return T.connected((st.liveInfo && st.liveInfo.live) || "");
	if (st.live === "connecting") return T.connecting;
	return T.searching;
}

function buildMenu() {
	const st = host.status;
	const items = [{ label: liveLine(st), enabled: false }];
	if (st.live === "connected" && st.latency) items.push({ label: T.answers(st.latency.p50), enabled: false });
	items.push(
		{ type: "separator" },
		{ label: T.openMain, click: showMain },
		{ label: T.openDash, enabled: !!(st.dashboard && st.dashboard.local), click: () => shell.openExternal(st.dashboard.local) },
		{ label: T.showStatus, click: showWindow },
		{ type: "separator" },
		{ label: T.atLogin, type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: m => app.setLoginItemSettings({ openAtLogin: m.checked, openAsHidden: true }) },
		{ label: T.quit, click: () => app.quit() }
	);
	return Menu.buildFromTemplate(items);
}

let lastKey = "";
function refreshTray() {
	if (!tray || !host) return;
	const st = host.status;
	const key = [st.live, st.latency && st.latency.p50, st.dashboard && st.dashboard.local].join("|");
	if (key === lastKey) return;
	lastKey = key;
	tray.setImage(icon(st.live === "connected" ? "trayTemplate.png" : "trayIdleTemplate.png"));
	tray.setToolTip("SetPilot: " + liveLine(st));
	tray.setContextMenu(buildMenu());
}

function showWindow() {
	if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
	win = new BrowserWindow({
		width: 420, height: 720, resizable: false, title: T.title, backgroundColor: "#15171f",
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
		webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
	});
	win.loadFile(path.join(__dirname, "status.html"), { query: { lang: ES ? "es" : "en" } });
	win.on("closed", () => { win = null; dockShow(false); });
	// development: SETPILOT_SNAPSHOT=file.png saves the window and quits
	if (process.env.SETPILOT_SNAPSHOT) setTimeout(async () => {
		const img = await win.webContents.capturePage();
		fs.writeFileSync(process.env.SETPILOT_SNAPSHOT, img.toPNG());
		app.quit();
	}, Number(process.env.SETPILOT_SNAPSHOT_MS || 4000));
}

// The app's own window is the dashboard: the start screen (add a song, open
// a saved setlist) is the first thing the user sees.
function dockShow(on) {
	if (process.platform !== "darwin" || !app.dock) return;
	if (on) app.dock.show(); else if (!main && !win) app.dock.hide();
}
function showMain() {
	if (main && !main.isDestroyed()) { main.show(); main.focus(); return; }
	main = new BrowserWindow({
		width: 1320, height: 860, minWidth: 900, minHeight: 600, title: T.title, backgroundColor: "#15171f", show: false,
		webPreferences: { contextIsolation: true, nodeIntegration: false }
	});
	main.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
	main.once("ready-to-show", () => main.show());
	main.on("closed", () => { main = null; dockShow(false); });
	dockShow(true);
	const load = (tries) => {
		if (!main || main.isDestroyed()) return;
		const st = host.status;
		if (st.dashboard && st.dashboard.local) main.loadURL(st.dashboard.local);
		else if (tries > 0) setTimeout(() => load(tries - 1), 250);
		else main.loadFile(path.join(__dirname, "status.html"), { query: { lang: ES ? "es" : "en" } });
	};
	load(60);
}

ipcMain.handle("status", async () => {
	const st = host.status;
	let songs = null;
	if (st.dashboard && st.dashboard.local) {
		try {
			const r = await fetch(st.dashboard.local + "/state");
			const s = await r.json();
			songs = s.struct && s.struct.songs ? s.struct.songs.length : 0;
		} catch (e) { }
	}
	return {
		live: st.live, liveVersion: st.liveInfo && st.liveInfo.live, latency: st.latency,
		dashboard: st.dashboard || null, songs,
		// once Live talks to us, "restart Live" and "choose SetPilot" are done
		steps: ((st.setup && st.setup.steps) || []).filter(x => st.live !== "connected" || !["restart-live", "auto-select"].includes(x.id)),
		qr: st.dashboard ? await host.qrSvg() : "",
		setRoles: st.setRoles || {}, plugins: st.plugins || {}
	};
});
ipcMain.handle("prepare", () => host.prepareSet());
ipcMain.handle("open", (e, what) => {
	const st = host.status;
	if (what === "dashboard" && st.dashboard) shell.openExternal(st.dashboard.local);
});

app.whenReady().then(() => {
	if (process.platform === "darwin" && app.dock) app.dock.hide();
	host = require("../host/main").startHost({ log: () => {} });

	// first run: start with the computer from now on (can be turned off in the menu)
	const marker = path.join(host.dataDir, "desktop.json");
	const first = !fs.existsSync(marker);
	if (first) {
		if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
		fs.writeFileSync(marker, JSON.stringify({ firstRun: new Date().toISOString() }));
	}

	tray = new Tray(icon("trayIdleTemplate.png"));
	tray.on("click", () => tray.popUpContextMenu());
	refreshTray();
	setInterval(refreshTray, 1000);

	const hidden = app.getLoginItemSettings().wasOpenedAsHidden || process.argv.includes("--hidden");
	if (first || !hidden) showMain();
});

app.on("second-instance", showMain);
app.on("activate", showMain);
app.on("window-all-closed", () => { /* keep running in the menu bar */ });

// put the set back as it was before quitting
app.on("before-quit", e => {
	if (quitting || !host) return;
	e.preventDefault();
	quitting = true;
	host.stop().finally(() => app.exit(0));
});
