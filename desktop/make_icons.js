// Draws the menu bar icons (macOS "template" images: black on transparent,
// the system tints them) from SetPilot's mark: the setlist line.
//   node desktop/make_icons.js
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const LINE = [[96, 352], [208, 192], [288, 304], [344, 224], [416, 352]];   // same as core/ui/icon.svg

function segDist(px, py, ax, ay, bx, by) {
	const dx = bx - ax, dy = by - ay;
	const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function draw(size, { hollow = false } = {}) {
	const png = new PNG({ width: size, height: size });
	const s = size / 384, w = (hollow ? 22 : 46) * s, ss = 4;
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		let cover = 0;
		for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
			const px = (x + (sx + 0.5) / ss) / s + 64, py = (y + (sy + 0.5) / ss) / s + 80;
			let d = Infinity;
			for (let i = 0; i < LINE.length - 1; i++) d = Math.min(d, segDist(px, py, ...LINE[i], ...LINE[i + 1]));
			let inside = d * s <= w / 2;
			if (inside) cover++;
		}
		const i = (y * size + x) * 4;
		png.data[i] = png.data[i + 1] = png.data[i + 2] = 0;
		png.data[i + 3] = Math.round(255 * cover / (ss * ss));
	}
	return PNG.sync.write(png);
}

const out = path.join(__dirname, "assets");
fs.writeFileSync(path.join(out, "trayTemplate.png"), draw(18));
fs.writeFileSync(path.join(out, "trayTemplate@2x.png"), draw(36));
fs.writeFileSync(path.join(out, "trayIdleTemplate.png"), draw(18, { hollow: true }));
fs.writeFileSync(path.join(out, "trayIdleTemplate@2x.png"), draw(36, { hollow: true }));
console.log("icons written");
