// Time signatures for the click: how a bar is grouped (one unit per beat in
// 4/4 or 3/4, threes in 6/8, twos and threes in 7/8) and how loud each unit
// clicks: 4 accent, 3 lighter accent, 2 beat, 1 soft, 0 off. The same rules
// as the engine's, a row of beats to tap, and a preview to hear it.
(function (root) {
  "use strict";
  var ACC = 4, MID = 3, BEAT = 2, SOFT = 1, OFF = 0;

  function parse(m) {
    var x = String(m || "").match(/^(\d+)\/(\d+)$/);
    return x ? { n: Math.max(1, Math.min(32, +x[1])), d: +x[2] } : { n: 4, d: 4 };
  }
  function groupsFor(n, d, want) {
    if (want && want.length) { var sum = 0; want.forEach(function (v) { sum += v; }); if (sum === n) return want.slice(); }
    var g = [], k;
    if (d < 8) { for (k = 0; k < n; k++) g.push(1); return g; }
    if (n <= 3) return [n];
    if (n % 3 === 0) { for (k = 0; k < n / 3; k++) g.push(3); return g; }
    if (n === 5) return [3, 2];
    if (n === 7) return [2, 2, 3];
    for (k = n; k > 3; k -= 2) g.push(2);
    g.push(k);
    return g;
  }
  function defaultPattern(n, d, groups, every) {
    var out = [], gs = groupsFor(n, d, groups);
    gs.forEach(function (size, gi) {
      for (var u = 0; u < size; u++) {
        if (u === 0) out.push(gi === 0 ? ACC : (gs.length > 1 && size > 1 ? MID : BEAT));
        else out.push(every === false ? OFF : SOFT);
      }
    });
    return out;
  }
  // the other ways to group an odd number of eighths (5/8, 7/8, 8/8, 10/8, 11/8)
  function groupings(n, d) {
    if (d < 8 || n <= 3 || n % 3 === 0 && n !== 9) return [];
    var out = [];
    (function rec(left, cur) {
      if (out.length > 6) return;
      if (left === 0) { out.push(cur.slice()); return; }
      [2, 3].forEach(function (s) { if (s <= left) { cur.push(s); rec(left - s, cur); cur.pop(); } });
    })(n, []);
    if (n === 9) out = [[3, 3, 3], [2, 2, 2, 3], [2, 2, 3, 2], [3, 2, 2, 2]];
    return out.slice(0, 6);
  }
  function compound(n, d) { return d >= 8 && n % 3 === 0 && n > 3; }
  // the subdivision buttons' names for the bottom number of the time signature
  function subNames(d, T) {
    if (d >= 8) return [T("subE"), T("subS"), T("subT3"), T("sub32")];
    if (d === 2) return [T("subH"), T("subQ"), T("subT3"), T("subE")];
    return [T("sub1"), T("sub2"), T("sub3"), T("sub4")];
  }

  // a row of the bar's units, grouped; data-u is the unit, data-v its level
  function beatsHtml(pat, groups, esc) {
    var html = "", u = 0;
    (groups && groups.length ? groups : pat.map(function () { return 1; })).forEach(function (size, gi) {
      html += '<span class="mt-group' + (gi ? " mt-after" : "") + '">';
      for (var k = 0; k < size && u < pat.length; k++, u++) html += '<button type="button" class="beat lv' + pat[u] + '" data-u="' + u + '" data-v="' + pat[u] + '">' + (u + 1) + "</button>";
      html += "</span>";
    });
    return html;
  }
  function nextLevel(v) { return { 4: 3, 3: 2, 2: 1, 1: 0, 0: 4 }[v]; }

  // hearing a bar before it goes into Live
  var P = { ctx: null, timer: 0, next: 0, k: 0, spec: null };
  function preview(spec) {
    stop();
    if (!spec) return;
    P.ctx = P.ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (P.ctx.state === "suspended") P.ctx.resume();
    P.spec = spec;
    P.next = P.ctx.currentTime + 0.08;
    P.k = 0;
    P.timer = setInterval(schedule, 40);
    schedule();
  }
  function schedule() {
    var s = P.spec, ctx = P.ctx;
    if (!s) return;
    var m = parse(s.meter), unit = 60 / s.bpm * 4 / m.d, sub = s.sub || 1, step = unit / sub;
    while (P.next < ctx.currentTime + 0.2) {
      var u = Math.floor(P.k / sub) % m.n, lv = s.pat[u], isSub = P.k % sub !== 0;
      if (lv > 0) {
        var f = isSub ? 800 : lv === 4 ? 1600 : lv === 3 ? 1350 : lv === 2 ? 1100 : 800;
        var g = isSub ? 0.3 : lv === 4 ? 0.9 : lv === 3 ? 0.7 : lv === 2 ? 0.55 : 0.3;
        var o = ctx.createOscillator(), gn = ctx.createGain();
        o.frequency.value = f;
        gn.gain.setValueAtTime(g, P.next);
        gn.gain.exponentialRampToValueAtTime(0.001, P.next + 0.05);
        o.connect(gn).connect(ctx.destination);
        o.start(P.next); o.stop(P.next + 0.06);
      }
      P.next += step;
      P.k++;
    }
  }
  function stop() { clearInterval(P.timer); P.timer = 0; P.spec = null; }
  function playing() { return !!P.spec; }
  function update(spec) { if (P.spec) P.spec = spec; }

  var api = { ACC: ACC, MID: MID, BEAT: BEAT, SOFT: SOFT, OFF: OFF, parse: parse, groupsFor: groupsFor, defaultPattern: defaultPattern, groupings: groupings,
    compound: compound, subNames: subNames, beatsHtml: beatsHtml, nextLevel: nextLevel, preview: preview, stop: stop, playing: playing, update: update };
  root.SPMeter = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
