// The stems assistant: a folder of tracks (no Live Set) becomes a song in the
// set. Two steps. "Song": the tracks, its name, key and tempo (heard from the
// click and the music). "Parts": the song on a timeline with its bars, the
// parts already placed (from the guide's cues, or where instruments come and
// go); play it, tap M where a part starts, drag, rename. Then it goes to Live.
(function () {
  "use strict";
  var D = window.SPStemsDSP, I = window.SPI18N, T = I.T;
  var $ = function (id) { return document.getElementById(id); };
  var app = null;        // helpers from the dashboard (esc, toast, colors...)
  var SR = 22050, FPS = 100;
  var NAMES = ["Count In", "Intro", "Verse", "Pre-Chorus", "Chorus", "Post-Chorus", "Bridge", "Interlude", "Instrumental", "Tag", "Vamp", "Turnaround", "Outro", "Ending"];
  var ROLES = ["click", "guide", "drums", "perc", "bass", "eg", "ag", "keys", "synth", "strings", "vox", "loops", "other"];
  var NOT_MUSIC = { click: 1, guide: 1 };
  var NOT_PITCH = { click: 1, guide: 1, drums: 1, perc: 1, loops: 1 };
  var W = null;           // the wizard's state

  function esc(s) { return app.esc(s); }
  function fmtTime(sec) { sec = Math.max(0, sec); var m = Math.floor(sec / 60), s = sec - m * 60; return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1); }
  function barSec() { var m = W.meter.split("/"); return (+m[0]) * (4 / +m[1]) * 60 / W.bpm; }
  function barAt(t) { return Math.floor((t - W.down) / barSec() + 1e-6) + 1; }
  function timeOfBar(b) { return W.down + (b - 1) * barSec(); }
  function nBars() { return Math.max(1, Math.ceil((W.dur - W.down) / barSec() - 1e-6)); }

  // ---------------------------------------------------------------- open
  function open(list, folder) {
    var files = list.filter(function (f) { return /\.(wav|wave|aif|aiff|mp3|m4a|flac|ogg)$/i.test(f.name); });
    if (!files.length) { app.toast(T("swNoAudio"), true); return; }
    stopPlay();
    W = { step: 1, files: files, folder: folder || "", tracks: [], title: "", key: "", bpm: 0, meter: "4/4", down: 0, dur: 0,
      heard: {}, busy: true, parts: [], zoom: 0, t: 0, sel: -1, scroll: 0, tlH: 0 };
    try { W.tlH = +localStorage.getItem("sp.swTlH") || 0; } catch (e) { }
    $("addSheet").hidden = true;
    $("stemWiz").hidden = false;
    render();
    var pathFor = window.setpilot && window.setpilot.pathFor;
    var body = { folder: W.folder, files: files.map(function (f) { return { name: f.name, size: f.size, mtime: f.lastModified, rel: f.webkitRelativePath ? f.webkitRelativePath.split("/").slice(1).join("/") : "", path: pathFor ? pathFor(f) : "" }; }) };
    fetch("/stems/find", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!W) return;
        if (!r.ok) { W.busy = false; W.error = T(r.error === "no_audio" ? "swNoAudio" : "swNotFound"); render(); return; }
        W.title = r.title || W.folder;
        W.key = r.key || "";
        W.bpm = r.bpm || 0;
        W.named = { key: !!r.key, bpm: !!r.bpm };
        W.tracks = r.files.map(function (x, i) { return { file: files[i], path: x.path, name: x.track, role: x.role, include: true, env: null, dur: 0 }; });
        // the click and the guide first, then the band in the usual order
        W.tracks.sort(function (a, b) { return (ROLES.indexOf(a.role) - ROLES.indexOf(b.role)) || a.name.localeCompare(b.name, undefined, { numeric: true }); });
        render();
        listen();
      })
      .catch(function () { if (W) { W.busy = false; W.error = T("swNotFound"); render(); } });
  }
  function close() {
    stopPlay();
    $("stemWiz").hidden = true;
    W = null;
  }

  // ---------------------------------------------------------------- listening
  function decode(file) {
    return file.arrayBuffer().then(function (buf) {
      var ctx = new OfflineAudioContext(2, 1, SR);
      return new Promise(function (res, rej) { ctx.decodeAudioData(buf, res, rej); });
    });
  }
  function mono(ab) {
    var n = ab.length, x = new Float32Array(n), ch = ab.numberOfChannels;
    for (var c = 0; c < ch; c++) { var d = ab.getChannelData(c); for (var i = 0; i < n; i++) x[i] += d[i] / ch; }
    return x;
  }
  function addInto(dst, ab, gain) {
    for (var c = 0; c < 2; c++) {
      var d = ab.getChannelData(Math.min(c, ab.numberOfChannels - 1)), o = dst[c];
      for (var i = 0; i < d.length && i < o.length; i++) o[i] += d[i] * gain;
    }
  }
  function listen() {
    var tr = W.tracks, i = 0, longest = 0;
    W.mix = null; W.harm = null; W.clickX = null; W.guideX = null;
    W.progress = 0;
    var bufs = { mix: null, click: null, guide: null };
    function grow(n) {
      if (bufs.mix && bufs.mix[0].length >= n) return;
      var nb = [new Float32Array(n), new Float32Array(n)];
      if (bufs.mix) { nb[0].set(bufs.mix[0]); nb[1].set(bufs.mix[1]); }
      bufs.mix = nb;
    }
    function next() {
      if (!W || W.tracks !== tr) return;
      if (i >= tr.length) return finish();
      var t = tr[i];
      W.progress = i / tr.length;
      W.status = T("swListening", { name: t.name, i: i + 1, n: tr.length });
      renderStatus();
      decode(t.file).then(function (ab) {
        if (!W || W.tracks !== tr) return;
        var x = mono(ab);
        t.dur = ab.duration;
        t.env = D.envelope(x, SR, FPS);
        longest = Math.max(longest, ab.length);
        if (t.role === "click") { W.clickX = x; bufs.click = x; }
        else if (t.role === "guide") { W.guideX = x; bufs.guide = ab; }
        else { grow(longest); addInto(bufs.mix, ab, 0.6); }
        if (!NOT_PITCH[t.role]) {
          if (!W.harm) W.harm = new Float32Array(Math.ceil(longest / 2) + 1);
          if (W.harm.length < Math.ceil(ab.length / 2)) { var h = new Float32Array(Math.ceil(ab.length / 2) + 1); h.set(W.harm); W.harm = h; }
          for (var k = 0; k + 1 < x.length; k += 2) W.harm[k >> 1] += (x[k] + x[k + 1]) * 0.5;
        }
        i++;
        setTimeout(next, 0);
      }).catch(function () { t.include = false; t.bad = true; i++; setTimeout(next, 0); });
    }
    function finish() {
      W.dur = longest / SR;
      W.bufs = bufs;
      W.status = T("swThinking");
      renderStatus();
      setTimeout(analyse, 20);
    }
    next();
  }

  function analyse() {
    if (!W) return;
    var heard = W.heard = {};
    // tempo and beat one: the click if there is one, otherwise the music
    var ct = W.clickX ? D.tempoFromClick(D.clickOnsets(W.clickX, SR), W.named.bpm ? W.bpm : 0) : null;
    if (ct) {
      heard.bpm = ct.bpm; heard.meter = ct.meter; heard.down = ct.downbeat; heard.from = "click"; heard.steady = ct.steady; heard.accented = ct.accented;
      // no accent in the click: the guide's count in says where beat one is
      var gd = W.tracks.filter(function (t) { return t.role === "guide" && t.env; })[0];
      if (!ct.accented && gd) {
        var gb = D.downbeatFromGuide(gd.env, FPS, ct.firstClick, 60 / (W.named.bpm ? W.bpm : ct.bpm), ct.beats);
        if (gb != null) { heard.down = gb; heard.accented = true; heard.fromGuide = true; }
      }
    } else {
      var env = musicEnv(), low = lowEnv(), oc = D.onsetCurve(env);
      var bpm = W.bpm || D.tempoGuess(oc, FPS);
      heard.bpm = W.bpm ? 0 : bpm;
      heard.down = D.beatPhase(oc, FPS, bpm, low ? D.onsetCurve(low) : null);
      heard.meter = "4/4"; heard.from = "music";
    }
    if (!W.named.bpm && heard.bpm) W.bpm = heard.bpm;
    if (heard.meter) W.meter = heard.meter;
    W.down = heard.down || 0;
    // the key from the pitched tracks
    if (W.harm) {
      var k = D.keyFromChroma(D.chroma(W.harm, SR / 2));
      heard.key = k.key; heard.keySure = k.confidence;
      if (!W.named.key) W.key = k.key;
    }
    W.harm = null;
    W.clickX = null;
    suggestParts();
    W.busy = false;
    W.status = "";
    render();
    hearGuide();
  }

  // ---------------------------------------------------------------- the guide's words
  // Each cue the guide speaks goes to SetPilot (whisper, on this computer): its
  // words name the part that comes right after it, on the next bar line.
  function pcm16(x, a, z) {
    var i0 = Math.max(0, Math.floor(a * SR)), i1 = Math.min(x.length, Math.ceil(z * SR));
    var n = Math.max(0, Math.floor((i1 - i0) * 16000 / SR)), out = new Int16Array(n), r = SR / 16000;
    for (var k = 0; k < n; k++) {
      var p = i0 + k * r, j = Math.floor(p), f = p - j, v = x[j] * (1 - f) + (j + 1 < x.length ? x[j + 1] : 0) * f;
      out[k] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
    }
    var bin = "", u = new Uint8Array(out.buffer);
    for (var q = 0; q < u.length; q += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(q, q + 0x8000));
    return btoa(bin);
  }
  function hearGuide() {
    if (!W || !W.cues || !W.guideX) return;
    var w = W, cues = W.cues.slice(0, 80), x = W.guideX;
    w.hearing = true;
    renderStatus();
    var body = { cues: cues.map(function (c, i) { return { id: i, pcm: pcm16(x, c.a - 0.08, Math.min(c.z + 0.1, c.a + 8)) }; }) };
    fetch("/stems/hear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (W !== w) return;
        w.hearing = false;
        if (r && r.ok) applyHeard(cues, r.cues);
        render();
      })
      .catch(function () { if (W === w) { w.hearing = false; renderStatus(); } });
  }
  function applyHeard(cues, heard) {
    var named = 0, parts = [], firstCount = -1;
    heard.forEach(function (h, i) {
      var c = cues[i];
      if (!c) return;
      if (h.count) {
        // the count in: the part after it starts on the next bar; a count later on announces nothing new
        if (firstCount < 0 && i === 0) { firstCount = c.bar; parts.push({ bar: c.bar + 1, name: "Part", auto: true, heard: false }); }
        return;
      }
      if (h.name) named++;
      parts.push({ bar: c.bar + 1, name: h.name || "Part", auto: !h.name, heard: !!h.name, said: h.text || "" });
    });
    if (named < 2) return;      // it didn't make the words out: keep what it had
    // the count in, from the song's first bar to the first part
    if (firstCount >= 0 || !parts.length || parts[0].bar > 1) {
      if (!parts.some(function (p) { return p.bar === 1; })) parts.unshift({ bar: 1, name: "Count In", auto: false, heard: firstCount >= 0 });
    }
    parts.sort(function (a, b) { return a.bar - b.bar; });
    parts = parts.filter(function (p, i) { return i === 0 || p.bar !== parts[i - 1].bar; });
    // the part right after the count in, if the guide didn't name it
    if (parts[1] && !parts[1].heard && parts[0].name === "Count In") { parts[1].name = "Intro"; parts[1].auto = false; }
    if (W.edited) {
      // the musician already changed things: only names for the parts still unnamed at those bars
      W.parts.forEach(function (p) { if (p.auto) { var h = parts.filter(function (q) { return q.bar === p.bar && q.heard; })[0]; if (h) { p.name = h.name; p.auto = false; p.heard = true; } } });
    } else W.parts = parts;
    W.heardCount = named;
  }
  function musicEnv() {
    var env = null;
    W.tracks.forEach(function (t) {
      if (!t.env || NOT_MUSIC[t.role] || !t.include) return;
      if (!env) env = new Float32Array(t.env.length);
      for (var i = 0; i < Math.min(env.length, t.env.length); i++) env[i] += t.env[i];
    });
    return env || new Float32Array(1);
  }
  function lowEnv() {
    var env = null;
    W.tracks.forEach(function (t) {
      if (!t.env || !(t.role === "drums" || t.role === "bass")) return;
      if (!env) env = new Float32Array(t.env.length);
      for (var i = 0; i < Math.min(env.length, t.env.length); i++) env[i] += t.env[i];
    });
    return env;
  }

  // where the parts are: the guide's cues if there is a guide, otherwise where
  // instruments come and go; names from what sounds alike
  function suggestParts() {
    if (!W.bpm) return;
    var bs = barSec(), nb = nBars();
    var music = W.tracks.filter(function (t) { return t.env && !NOT_MUSIC[t.role] && t.include; });
    var A = D.barActivity(music.map(function (t) { return t.env; }), FPS, W.down, bs, nb);
    W.activity = A;
    var bounds = null, guide = W.tracks.filter(function (t) { return t.role === "guide" && t.env && t.include; })[0];
    W.cues = null;
    if (guide) {
      var cues = D.guideCues(guide.env, FPS, W.down, bs, nb), g = cues.map(function (c) { return c.bar; });
      if (g.length >= 3) { bounds = g; W.from = "guide"; W.cues = cues; }
    }
    if (!bounds) { bounds = D.noveltyBounds(A); W.from = "music"; }
    // the first bar where music plays: before it, the count in
    var first = 0;
    while (first < A.length && Math.max.apply(null, A[first].concat([0])) < 0.15) first++;
    var all = [0].concat(bounds).filter(function (b, i, a) { return b >= 0 && b < nb && a.indexOf(b) === i; });
    if (first > 0 && first < nb && all.indexOf(first) < 0) all.push(first);
    all.sort(function (a, b) { return a - b; });
    // a one bar "part" is a cue said twice in a row: keep the later one
    all = all.filter(function (b, i) { return i === 0 || i + 1 >= all.length || all[i + 1] - b >= 2 || b === first; });
    var named = D.nameParts(A, all, { countIn: first > 0 });
    W.parts = named.map(function (p) { return { bar: p.bar + 1, name: p.name, auto: true }; });
  }
  function renameAuto() {
    if (!W.activity) return;
    var bars = W.parts.map(function (p) { return p.bar - 1; });
    var named = D.nameParts(W.activity, bars, { countIn: true });
    W.parts.forEach(function (p, i) { if (p.auto && named[i]) p.name = named[i].name; });
    numberVerses();
  }
  function numberVerses() {
    // "Verse" parts get their number in order
    if (W.parts.some(function (p) { return p.heard; })) return;     // the guide said the numbers
    var vs = W.parts.filter(function (p) { return /^Verse( \d+)?$/.test(p.name); });
    vs.forEach(function (p, i) { p.name = vs.length > 1 ? "Verse " + (i + 1) : "Verse"; });
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!W) return;
    $("swSteps").querySelectorAll("li").forEach(function (li) { li.classList.toggle("on", +li.dataset.s === W.step); li.classList.toggle("done", +li.dataset.s < W.step); });
    var b = $("swBody");
    if (W.error) b.innerHTML = '<div class="sw-empty"><p>' + esc(W.error) + "</p></div>";
    else if (W.step === 1) b.innerHTML = songStep();
    else b.innerHTML = partsStep();
    $("swBack").hidden = W.step === 1;
    $("swNext").textContent = T(W.step === 1 ? "swNext" : "swAdd");
    $("swNext").disabled = !!W.error || W.busy || !(W.bpm >= 20 && W.bpm <= 300) || (W.step === 2 && !W.parts.length);
    renderStatus();
    if (W.step === 2) { setupCanvas(); draw(); }
    else drawThumbs();
  }
  function renderStatus() {
    var el = $("swStatus");
    if (!el || !W) return;
    if (W.busy) {
      el.innerHTML = '<span class="sw-spin"></span><span>' + esc(W.status || T("swFinding")) + '</span><i class="sw-prog"><b style="width:' + Math.round((W.progress || 0) * 100) + '%"></b></i>';
      el.className = "sw-status busy";
    } else {
      var h = W.heard || {}, bits = [];
      if (W.step === 2) bits.push(T("swUsing", { bpm: fmtBpm(W.bpm), meter: W.meter, at: fmtTime(W.down), key: W.key || "?" }));
      else {
        if (h.from === "click") bits.push(T(h.accented ? "swHeardClick" : "swHeardClickNoAccent", { bpm: fmtBpm(h.bpm), meter: h.meter, at: fmtTime(h.down) }));
        else if (h.from === "music") bits.push(T("swHeardMusic", { at: fmtTime(h.down) }));
        if (h.key) bits.push(T("swHeardKey", { key: h.key }));
        if (h.from === "click" && h.steady === false) bits.push(T("swTempoMoves"));
      }
      el.innerHTML = (bits.length ? '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg><span>' + esc(bits.join(" ")) + "</span>" : "") +
        (W.hearing ? '<span class="sw-spin"></span><span>' + esc(T("swHearing")) + "</span>" : "");
      el.className = "sw-status";
    }
  }
  function fmtBpm(v) { return app.fmtBpm(v); }
  function roleOpts(cur) {
    return ROLES.map(function (r) { return '<option value="' + r + '"' + (r === cur ? " selected" : "") + ">" + esc(T("k_" + r)) + "</option>"; }).join("");
  }
  function songStep() {
    var h = W.heard || {};
    // key, tempo and time signature wait until every track has been heard (what is heard fills them)
    var dis = W.busy ? " disabled" : "";
    var meterBtn = function (m) { return '<button type="button" role="radio" data-meter="' + m + '" aria-checked="' + (!W.busy && W.meter === m) + '"' + dis + ">" + m + "</button>"; };
    var html = '<div class="sw-song">' +
      '<div class="sw-fields">' +
      '<label class="field sw-name"><span>' + esc(T("addTitleField")) + '</span><input id="swTitleIn" type="text" maxlength="80" value="' + esc(W.title) + '"></label>' +
      '<div class="field-row">' +
      '<label class="field"><span>' + esc(T("addKey")) + (h.key && h.key !== W.key ? ' <em class="sw-heard" data-use="key">' + esc(T("swUse", { v: h.key })) + "</em>" : "") + '</span><input id="swKeyIn" type="text" maxlength="3" value="' + (W.busy ? "" : esc(W.key)) + '" placeholder="' + (W.busy ? "…" : "G") + '"' + dis + "></label>" +
      '<label class="field"><span>BPM' + (h.bpm && h.bpm !== W.bpm ? ' <em class="sw-heard" data-use="bpm">' + esc(T("swUse", { v: fmtBpm(h.bpm) })) + "</em>" : "") + '</span><span class="sw-bpm"><input id="swBpmIn" type="number" min="20" max="300" step="0.01" value="' + (W.busy ? "" : W.bpm || "") + '"' + (W.busy ? ' placeholder="…"' : "") + dis + '><button type="button" class="chip-btn" id="swTap"' + dis + ">" + esc(T("swTap")) + "</button></span></label>" +
      "</div>" +
      '<div class="field"><span>' + esc(T("swMeter")) + '</span><div class="seg-ctl sw-meter">' + ["4/4", "3/4", "6/8"].map(meterBtn).join("") + "</div></div>" +
      "</div>" +
      '<div class="sw-tracks"><div class="sw-th"><span>' + esc(T("swTracks", { n: W.tracks.filter(function (t) { return t.include; }).length })) + "</span></div><ul>" +
      W.tracks.map(function (t, i) {
        return '<li class="sw-tr' + (t.include ? "" : " off") + (t.bad ? " bad" : "") + '" data-i="' + i + '">' +
          '<label class="sw-chk"><input type="checkbox" data-act="inc"' + (t.include ? " checked" : "") + "><i></i></label>" +
          '<input class="sw-trname" type="text" data-act="name" value="' + esc(t.name) + '" maxlength="60">' +
          '<select class="sel" data-act="role">' + roleOpts(t.role) + "</select>" +
          '<canvas class="sw-thumb" data-i="' + i + '"></canvas></li>';
      }).join("") + "</ul></div></div>";
    return html;
  }
  function drawThumbs() {
    if (!W) return;
    $("swBody").querySelectorAll(".sw-thumb").forEach(function (c) {
      var t = W.tracks[+c.dataset.i];
      var dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      c.width = w * dpr; c.height = h * dpr;
      var g = c.getContext("2d");
      g.scale(dpr, dpr);
      if (!t.env) { g.fillStyle = "rgba(255,255,255,.06)"; g.fillRect(0, h / 2 - 1, w, 2); return; }
      var mx = 0;
      for (var i = 0; i < t.env.length; i++) if (t.env[i] > mx) mx = t.env[i];
      g.fillStyle = app.roleColor(t.role);
      var per = t.env.length / w;
      for (var x = 0; x < w; x++) {
        var a = Math.floor(x * per), z = Math.floor((x + 1) * per), m = 0;
        for (var k = a; k < z; k++) if (t.env[k] > m) m = t.env[k];
        var v = mx ? Math.sqrt(m / mx) : 0, hh = Math.max(1, v * (h - 2));
        g.fillRect(x, (h - hh) / 2, 1, hh);
      }
    });
  }

  // ---------------------------------------------------------------- the parts step
  function partsStep() {
    var hint = W.heardCount ? T("swPartsHeard", { n: W.heardCount }) : W.from === "guide" ? T("swPartsFromGuide", { n: W.parts.length }) : T("swPartsFromMusic", { n: W.parts.length });
    if (W.parts.some(function (p) { return p.name === "Part"; })) hint += " " + T("swPartsUnnamed");
    var hasClick = W.bufs && W.bufs.click, hasGuide = W.bufs && W.bufs.guide;
    return '<div class="sw-parts">' +
      '<div class="sw-tool">' +
      '<button type="button" class="sw-play" id="swPlay" aria-label="Play"><svg viewBox="0 0 24 24"><path id="swPlayIc" d="M8 5v14l11-7z"/></svg></button>' +
      '<div class="sw-time"><b id="swBar">' + esc(T("swBarN", { n: 1 })) + '</b><small id="swClock">0:00.0</small></div>' +
      '<button type="button" class="sw-add" id="swAddPart"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>' + esc(T("swAddPart")) + "</span><kbd>M</kbd></button>" +
      '<div class="sw-tog">' +
      (hasClick ? '<button type="button" class="chip-btn' + (W.hearClick !== false ? " on" : "") + '" data-tog="click">' + esc(T("swHearClick")) + "</button>" : '<button type="button" class="chip-btn' + (W.hearMetro !== false ? " on" : "") + '" data-tog="metro">' + esc(T("swHearMetro")) + "</button>") +
      (hasGuide ? '<button type="button" class="chip-btn' + (W.hearGuide !== false ? " on" : "") + '" data-tog="guide">' + esc(T("swHearGuide")) + "</button>" : "") +
      "</div>" +
      '<div class="sw-zoom"><button type="button" data-zoom="-1" aria-label="Zoom out">−</button>' +
      '<input type="range" id="swZoom" min="0" max="1000" value="' + zoomSlider() + '" aria-label="Zoom">' +
      '<button type="button" data-zoom="1" aria-label="Zoom in">+</button><button type="button" class="sw-fit" data-zoom="fit">' + esc(T("swFit")) + "</button></div>" +
      "</div>" +
      '<p class="sw-hint">' + esc(hint) + "</p>" +
      '<div class="sw-tlwrap" id="swTlWrap"' + (W.tlH ? ' style="flex:none;height:' + W.tlH + 'px"' : "") + '><div class="sw-tl" id="swTl"><div class="sw-space" id="swSpace"><canvas id="swCanvas"></canvas></div></div></div>' +
      '<div class="sw-grip" id="swGrip" title="' + esc(T("swResize")) + '"><i></i></div>' +
      '<div class="sw-grid">' +
      '<span>' + esc(T("swGrid", { bpm: fmtBpm(W.bpm), meter: W.meter })) + "</span>" +
      '<span class="sw-nudge"><small>' + esc(T("swBeatOne")) + '</small><button type="button" data-nudge="-beat">' + esc(T("swBeatEarlier")) + '</button><button type="button" data-nudge="-ms">−10 ms</button><button type="button" data-nudge="ms">+10 ms</button><button type="button" data-nudge="beat">' + esc(T("swBeatLater")) + "</button></span>" +
      "</div>" +
      '<ol class="sw-plist" id="swPlist">' + partList() + "</ol>" +
      '<div class="sw-pop" id="swPop" hidden></div>' +
      "</div>";
  }
  function partList() {
    return W.parts.map(function (p, i) {
      return '<li class="sw-pchip' + (i === W.sel ? " picked" : "") + (p.name === "Part" ? " unnamed" : "") + '" data-p="' + i + '" style="--c:' + app.secColor(p.name) + '"><b>' + esc(p.name) + "</b><small>" + esc(T("swBarN", { n: p.bar })) + "</small></li>";
    }).join("");
  }

  // the timeline: drawn for what is on screen (so it can zoom in very close),
  // as tall as the room it has
  var RULER = 22, LANE = 40, GAP = 2;
  var cv = null;
  function fitZoom() { var tl = $("swTl"); return Math.max(1, (tl ? tl.clientWidth - 2 : 900)) / Math.max(1, W.dur); }
  var ZMAX = 400;
  function zoomSlider() { var f = fitZoom(); return Math.round(1000 * Math.log((W.zoom || f) / f) / Math.log(ZMAX / f)); }
  function setupCanvas() {
    var tl = $("swTl"), c = $("swCanvas"), sp = $("swSpace");
    if (!tl || !c) return;
    var rows = W.tracks.filter(function (t) { return t.include && t.env; });
    var fit = fitZoom();
    if (!W.zoom) W.zoom = fit;
    W.zoom = Math.max(fit, Math.min(ZMAX, W.zoom));
    var vw = tl.clientWidth, vh = Math.max(180, tl.clientHeight);
    // the rows share the height: the song's waveform and one row per track
    var wave = Math.max(44, Math.min(160, Math.round(vh * 0.24)));
    var row = Math.max(7, Math.min(34, Math.floor((vh - RULER - LANE - 12 - wave - 8) / Math.max(1, rows.length)) - GAP));
    var total = Math.max(vw, Math.ceil(W.dur * W.zoom));
    sp.style.width = total + "px";
    var dpr = window.devicePixelRatio || 1;
    c.style.width = vw + "px"; c.style.height = vh + "px";
    c.width = Math.round(vw * dpr); c.height = Math.round(vh * dpr);
    cv = { c: c, g: c.getContext("2d"), w: vw, h: vh, dpr: dpr, rows: rows, wave: wave, row: row };
    if (!W.mixEnv) W.mixEnv = mixEnvelope();
    var z = $("swZoom");
    if (z) z.value = zoomSlider();
  }
  function mixEnvelope() {
    var env = null, mx = 0;
    W.tracks.forEach(function (t) {
      if (!t.env || !t.include || t.role === "click") return;
      if (!env) env = new Float32Array(t.env.length);
      for (var i = 0; i < Math.min(env.length, t.env.length); i++) env[i] += t.env[i];
    });
    if (!env) return new Float32Array(1);
    for (var i = 0; i < env.length; i++) if (env[i] > mx) mx = env[i];
    for (i = 0; i < env.length; i++) env[i] = mx ? Math.sqrt(env[i] / mx) : 0;
    W.tracks.forEach(function (t) { if (t.env && t.envMax == null) { var m = 0; for (var k = 0; k < t.env.length; k++) if (t.env[k] > m) m = t.env[k]; t.envMax = m; } });
    return env;
  }
  function off() { var tl = $("swTl"); return tl ? tl.scrollLeft : 0; }
  function X(t) { return t * W.zoom - off(); }
  function tAtClient(clientX) { var tl = $("swTl"), r = tl.getBoundingClientRect(); return (clientX - r.left + tl.scrollLeft) / W.zoom; }
  // the loudest point of an envelope between two times
  function peakIn(env, t0, t1) {
    var a = Math.max(0, Math.floor(t0 * FPS)), z = Math.min(env.length, Math.max(a + 1, Math.ceil(t1 * FPS))), m = 0;
    for (var k = a; k < z; k++) if (env[k] > m) m = env[k];
    return m;
  }
  function draw() {
    if (!cv || !W) return;
    var g = cv.g, w = cv.w, h = cv.h, bs = barSec(), nb = nBars(), o = off(), tps = 1 / W.zoom;
    g.setTransform(cv.dpr, 0, 0, cv.dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    var css = getComputedStyle(document.documentElement);
    var faint = css.getPropertyValue("--faint").trim() || "#667", edge = css.getPropertyValue("--edge").trim() || "#334", text = css.getPropertyValue("--text").trim() || "#fff", live = css.getPropertyValue("--live").trim() || "#4ade80";
    var t0 = o / W.zoom, t1 = (o + w) / W.zoom;
    // bars, and beats when there is room
    var pxBar = bs * W.zoom, every = pxBar >= 28 ? 1 : pxBar >= 14 ? 2 : pxBar >= 7 ? 4 : 8, beats = +W.meter.split("/")[0];
    g.font = "600 10.5px system-ui, sans-serif";
    g.textBaseline = "middle";
    var b0 = Math.max(1, Math.floor((t0 - W.down) / bs)), b1 = Math.min(nb + 1, Math.ceil((t1 - W.down) / bs) + 1);
    for (var b = b0; b <= b1; b++) {
      var x = Math.round(X(timeOfBar(b))) + 0.5, major = (b - 1) % every === 0;
      g.fillStyle = major ? edge : "rgba(128,128,128,.12)";
      g.fillRect(x, RULER, 1, h - RULER);
      if (major) { g.fillStyle = faint; g.fillText(String(b), x + 3, RULER / 2); }
      if (pxBar >= 80) {
        g.fillStyle = "rgba(128,128,128,.10)";
        for (var q = 1; q < beats; q++) g.fillRect(Math.round(X(timeOfBar(b) + q * bs / beats)), RULER, 1, h - RULER);
      }
    }
    if (W.down > 0.05) { g.fillStyle = "rgba(128,128,128,.10)"; g.fillRect(0, RULER, Math.max(0, X(W.down)), h - RULER); }
    // parts
    W.parts.forEach(function (p, i) {
      var a = X(timeOfBar(p.bar)), z = i + 1 < W.parts.length ? X(timeOfBar(W.parts[i + 1].bar)) : X(Math.max(W.dur, timeOfBar(nb + 1)));
      if (z < 0 || a > w) return;
      var col = app.secColor(p.name);
      g.fillStyle = col + (i === W.sel ? "66" : "33");
      roundRect(g, a + 1, RULER + 2, Math.max(2, z - a - 2), LANE - 4, 7); g.fill();
      if (p.name === "Part") { g.setLineDash([4, 3]); g.strokeStyle = faint; g.lineWidth = 1; roundRect(g, a + 1.5, RULER + 2.5, Math.max(2, z - a - 3), LANE - 5, 7); g.stroke(); g.setLineDash([]); }
      g.fillStyle = col;
      g.fillRect(a, RULER + 2, 3, LANE - 4);
      g.save();
      var la = Math.max(a, 0);
      g.beginPath(); g.rect(la + 6, RULER, Math.max(0, z - la - 10), LANE); g.clip();
      g.fillStyle = text; g.font = "700 12.5px system-ui, sans-serif";
      g.fillText(p.name, la + 9, RULER + LANE / 2);
      g.restore();
    });
    // the song (all but the click)
    var wy = RULER + LANE + 6, mid = wy + cv.wave / 2;
    g.fillStyle = "rgba(170,180,200,.55)";
    for (x = 0; x < w; x++) {
      var tt = (o + x) / W.zoom;
      if (tt > W.dur) break;
      var hh = Math.max(1, peakIn(W.mixEnv, tt, tt + tps) * (cv.wave - 4));
      g.fillRect(x, mid - hh / 2, 1, hh);
    }
    // each track: how loud it is
    var ry = wy + cv.wave + 6, step = Math.max(1, Math.round(2 * tps * FPS) ? 2 : 1);
    cv.rows.forEach(function (t) {
      var col = app.roleColor(t.role), mx = t.envMax || 1;
      g.fillStyle = col;
      for (var px = 0; px < w; px += 2) {
        var ta = (o + px) / W.zoom;
        if (ta > W.dur) break;
        var v = Math.sqrt(peakIn(t.env, ta, ta + 2 * tps) / mx);
        if (v < 0.08) continue;
        g.globalAlpha = Math.min(1, 0.15 + v);
        g.fillRect(px, ry, 2, cv.row);
      }
      g.globalAlpha = 1;
      ry += cv.row + GAP;
    });
    // part lines across everything
    W.parts.forEach(function (p) {
      var a = Math.round(X(timeOfBar(p.bar))) + 0.5;
      if (a < -2 || a > w + 2) return;
      g.fillStyle = app.secColor(p.name);
      g.globalAlpha = 0.7;
      g.fillRect(a, RULER + LANE, 1, h - RULER - LANE);
      g.globalAlpha = 1;
    });
    // playhead
    var px2 = Math.round(X(W.t)) + 0.5;
    if (px2 >= -6 && px2 <= w + 6) {
      g.fillStyle = live;
      g.fillRect(px2 - 0.5, 0, 2, h);
      g.beginPath(); g.moveTo(px2 - 5, 0); g.lineTo(px2 + 6, 0); g.lineTo(px2 + 0.5, 7); g.fill();
    }
    var bn = $("swBar"), ck = $("swClock");
    if (bn) bn.textContent = W.t < W.down ? T("swCountIn") : T("swBarN", { n: barAt(W.t) });
    if (ck) ck.textContent = fmtTime(W.t);
  }
  // zoom keeping the time under x (on screen) in place
  function zoomTo(z, atClientX) {
    var tl = $("swTl");
    if (!tl) return;
    var r = tl.getBoundingClientRect(), px = atClientX == null ? (X(W.t) >= 0 && X(W.t) <= tl.clientWidth ? X(W.t) : tl.clientWidth / 2) : atClientX - r.left;
    var t = (tl.scrollLeft + px) / W.zoom;
    W.zoom = Math.max(fitZoom(), Math.min(ZMAX, z));
    setupCanvas();
    tl.scrollLeft = Math.max(0, t * W.zoom - px);
    draw();
  }
  function zoomToPart(i) {
    var tl = $("swTl"), p = W.parts[i];
    if (!tl || !p) return;
    var a = timeOfBar(p.bar), z = i + 1 < W.parts.length ? timeOfBar(W.parts[i + 1].bar) : W.dur;
    W.zoom = Math.max(fitZoom(), Math.min(ZMAX, (tl.clientWidth * 0.8) / Math.max(0.5, z - a)));
    setupCanvas();
    tl.scrollLeft = Math.max(0, a * W.zoom - tl.clientWidth * 0.1);
    draw();
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  }

  // ---------------------------------------------------------------- playing
  var P = { ctx: null, nodes: [], t0: 0, at: 0, raf: 0, metroT: 0 };
  function playing() { return !!P.nodes.length; }
  function bufFrom(ch) {
    var n = ch[0].length, b = P.ctx.createBuffer(ch.length, n, SR);
    for (var c = 0; c < ch.length; c++) b.copyToChannel(ch[c], c);
    return b;
  }
  function startPlay(at) {
    if (!W || !W.bufs) return;
    stopPlay(true);
    if (!P.ctx) P.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (P.ctx.state === "suspended") P.ctx.resume();
    var ctx = P.ctx;
    if (!W.ab) {
      W.ab = {};
      if (W.bufs.mix) W.ab.mix = bufFrom(W.bufs.mix);
      if (W.bufs.click) W.ab.click = bufFrom([W.bufs.click]);
      if (W.bufs.guide) W.ab.guide = W.bufs.guide;
    }
    var when = ctx.currentTime + 0.05;
    [["mix", 1], ["click", W.hearClick !== false ? 0.7 : 0], ["guide", W.hearGuide !== false ? 0.9 : 0]].forEach(function (k) {
      if (!W.ab[k[0]]) return;
      var s = ctx.createBufferSource(), gn = ctx.createGain();
      s.buffer = W.ab[k[0]]; gn.gain.value = k[1];
      s.connect(gn).connect(ctx.destination);
      s.start(when, Math.max(0, at));
      P.nodes.push(s);
      P.gains = P.gains || {};
      P.gains[k[0]] = gn;
    });
    P.t0 = when; P.at = at; P.metroT = 0;
    tick();
    playIcon();
  }
  function stopPlay(quiet) {
    P.nodes.forEach(function (s) { try { s.stop(); } catch (e) { } });
    P.nodes = [];
    P.gains = {};
    cancelAnimationFrame(P.raf);
    if (!quiet) playIcon();
  }
  function nowT() { return playing() ? P.at + (P.ctx.currentTime - P.t0) : W.t; }
  function tick() {
    if (!W || !playing()) return;
    W.t = Math.max(0, nowT());
    if (W.t >= W.dur) { stopPlay(); W.t = W.dur; draw(); return; }
    metronome();
    follow();
    draw();
    P.raf = requestAnimationFrame(tick);
  }
  // no click track: a metronome on the grid, so the bars can be checked by ear
  function metronome() {
    if (W.bufs.click || W.hearMetro === false) return;
    var ctx = P.ctx, beat = 60 / W.bpm, ahead = nowT() + 0.25, beats = +W.meter.split("/")[0];
    var from = Math.max(P.metroT || nowT(), nowT());
    var n = Math.ceil((from - W.down) / beat - 1e-6);
    for (var t = W.down + n * beat; t < ahead; t = W.down + (++n) * beat) {
      if (t < 0) continue;
      var o = ctx.createOscillator(), gn = ctx.createGain(), when = P.t0 + (t - P.at);
      if (when < ctx.currentTime) continue;
      o.frequency.value = ((n % beats) + beats) % beats === 0 ? 1600 : 1000;
      gn.gain.setValueAtTime(0.35, when); gn.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
      o.connect(gn).connect(ctx.destination);
      o.start(when); o.stop(when + 0.06);
      P.metroT = t + 0.001;
    }
  }
  function follow() {
    var tl = $("swTl");
    if (!tl) return;
    var x = X(W.t);
    if (x > tl.clientWidth * 0.8 || x < 0) { tl.scrollLeft = Math.max(0, W.t * W.zoom - tl.clientWidth * 0.25); }
  }
  function playIcon() {
    var ic = $("swPlayIc");
    if (ic) ic.setAttribute("d", playing() ? "M7 5h4v14H7zM13 5h4v14h-4z" : "M8 5v14l11-7z");
  }
  function seek(t) {
    W.t = Math.max(0, Math.min(W.dur, t));
    if (playing()) startPlay(W.t); else draw();
  }

  // ---------------------------------------------------------------- editing parts
  function addPartAt(t) {
    W.edited = true;
    // a tap while listening comes a little late: the nearest bar line to just before it
    var b = Math.round((t - W.down) / barSec()) + 1;
    b = Math.max(1, Math.min(nBars(), b));
    var i = indexOfBar(b);
    if (i >= 0) { W.sel = i; refreshParts(); return; }
    W.parts.push({ bar: b, name: "Part", auto: true });
    W.parts.sort(function (x, y) { return x.bar - y.bar; });
    renameAuto();
    W.sel = indexOfBar(b);
    refreshParts();
    flash(W.parts[W.sel].name);
  }
  function indexOfBar(b) { for (var i = 0; i < W.parts.length; i++) if (W.parts[i].bar === b) return i; return -1; }
  function refreshParts() {
    var pl = $("swPlist");
    if (pl) pl.innerHTML = partList();
    $("swNext").disabled = !W.parts.length;
    draw();
    var pop = $("swPop");
    if (pop && !pop.hidden) openName(W.sel);
  }
  function flash(name) {
    var el = $("swAddPart");
    if (!el) return;
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  }
  function openName(i) {
    var pop = $("swPop"), p = W.parts[i];
    if (!pop || !p) return;
    W.sel = i;
    var base = p.name.replace(/\s+\d+$/, "");
    pop.innerHTML = '<div class="pop-head"><b>' + esc(T("swPartAt", { n: p.bar })) + (p.said ? ' <small class="sw-said">' + esc(T("swSaid", { t: p.said })) + "</small>" : "") + '</b><button type="button" class="icon-btn" data-x="close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>' +
      '<div class="sw-names">' + NAMES.map(function (n) { return '<button type="button" data-name="' + esc(n) + '"' + (n === base ? ' class="on"' : "") + ' style="--c:' + app.secColor(n) + '">' + esc(n) + "</button>"; }).join("") + "</div>" +
      '<div class="sw-custom"><input type="text" id="swCustom" maxlength="40" placeholder="' + esc(T("swOtherName")) + '" value="' + esc(NAMES.indexOf(base) < 0 ? p.name : "") + '"></div>' +
      '<div class="pop-acts"><button type="button" class="chip-btn" data-x="del">' + esc(T("swDeletePart")) + "</button>" +
      '<button type="button" class="chip-btn" data-x="go">' + esc(T("swListenHere")) + "</button></div>";
    pop.hidden = false;
    var pl = $("swPlist");
    if (pl) pl.innerHTML = partList();
    draw();
  }
  function setName(i, name) {
    W.edited = true;
    var p = W.parts[i];
    if (!p) return;
    p.name = name; p.auto = false;
    if (/^Verse$/.test(name)) { p.auto = false; numberVerses(); }
    refreshParts();
  }

  // ---------------------------------------------------------------- events
  function bind() {
    $("swClose").addEventListener("click", close);
    // the whole window, or a panel
    var full = false;
    try { full = localStorage.getItem("sp.swFull") === "1"; } catch (e) { }
    $("stemWiz").classList.toggle("full", full);
    $("swFull").addEventListener("click", function () {
      full = !$("stemWiz").classList.contains("full");
      $("stemWiz").classList.toggle("full", full);
      $("swFull").setAttribute("aria-pressed", full);
      try { localStorage.setItem("sp.swFull", full ? "1" : "0"); } catch (e) { }
      if (W && W.step === 2) requestAnimationFrame(function () { setupCanvas(); draw(); });
    });
    $("stemWiz").addEventListener("click", function (e) { if (e.target === $("stemWiz")) close(); });
    $("swBack").addEventListener("click", function () { stopPlay(); W.step = 1; render(); });
    $("swNext").addEventListener("click", function () {
      if (!W) return;
      if (W.step === 1) {
        readSong();
        if (!(W.bpm >= 20 && W.bpm <= 300)) return;
        if (!W.parts.length || W.gridChanged) { suggestParts(); W.gridChanged = false; W.edited = false; W.heardCount = 0; hearGuide(); }
        W.mixEnv = null;
        W.step = 2; W.zoom = 0; W.t = 0; W.sel = -1;
        render();
        return;
      }
      create();
    });
    var body = $("swBody");
    body.addEventListener("input", function (e) {
      if (!W) return;
      var li = e.target.closest(".sw-tr");
      if (li && e.target.dataset.act === "name") W.tracks[+li.dataset.i].name = e.target.value;
      if (e.target.id === "swBpmIn") { var v = +e.target.value; if (v !== W.bpm) { W.bpm = v; W.gridChanged = true; } $("swNext").disabled = !(v >= 20 && v <= 300); }
    });
    body.addEventListener("change", function (e) {
      if (!W) return;
      var li = e.target.closest(".sw-tr");
      if (!li) return;
      var t = W.tracks[+li.dataset.i];
      if (e.target.dataset.act === "inc") { t.include = e.target.checked; li.classList.toggle("off", !t.include); W.mixEnv = null; W.ab = null; W.gridChanged = true; }
      if (e.target.dataset.act === "role") { t.role = e.target.value; W.gridChanged = true; }
    });
    body.addEventListener("click", function (e) {
      if (!W) return;
      var b = e.target.closest("button, em");
      if (!b) return;
      if (b.dataset.use) { readSong(); if (b.dataset.use === "key") W.key = W.heard.key; else { W.bpm = W.heard.bpm; W.gridChanged = true; } render(); return; }
      if (b.dataset.meter) { readSong(); W.meter = b.dataset.meter; W.gridChanged = true; render(); return; }
      if (b.id === "swTap") { tap(); return; }
      if (b.id === "swPlay") { if (playing()) { W.t = nowT(); stopPlay(); draw(); } else startPlay(W.t >= W.dur - 0.1 ? 0 : W.t); return; }
      if (b.id === "swAddPart") { addPartAt(Math.max(0, nowT() - (playing() ? 0.12 : 0))); return; }
      if (b.dataset.tog) {
        var k = b.dataset.tog, key = k === "click" ? "hearClick" : k === "guide" ? "hearGuide" : "hearMetro";
        W[key] = W[key] === false;
        b.classList.toggle("on", W[key] !== false);
        if (P.gains && P.gains[k]) P.gains[k].gain.value = W[key] !== false ? (k === "click" ? 0.7 : 0.9) : 0;
        return;
      }
      if (b.dataset.zoom) { if (b.dataset.zoom === "fit") zoomTo(0); else zoomTo(W.zoom * (b.dataset.zoom === "1" ? 1.6 : 1 / 1.6)); return; }
      if (b.dataset.nudge) {
        var bs = 60 / W.bpm, d = { "-beat": -bs, beat: bs, "-ms": -0.01, ms: 0.01 }[b.dataset.nudge];
        W.down = Math.max(0, W.down + d);
        if (W.down >= barSec()) W.down -= barSec();
        draw();
        renderStatus();
        return;
      }
      var pop = e.target.closest("#swPop");
      if (pop) {
        if (b.dataset.name) { var nm = b.dataset.name; setName(W.sel, nm); openName(W.sel); return; }
        if (b.dataset.x === "close") { pop.hidden = true; return; }
        if (b.dataset.x === "del") { W.parts.splice(W.sel, 1); W.sel = -1; W.edited = true; pop.hidden = true; renameAuto(); refreshParts(); return; }
        if (b.dataset.x === "go") { seek(timeOfBar(W.parts[W.sel].bar) - 0.05); if (!playing()) startPlay(W.t); return; }
      }
    });
    body.addEventListener("keydown", function (e) {
      if (e.target.id === "swCustom" && e.key === "Enter") { var v = e.target.value.trim(); if (v) { setName(W.sel, v.replace(/[#|]/g, " ")); openName(W.sel); } }
    });
    body.addEventListener("click", function (e) {
      var li = e.target.closest(".sw-pchip");
      if (li) { var i = +li.dataset.p; seek(timeOfBar(W.parts[i].bar)); openName(i); }
    });
    // the timeline: tap to listen from there, tap a part to name it, drag its start
    var drag = null;
    body.addEventListener("pointerdown", function (e) {
      if (!W || e.target.id !== "swCanvas") return;
      var r = e.target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      // near the start of a part (not the first): move it
      for (var i = 1; i < W.parts.length; i++) {
        if (Math.abs(X(timeOfBar(W.parts[i].bar)) - x) < 8) { drag = { i: i, moved: false }; e.target.setPointerCapture(e.pointerId); return; }
      }
      if (y >= RULER && y < RULER + LANE) {
        var t = (x + off()) / W.zoom, k = -1;
        for (var j = 0; j < W.parts.length; j++) if (timeOfBar(W.parts[j].bar) <= t + 1e-6) k = j;
        if (k >= 0) { openName(k); return; }
      }
      seek((x + off()) / W.zoom);
    });
    // zoom: Ctrl/Cmd + wheel or a pinch on the trackpad, the slider, + and -; double click a part to fit it
    body.addEventListener("wheel", function (e) {
      if (!W || W.step !== 2 || !e.target.closest("#swTl")) return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomTo(W.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX); }
      else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) { e.preventDefault(); $("swTl").scrollLeft += e.deltaY; }
    }, { passive: false });
    body.addEventListener("scroll", function (e) { if (e.target.id === "swTl") draw(); }, true);
    body.addEventListener("dblclick", function (e) {
      if (!W || e.target.id !== "swCanvas") return;
      var t = tAtClient(e.clientX), k = -1;
      for (var j = 0; j < W.parts.length; j++) if (timeOfBar(W.parts[j].bar) <= t + 1e-6) k = j;
      if (k >= 0) zoomToPart(k);
    });
    body.addEventListener("input", function (e) {
      if (!W || e.target.id !== "swZoom") return;
      var f = fitZoom();
      zoomTo(f * Math.pow(ZMAX / f, +e.target.value / 1000));
    });
    // the timeline's height: drag the grip under it
    var grip = null;
    body.addEventListener("pointerdown", function (e) {
      if (!W || !e.target.closest("#swGrip")) return;
      var wrap = $("swTlWrap");
      grip = { y: e.clientY, h: wrap.getBoundingClientRect().height };
      e.target.closest("#swGrip").setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    body.addEventListener("pointermove", function (e) {
      if (!grip) return;
      W.tlH = Math.max(180, Math.min(window.innerHeight - 120, Math.round(grip.h + e.clientY - grip.y)));
      var wrap = $("swTlWrap");
      wrap.style.flex = "none"; wrap.style.height = W.tlH + "px";
      setupCanvas(); draw();
    });
    window.addEventListener("pointerup", function () { if (grip) { grip = null; try { localStorage.setItem("sp.swTlH", String(W.tlH)); } catch (e) { } } });
    body.addEventListener("pointermove", function (e) {
      if (!W || W.step !== 2) return;
      var c = $("swCanvas");
      if (!c) return;
      var r = c.getBoundingClientRect(), x = e.clientX - r.left;
      if (drag) {
        var b = Math.round(((x + off()) / W.zoom - W.down) / barSec()) + 1, p = W.parts[drag.i];
        var lo = W.parts[drag.i - 1].bar + 1, hi = drag.i + 1 < W.parts.length ? W.parts[drag.i + 1].bar - 1 : nBars();
        b = Math.max(lo, Math.min(hi, b));
        if (b !== p.bar) { p.bar = b; drag.moved = true; W.edited = true; draw(); }
        return;
      }
      if (e.target.id === "swCanvas") {
        var near = false;
        for (var i = 1; i < W.parts.length; i++) if (Math.abs(X(timeOfBar(W.parts[i].bar)) - x) < 8) near = true;
        c.style.cursor = near ? "ew-resize" : "pointer";
      }
    });
    window.addEventListener("pointerup", function () {
      if (drag && W) { if (drag.moved) { renameAuto(); refreshParts(); } drag = null; }
    });
    document.addEventListener("keydown", function (e) {
      if (!W || $("stemWiz").hidden) return;
      if (e.key === "Escape") { var pop = $("swPop"); if (pop && !pop.hidden) pop.hidden = true; else close(); e.preventDefault(); return; }
      if (W.step !== 2 || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === " ") { e.preventDefault(); $("swPlay").click(); }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomTo(W.zoom * 1.6); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomTo(W.zoom / 1.6); }
      else if (e.key === "0") { e.preventDefault(); zoomTo(0); }
      else if (e.key === "m" || e.key === "M") { e.preventDefault(); addPartAt(Math.max(0, nowT() - (playing() ? 0.12 : 0))); }
      else if ((e.key === "Delete" || e.key === "Backspace") && W.sel > 0) { e.preventDefault(); W.parts.splice(W.sel, 1); W.sel = -1; W.edited = true; renameAuto(); refreshParts(); var pp = $("swPop"); if (pp) pp.hidden = true; }
    }, true);
    window.addEventListener("resize", function () { if (W && W.step === 2) { setupCanvas(); draw(); } });
  }
  var taps = [];
  function tap() {
    var now = performance.now();
    taps = taps.filter(function (t) { return now - t < 3000; });
    taps.push(now);
    if (taps.length >= 4) {
      var g = [];
      for (var i = 1; i < taps.length; i++) g.push(taps[i] - taps[i - 1]);
      var bpm = Math.round(60000 / D.median(g) * 2) / 2;
      var inp = $("swBpmIn");
      if (inp) { inp.value = bpm; W.bpm = bpm; W.gridChanged = true; $("swNext").disabled = false; }
    }
  }
  function readSong() {
    var ti = $("swTitleIn"), ki = $("swKeyIn"), bi = $("swBpmIn");
    if (ti) W.title = ti.value.trim();
    if (ki) { var k = ki.value.trim(); W.key = k ? k.charAt(0).toUpperCase() + k.slice(1) : ""; }
    if (bi && +bi.value !== W.bpm) { W.bpm = +bi.value; W.gridChanged = true; }
  }

  function create() {
    stopPlay();
    var body = {
      title: W.title || W.folder || "Untitled", key: /^[A-G](#|b)?m?$/.test(W.key) ? W.key : "", bpm: W.bpm, meter: W.meter, downbeat: W.down,
      sections: W.parts.map(function (p) { return { bar: p.bar, name: p.name }; }),
      tracks: W.tracks.filter(function (t) { return t.include && !t.bad; }).map(function (t) { return { name: t.name, path: t.path, role: t.role, dur: t.dur, size: t.file.size }; })
    };
    $("swNext").disabled = true;
    fetch("/stems/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r.ok) { $("swNext").disabled = false; app.toast(T(r.error === "playing" ? "addStopFirst" : "swCreateFail"), true); return; }
        close();
        app.showProgress(body.title);
      })
      .catch(function () { $("swNext").disabled = false; app.toast(T("swCreateFail"), true); });
  }

  window.SPStems = {
    init: function (helpers) { app = helpers; bind(); },
    open: open,
    // a folder dropped or picked: its audio files
    fromEntry: function (entry) {
      var files = [];
      function walk(en, depth) {
        return new Promise(function (resolve) {
          if (en.isFile) { en.file(function (f) { files.push(f); resolve(); }, function () { resolve(); }); return; }
          if (!en.isDirectory || depth > 1) return resolve();
          var rd = en.createReader(), all = [];
          (function more() {
            rd.readEntries(function (batch) {
              if (batch.length) { all = all.concat(Array.prototype.slice.call(batch)); more(); return; }
              Promise.all(all.filter(function (x) { return !/^\./.test(x.name); }).map(function (x) { return walk(x, depth + 1); })).then(resolve);
            }, function () { resolve(); });
          })();
        });
      }
      return walk(entry, 0).then(function () { return files; });
    }
  };
})();
