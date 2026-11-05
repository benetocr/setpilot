(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var T = window.SPI18N.T;
  var struct = null;
  var pos = null;
  var recvAt = 0;
  var shownIdx = -1;
  var renderedKey = "";
  var connected = false;
  var cue = null;
  var voice = null;

  // ------------------------------------------------------------ helpers

  var FAMILIES = [
    [/^(pre[\s-]?(coro|chorus)|pre)\b/i, "pre"],
    [/^(coro|chorus|estribillo)/i, "chorus"],
    [/^(verso|verse|estrofa)/i, "verse"],
    [/^(puente|bridge)/i, "bridge"],
    [/^(intro|inicio|start|count|conteo)/i, "intro"],
    [/^(inst|interlud|solo|turn|break|riff)/i, "inst"],
    [/^(tag|vamp|refr[aá]n|post)/i, "tag"],
    [/^(final|outro|ending|fin|coda)/i, "outro"]
  ];
  function family(name) {
    for (var i = 0; i < FAMILIES.length; i++) if (FAMILIES[i][0].test(name)) return FAMILIES[i][1];
    return "outro";
  }
  function color(name) { return "var(--sec-" + family(name) + ")"; }

  function barLen() { return pos ? pos.sigNum * 4 / (pos.sigDen || 4) : 4; }
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2);
  }
  function fmtBpm(v) { return (Math.round(v * 10) / 10).toString(); }
  function songs() { return struct ? struct.songs : []; }
  var MED = 100000;
  function medleys() { return (struct && struct.medleys) || []; }
  function isMed(v) { return v >= MED; }
  // a medley's length in beats and its tempo
  function medLen(m) {
    var d = 0;
    m.slots.forEach(function (x) { var sg = songs()[x.s], sec = sg && sg.sections[x.j]; if (sec) d += sec.end - sec.start; });
    return d;
  }
  function medBpm(m) { var f = m.slots[0] && songs()[m.slots[0].s]; return m.bpm || (f ? effBpm(f) : 120); }
  function medSongs(m) {
    var seen = {}, out = [];
    m.slots.forEach(function (x) { if (!seen[x.s] && songs()[x.s]) { seen[x.s] = 1; out.push(songs()[x.s].name); } });
    return out;
  }
  function order() { return struct ? struct.order : []; }
  function setlistPos(i) { return order().indexOf(i); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // tempo and key of a song as it will actually play
  function baseBpm(s) { return (s && (s.bpm || s.baseBpm)) || 0; }
  function arrLen(s) {
    if (!s.arr || !s.arr.length) return s.end - s.start;
    var d = 0;
    s.arr.forEach(function (j) { var sec = s.sections[j]; if (sec) d += sec.end - sec.start; });
    return d;
  }
  function effBpm(s) { return (s && (s.tempoSet || baseBpm(s))) || (pos && pos.tempo) || 120; }
  var KEYS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  var KEYIDX = { C: 0, "B#": 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4, F: 5, "E#": 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11 };
  function parseKey(k) {
    var m = /^([A-G](#|b)?)(m?)$/.exec(k || "");
    return m && KEYIDX[m[1]] != null ? { root: KEYIDX[m[1]], minor: m[3] } : null;
  }
  function keyName(k, semis) {
    var p = parseKey(k);
    if (!p) return null;
    return KEYS[((p.root + (semis || 0)) % 12 + 12) % 12] + p.minor;
  }
  function semisLabel(n) { return n ? (n > 0 ? "+" : "−") + Math.abs(n) : "0"; }

  function send(cmd) {
    var args = Array.prototype.slice.call(arguments, 1);
    return fetch("/cmd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd: cmd, args: args }) })
      .catch(function () {});
  }

  // The engine reports the time about 20 times a second, with network jitter.
  // The dashboard runs its own clock at the display's refresh rate and only
  // eases toward the reports, so the playhead glides instead of stepping.
  var clk = { t: 0, at: 0, tempo: 120, playing: 0 };
  function syncClock(p) {
    var now = performance.now();
    if (!p.playing || !clk.playing || p.tempo !== clk.tempo) { clk = { t: p.t, at: now, tempo: p.tempo, playing: p.playing }; return; }
    var pred = clk.t + (now - clk.at) / 1000 * clk.tempo / 60;
    var err = p.t - pred;
    if (Math.abs(err) > 0.3) { clk.t = p.t; clk.at = now; return; } // a jump, a loop or a seek
    clk.t = pred + err * 0.12;
    clk.at = now;
  }
  function nowT() {
    if (!pos) return 0;
    if (!pos.playing || !clk.playing) return pos.t;
    var now = performance.now();
    if (now - recvAt > 600) now = recvAt + 600; // no news from Live: hold
    return clk.t + (now - clk.at) / 1000 * clk.tempo / 60;
  }

  var shownMed = -1;
  function computeShown() {
    shownMed = pos && pos.med >= 0 && medleys()[pos.med] ? pos.med : -1;
    if (!pos || !struct || !songs().length) return -1;
    if (pos.playing && pos.song >= 0) return pos.song;
    if (pos.armSong >= 0) return pos.armSong;
    if (pos.song >= 0) return pos.song;
    return order()[0];
  }

  function nextSongIdx(cur) {
    if (!pos) return -1;
    if (cur === shownIdx && shownMed >= 0) cur = MED + shownMed;
    if (pos.pendingSong >= 0 && pos.pendingSong !== cur) return pos.pendingSong;
    var p = setlistPos(cur);
    return p >= 0 && p + 1 < order().length ? order()[p + 1] : -1;
  }

  // ------------------------------------------------------------ setlist

  var GRIP = '<svg viewBox="0 0 12 20"><circle cx="3" cy="4" r="1.6"/><circle cx="9" cy="4" r="1.6"/><circle cx="3" cy="10" r="1.6"/><circle cx="9" cy="10" r="1.6"/><circle cx="3" cy="16" r="1.6"/><circle cx="9" cy="16" r="1.6"/></svg>';

  function renderSetlist() {
    var ord = order();
    var total = 0;
    var html = "";
    for (var p = 0; p < ord.length; p++) {
      var i = ord[p];
      if (isMed(i)) {
        var m = medleys()[i - MED];
        if (!m) continue;
        var mdur = medLen(m) / medBpm(m) * 60;
        total += mdur;
        html += '<li class="song is-medley" data-i="' + i + '" tabindex="0">' +
          '<span class="handle" aria-hidden="true">' + GRIP + "</span>" +
          '<span class="s-num">' + (p + 1) + "</span>" +
          '<div class="s-body"><div class="s-title"><svg class="med-ic" viewBox="0 0 24 24"><rect x="3" y="6" width="7" height="12" rx="2"/><rect x="14" y="6" width="7" height="12" rx="2"/><path d="M10 12h4"/></svg><span class="s-name">' + esc(m.name) + "</span></div>" +
          '<div class="s-meta"><span class="m-key">' + esc(m.key || "") + "</span>" +
          '<span class="m-bpm">' + fmtBpm(medBpm(m)) + "<small>BPM</small></span>" +
          '<span class="m-dur">' + fmtTime(mdur) + "</span></div>" +
          '<div class="s-songs">' + esc(medSongs(m).join(" + ")) + "</div></div>" +
          '<button class="med-edit" type="button" data-m="' + (i - MED) + '" aria-label="' + esc(T("medEdit")) + '"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>' +
          '<span class="s-state"></span><i class="s-prog"></i></li>';
        if (p + 1 < ord.length) html += '<li class="trans gap" aria-hidden="true"></li>';
        continue;
      }
      var s = songs()[i];
      var dur = arrLen(s) / effBpm(s) * 60;
      total += dur;
      var k = keyName(s.key, s.semis) || (s.semis ? semisLabel(s.semis) : "");
      var b = s.tempoSet || baseBpm(s);
      html += '<li class="song" data-i="' + i + '" tabindex="0">' +
        '<span class="handle" aria-hidden="true">' + GRIP + "</span>" +
        '<span class="s-num">' + (p + 1) + "</span>" +
        '<div class="s-body"><div class="s-title">' + esc(s.name) + "</div>" +
        '<div class="s-meta"><span class="m-key' + (s.semis ? " mod" : "") + '">' + esc(k) + "</span>" +
        '<span class="m-bpm' + (s.tempoSet ? " mod" : "") + '">' + (b ? fmtBpm(b) + "<small>BPM</small>" : "") + "</span>" +
        '<span class="m-dur">' + fmtTime(dur) + "</span></div></div>" +
        '<span class="s-state"></span><i class="s-prog"></i></li>';
      if (p + 1 < ord.length) html += transChip(i);
    }
    html += '<li class="med-new-li"><button class="med-new" id="btnMedNew" type="button"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="7" height="12" rx="2"/><rect x="14" y="6" width="7" height="12" rx="2"/><path d="M10 12h4"/></svg><span>' + esc(T("medNew")) + "</span></button></li>";
    $("songs").innerHTML = html;
    var m = Math.round(total / 60);
    $("setlistMeta").textContent = ord.length ? (ord.length === 1 ? T("songCount", { m: m }) : T("songsCount", { n: ord.length, m: m })) : "";
  }

  // ------------------------------------------------------------ mixer

  var mixer = null, mixDrag = null, mixPing = null, routes = null;
  var KINDS = ["click", "guide", "drums", "perc", "bass", "eg", "ag", "keys", "synth", "strings", "vox", "loops", "other"];
  function kindLabel(k) { return T("k_" + k); }
  function kindOptions(sel) {
    return KINDS.map(function (k) { return '<option value="' + k + '"' + (k === sel ? " selected" : "") + ">" + esc(kindLabel(k)) + "</option>"; }).join("");
  }
  function renderMixer() {
    if (!mixer || ($("mixSheet").hidden && $("mixStrips").parentNode !== $("dockInner"))) return;
    var tr = mixer.tracks || [];
    var songTracks = tr.filter(function (x) { return !x.kind; }).sort(function (a, b) {
      return (KINDS.indexOf(a.instr) - KINDS.indexOf(b.instr)) || (tr.indexOf(a) - tr.indexOf(b));
    });
    var spTracks = tr.filter(function (x) { return x.kind && x.kind !== "main"; });
    var main = tr.filter(function (x) { return x.kind === "main"; });
    var list = songTracks.concat(spTracks, main);
    var keyNow = list.map(function (x) { return x.id + ":" + (x.instr || ""); }).join(",") + window.SPI18N.lang;
    var box = $("mixStrips");
    if (box.dataset.k !== keyNow) {
      box.dataset.k = keyNow;
      box.innerHTML = list.map(function (x, i) {
        var sep = (x.kind && (i === songTracks.length || x.kind === "main")) ? " sep" : "";
        var groupStart = !x.kind && (i === 0 || list[i - 1].instr !== x.instr);
        if (!x.kind && i > 0 && list[i - 1].instr !== x.instr) sep += " kind-start";
        var tag = x.kind === "main" ? "" : x.kind ? "<small>" + esc(T("mixSetPilot")) + "</small>" : x.group ? "<small>" + esc(T("mixGroup")) + "</small>" : "";
        return '<div class="ch' + sep + (x.kind === "main" ? " main" : "") + '" data-id="' + x.id + '">' +
          (groupStart ? '<em class="ch-kind">' + esc(kindLabel(x.instr)) + "</em>" : (x.kind && x.kind !== "main" && i === songTracks.length ? '<em class="ch-kind">SetPilot</em>' : "")) +
          '<i class="ch-color"></i><div class="ch-name">' + esc(x.name) + tag + "</div>" +
          (x.kind ? "" : '<select class="ch-instr" aria-label="' + esc(T("addInstr")) + '">' + kindOptions(x.instr) + "</select>") +
          '<div class="ch-db"></div>' +
          '<div class="ch-fader"><div class="ch-meter"><i class="m-cover"></i><b class="m-peak"></b></div><div class="ch-track"><i class="ch-fill"></i><b class="ch-thumb"></b></div></div>' +
          (x.kind === "main" ? '<div class="ch-btns"></div>' : '<div class="ch-btns"><button class="ch-m" type="button">M</button><button class="ch-s" type="button">S</button></div>') +
          '<div class="ch-out"></div>' +
          "</div>";
      }).join("");
    }
    var anySolo = tr.some(function (x) { return x.solo; });
    list.forEach(function (x) {
      var el = box.querySelector('.ch[data-id="' + x.id + '"]');
      if (!el) return;
      el.querySelector(".ch-color").style.setProperty("--c", x.color || "var(--faint)");
      el.querySelector(".ch-name").firstChild.textContent = x.name;
      el.classList.toggle("muted", !!x.mute);
      el.classList.toggle("dimmed", anySolo && !x.solo && !x.kind);
      var m = el.querySelector(".ch-m"), so = el.querySelector(".ch-s");
      if (m) m.classList.toggle("on", !!x.mute);
      if (so) so.classList.toggle("on", !!x.solo);
      var outEl = el.querySelector(".ch-out");
      if (outEl) { outEl.textContent = x.out || ""; outEl.title = x.out || ""; }
      var am = autoMode() && !x.kind, ae = am ? autoEntry(x.name) : null;
      el.classList.toggle("auto-set", !!ae);
      el.classList.toggle("auto-off", am && !ae);
      if (am) {
        if (m) m.classList.toggle("on", ae && ae.m != null ? !!ae.m : !!x.mute);
        if (!mixDrag || mixDrag.id !== x.id) setFader(el, ae && ae.v != null ? ae.v : x.vol);
        return;
      }
      if (!mixDrag || mixDrag.id !== x.id) { setFader(el, x.vol); el.querySelector(".ch-db").textContent = shortDb(x.db); }
    });
  }
  function shortDb(d) { return String(d || "").replace(/\s*dB$/i, "").replace("-inf", "−∞"); }
  function setFader(el, v) {
    var pct = Math.max(0, Math.min(1, v)) * 100;
    el.querySelector(".ch-thumb").style.bottom = pct + "%";
    el.querySelector(".ch-fill").style.height = pct + "%";
  }
  function openMixer() {
    $("mixSheet").hidden = false;
    send("mixeron");
    clearInterval(mixPing);
    mixPing = setInterval(function () { if ($("mixSheet").hidden) clearInterval(mixPing); else send("mixeron"); }, 5000);
    renderMixer();
  }
  $("btnMixer").addEventListener("click", function () {
    if (isConsole()) $("dockToggle").click();
    else openMixer();
  });
  $("mixClose").addEventListener("click", function () { $("mixSheet").hidden = true; });
  $("mixSheet").addEventListener("click", function (e) { if (e.target === $("mixSheet")) $("mixSheet").hidden = true; });
  $("mixStrips").addEventListener("dblclick", function (e) {
    var nm = e.target.closest(".ch-name");
    if (nm && autoMode()) send("autoclear", shownIdx, sm.sel, +nm.closest(".ch").dataset.id);
  });
  $("mixStrips").addEventListener("change", function (e) {
    var sel = e.target.closest(".ch-instr");
    if (!sel) return;
    var id = +sel.closest(".ch").dataset.id;
    send("settrackinstr", id, KINDS.indexOf(sel.value));
  });
  $("mixStrips").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b || !mixer) return;
    var id = +b.closest(".ch").dataset.id;
    var x = mixer.tracks.filter(function (t) { return t.id === id; })[0];
    if (!x) return;
    if (autoMode() && !x.kind) {
      if (b.classList.contains("ch-m")) {
        var ae = autoEntry(x.name), cur = ae && ae.m != null ? ae.m : x.mute;
        send("autoset", shownIdx, sm.sel, id, -1, cur ? 0 : 1);
      }
      return;
    }
    if (b.classList.contains("ch-m")) { x.mute = x.mute ? 0 : 1; send("mixmute", id, x.mute); }
    else if (b.classList.contains("ch-s")) { x.solo = x.solo ? 0 : 1; send("mixsolo", id, x.solo); }
    renderMixer();
  });
  (function () {
    var lastSend = 0, pendingV = null, timer = null;
    function valueAt(track, y) {
      var r = track.getBoundingClientRect();
      return Math.max(0, Math.min(1, (r.bottom - y) / r.height));
    }
    function push(force) {
      if (!mixDrag || pendingV == null) return;
      var now = Date.now();
      if (!force && now - lastSend < 50) { clearTimeout(timer); timer = setTimeout(function () { push(true); }, 50); return; }
      lastSend = now;
      if (autoMode()) send("autoset", shownIdx, sm.sel, mixDrag.id, Math.round(pendingV * 1000), -1);
      else send("mixvol", mixDrag.id, Math.round(pendingV * 1000));
      pendingV = null;
    }
    $("mixStrips").addEventListener("pointerdown", function (e) {
      var track = e.target.closest(".ch-track");
      if (!track) return;
      e.preventDefault();
      var el = track.closest(".ch");
      mixDrag = { id: +el.dataset.id, el: el, track: track };
      track.setPointerCapture(e.pointerId);
      var v = valueAt(track, e.clientY);
      setFader(el, v);
      pendingV = v;
      push();
    });
    $("mixStrips").addEventListener("pointermove", function (e) {
      if (!mixDrag || mixDrag.ended) return;
      var v = valueAt(mixDrag.track, e.clientY);
      setFader(mixDrag.el, v);
      pendingV = v;
      push();
    });
    function end() {
      if (!mixDrag) return;
      push(true);
      var id = mixDrag.id;
      setTimeout(function () { if (mixDrag && mixDrag.id === id) mixDrag = null; renderMixer(); }, 400);
      mixDrag = { id: id, el: mixDrag.el, track: mixDrag.track, ended: true };
    }
    $("mixStrips").addEventListener("pointerup", end);
    $("mixStrips").addEventListener("pointercancel", end);
    $("mixStrips").addEventListener("dblclick", function (e) {
      var track = e.target.closest(".ch-track");
      if (!track) return;
      var el = track.closest(".ch");
      setFader(el, 0.85);
      if (autoMode()) send("autoset", shownIdx, sm.sel, +el.dataset.id, 850, -1);
      else send("mixvol", +el.dataset.id, 850);
    });
  })();
  // Meters: Live is read about 20 times a second; between readings the bars
  // move like a hardware meter (instant rise, smooth fall, a peak that holds),
  // drawn every frame with transforms only so nothing has to be laid out again.
  var meters = { els: {}, key: "", tgt: {}, cur: {}, peak: {}, peakAt: {}, last: 0 };
  function meterEls() {
    var box = $("mixStrips");
    if (meters.key === box.dataset.k) return meters.els;
    meters.key = box.dataset.k;
    meters.els = {};
    var chs = box.querySelectorAll(".ch");
    for (var i = 0; i < chs.length; i++) {
      var m = chs[i].querySelector(".ch-meter");
      if (m) meters.els[chs[i].dataset.id] = { cover: m.querySelector(".m-cover"), peak: m.querySelector(".m-peak"), v: -1, p: -1 };
    }
    return meters.els;
  }
  function onMeters(a) {
    for (var i = 0; i + 1 < a.length; i += 2) meters.tgt[a[i]] = Math.max(0, Math.min(1, +a[i + 1] || 0));
    meters.at = performance.now();
  }
  function drawMeters(now) {
    var dt = Math.min(0.1, (now - (meters.last || now)) / 1000);
    meters.last = now;
    if ($("mixSheet").hidden && $("mixStrips").parentNode !== $("dockInner")) return;
    var els = meterEls(), stale = now - (meters.at || 0) > 500;
    var fall = 1 - Math.exp(-dt / 0.16);
    for (var id in els) {
      var el = els[id];
      var tgt = stale ? 0 : (meters.tgt[id] || 0);
      var cur = meters.cur[id] || 0;
      cur = tgt > cur ? cur + (tgt - cur) * (1 - Math.exp(-dt / 0.012)) : cur + (tgt - cur) * fall;
      if (cur < 0.002) cur = 0;
      meters.cur[id] = cur;
      var pk = meters.peak[id] || 0;
      if (cur >= pk) { pk = cur; meters.peakAt[id] = now; }
      else if (now - (meters.peakAt[id] || 0) > 900) pk = Math.max(cur, pk - dt * 0.6);
      meters.peak[id] = pk;
      var v = Math.round(cur * 400) / 400, p = Math.round(pk * 400) / 400;
      if (v !== el.v) { el.v = v; el.cover.style.transform = "scaleY(" + (1 - v) + ")"; }
      if (p !== el.p) { el.p = p; el.peak.style.transform = "translateY(" + (-p * 100) + "%)"; el.peak.style.opacity = p > 0.02 ? 1 : 0; }
    }
  }

  // ------------------------------------------------------------ transitions

  var TR_ICON = {
    1: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    2: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
    3: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    4: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="11" height="10" rx="2"/><rect x="10" y="7" width="11" height="10" rx="2"/></svg>',
    5: '<svg viewBox="0 0 24 24"><path d="M3 6c7 0 11 12 18 12"/><path d="M3 18c7 0 11-12 18-12"/></svg>'
  };
  var TR_KEY = { 1: "trCue", 2: "trStay", 3: "trLink", 4: "trOverlap", 5: "trXfade" };
  function trEff(s) { return (s && s.trEff) || (struct && struct.trDefault) || 1; }
  function tailMissing(m) { return (m === 4 || m === 5) && !(struct && struct.companions && struct.companions.tail); }
  function transChip(i) {
    var s = songs()[i], m = trEff(s);
    return '<li class="trans" data-i="' + i + '"><button class="tr-chip m' + m + (s.tr ? " set" : "") + '" type="button" title="' + esc(T(TR_KEY[m]) + ". " + T(TR_KEY[m] + "Sub")) + '">' +
      TR_ICON[m] + "<span>" + esc(T(TR_KEY[m])) + "</span>" + (tailMissing(m) ? ' <span class="warn">!</span>' : "") + "</button></li>";
  }
  function trOption(m, checked, extra) {
    var def = (struct && struct.trDefault) || 1;
    var label = m ? T(TR_KEY[m]) : T("trUseDefault");
    var sub = m ? T(TR_KEY[m] + "Sub") : T(TR_KEY[def]);
    return '<button class="tr-opt" type="button" role="radio" data-m="' + m + '" aria-checked="' + (checked ? "true" : "false") + '">' +
      TR_ICON[m || def] + "<span>" + esc(label) + "<small>" + esc(sub) + "</small></span>" + (extra || "") + "</button>";
  }
  function openTrans(i) {
    var s = songs()[i];
    if (!s) return;
    $("trSheet").dataset.i = i;
    $("trTitle").textContent = T("trAfter", { name: s.name });
    renderTrans();
    $("trSheet").hidden = false;
  }
  function renderTrans() {
    var i = +$("trSheet").dataset.i, s = songs()[i];
    if (!s) return;
    var html = trOption(0, !s.tr);
    for (var m = 1; m <= 5; m++) html += trOption(m, s.tr === m, tailMissing(m) ? '<span class="tag">!</span>' : "");
    $("trList").innerHTML = html;
    var m2 = trEff(s), nx = nextSongIdx(i);
    $("trNote").textContent = nx < 0 ? T("trLast") : (tailMissing(m2) ? T("trNeedsTail") : "");
  }
  $("trList").addEventListener("click", function (e) {
    var b = e.target.closest(".tr-opt");
    if (!b) return;
    send("transition", +$("trSheet").dataset.i, +b.dataset.m);
    $("trSheet").hidden = true;
  });
  $("trClose").addEventListener("click", function () { $("trSheet").hidden = true; });
  $("trSheet").addEventListener("click", function (e) { if (e.target === $("trSheet")) $("trSheet").hidden = true; });
  $("optTrDefault").addEventListener("click", function (e) {
    var b = e.target.closest(".tr-opt");
    if (b) send("transdefault", +b.dataset.m);
  });
  function renderTrDefault() {
    var d = (struct && struct.trDefault) || 1, html = "";
    for (var m = 1; m <= 5; m++) html += trOption(m, d === m, tailMissing(m) ? '<span class="tag">!</span>' : "");
    $("optTrDefault").innerHTML = html;
  }

  function updateSetlistState() {
    var cur = pos && pos.playing ? (shownMed >= 0 ? MED + shownMed : pos.song) : -1;
    var shownItem = shownMed >= 0 ? MED + shownMed : shownIdx;
    var next = nextSongIdx(shownIdx);
    var curP = setlistPos(shownItem);
    var items = $("songs").querySelectorAll(".song");
    for (var k = 0; k < items.length; k++) {
      var el = items[k];
      var i = +el.dataset.i;
      var state = "", cls = "";
      if (i === cur) { state = T("stPlaying"); cls = "is-current"; }
      else if (i === shownItem) { state = T("stReady"); cls = "is-armed is-current"; }
      else if (i === next) { state = pos.pendingSong === i ? T("stChosen") : T("stNext"); cls = "is-next"; }
      else if (cur >= 0 && setlistPos(i) < curP) cls = "is-done";
      el.className = "song " + cls + (isMed(i) ? " is-medley" : "");
      el.querySelector(".s-state").textContent = state;
    }
  }

  // drag to reorder (mouse and touch)
  (function () {
    var drag = null;
    $("songs").addEventListener("pointerdown", function (e) {
      var h = e.target.closest(".handle");
      if (!h) return;
      var li = h.closest(".song");
      e.preventDefault();
      var r = li.getBoundingClientRect();
      var ghost = li.cloneNode(true);
      ghost.classList.add("drag-ghost");
      ghost.style.width = r.width + "px";
      ghost.style.left = r.left + "px";
      ghost.style.top = r.top + "px";
      document.body.appendChild(ghost);
      li.classList.add("dragging");
      var line = document.createElement("li");
      line.className = "drop-line";
      drag = { li: li, ghost: ghost, line: line, dy: e.clientY - r.top, dx: e.clientX - r.left, row: isConsole() };
      ghost.style.height = r.height + "px";
      if (drag.row) line.classList.add("v");
      h.setPointerCapture(e.pointerId);
    });
    $("songs").addEventListener("pointermove", function (e) {
      if (!drag) return;
      if (drag.row) drag.ghost.style.left = (e.clientX - drag.dx) + "px";
      else drag.ghost.style.top = (e.clientY - drag.dy) + "px";
      var items = Array.prototype.filter.call($("songs").children, function (x) { return x.classList.contains("song") && x !== drag.li; });
      var before = null;
      for (var i = 0; i < items.length; i++) {
        var r = items[i].getBoundingClientRect();
        if (drag.row ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2) { before = items[i]; break; }
      }
      $("songs").insertBefore(drag.line, before);
    });
    function end() {
      if (!drag) return;
      var list = $("songs");
      if (drag.line.parentNode) list.insertBefore(drag.li, drag.line);
      drag.line.remove();
      drag.ghost.remove();
      drag.li.classList.remove("dragging");
      drag = null;
      var newOrder = Array.prototype.map.call(list.querySelectorAll(".song"), function (x) { return +x.dataset.i; });
      if (list.querySelector(".med-new-li")) list.appendChild(list.querySelector(".med-new-li"));
      if (newOrder.join() !== order().join()) {
        struct.order = newOrder;
        renderSetlist();
        updateSetlistState();
        send.apply(null, ["setorder"].concat(newOrder));
      }
    }
    $("songs").addEventListener("pointerup", end);
    $("songs").addEventListener("pointercancel", end);
  })();

  var lastSongTap = { i: -1, at: 0 };
  $("songs").addEventListener("click", function (e) {
    if (e.target.closest(".handle")) return;
    var me = e.target.closest(".med-edit");
    if (me) { openWizard(+me.dataset.m); return; }
    if (e.target.closest("#btnMedNew")) { openWizard(-1); return; }
    var tr = e.target.closest(".trans");
    if (tr) { openTrans(+tr.dataset.i); return; }
    var li = e.target.closest(".song");
    if (!li) return;
    var i = +li.dataset.i;
    var now = Date.now();
    if (lastSongTap.i === i && now - lastSongTap.at < 350) send("playsong", i);
    else send("selectsong", i, 0);
    lastSongTap = { i: i, at: now };
    closeSetlist();
  });

  // ------------------------------------------------------------ song view

  var BEATS_DONE = -1;
  function renderBeatLights() {
    var n = pos ? pos.sigNum : 4;
    if ($("beatLights").children.length === n) return;
    var h = "";
    for (var i = 0; i < n; i++) h += "<i" + (i === 0 ? ' class="down"' : "") + "></i>";
    $("beatLights").innerHTML = h;
    BEATS_DONE = -1;
  }

  function renderSong() {
    var s = songs()[shownIdx];
    var empty = !s;
    $("empty").hidden = !empty;
    $("tiles").hidden = empty;
    $("hero").hidden = empty;
    $("mapWrap").hidden = empty;
    $("app").classList.toggle("is-empty", empty);
    if (empty) {
      $("songTitle").textContent = struct ? "" : T("waitingLive");
      return;
    }
    $("songTitle").textContent = shownMed >= 0 ? medleys()[shownMed].name : s.name;

    var len = s.end - s.start;
    var bl = barLen();
    var strip = "", pads = "";
    s.sections.forEach(function (sec, j) {
      var w = ((sec.end - sec.start) / len) * 100;
      var c = color(sec.name);
      var bars = Math.round((sec.end - sec.start) / bl);
      strip += '<button class="seg" data-j="' + j + '" style="--c:' + c + ";width:" + w + '%" title="' + esc(sec.name) + '"><i class="fill"></i><span>' + esc(sec.name) + "</span></button>";
      pads += '<button class="pad" data-j="' + j + '" style="--c:' + c + '">' +
        '<i class="p-fill"></i>' +
        '<span class="p-top"><span class="p-num">' + (j < 9 ? j + 1 : "") + '</span><span class="p-tag"></span></span>' +
        '<span class="p-name">' + esc(sec.name) + "</span>" +
        '<span class="p-bars">' + (bars === 1 ? T("barCount") : T("barsCount", { n: bars })) + "</span></button>";
    });
    $("strip").innerHTML = strip + '<i class="playhead" id="playhead"></i>';
    $("tiles").innerHTML = pads;
    renderLane(s);
    renderSongmap(s);
  }

  // the song's timeline: one band per section, a line per bar, bar numbers
  function renderLane(s) {
    var len = s.end - s.start, bl = barLen(), bars = Math.max(1, Math.round(len / bl));
    var lane = $("lane");
    lane.style.setProperty("--bars", bars);
    lane.style.setProperty("--beats", bars * (pos ? pos.sigNum : 4));
    var bands = "";
    s.sections.forEach(function (sec, j) {
      bands += '<i data-j="' + j + '" style="--c:' + color(sec.name) + ";left:" + ((sec.start - s.start) / len * 100) + "%;width:" + ((sec.end - sec.start) / len * 100) + '%"></i>';
    });
    $("laneBands").innerHTML = bands;
    var step = [1, 2, 4, 8, 16, 32].filter(function (n) { return bars / n <= 24; })[0] || 64;
    var nums = "";
    for (var b = 0; b < bars; b += step) nums += '<span style="left:' + (b / bars * 100) + '%">' + (b + 1) + "</span>";
    $("laneNums").innerHTML = nums;
  }

  // ------------------------------------------------------------ song map (console)
  // The song as one picture: its real waveform, each section a named region
  // in its color. Tap to jump, drag the line between sections to move it
  // (edit), pick a section to automate its mix (edit).
  var SEC_HEX = { intro: "#6f8dff", verse: "#2ec7b0", pre: "#f2b441", chorus: "#f45b84", bridge: "#a47dff", inst: "#5ab6f0", tag: "#8bd45f", outro: "#959db3" };
  var waves = {}, waveAsked = {};
  var sm = { edit: false, sel: -1, grid: 1, drawnKey: "" };
  try { sm.grid = +localStorage.getItem("sp_grid") || 1; } catch (e) { }
  var ABBR = [[/^pre[\s-]?(chorus|coro)\s*(\d*)/i, "PC"], [/^(chorus|coro)\s*(\d*)/i, "C"], [/^(verse|verso)\s*(\d*)/i, "V"], [/^(bridge|puente)\s*(\d*)/i, "B"],
    [/^intro\s*(\d*)/i, "In"], [/^(instrumental|inst)\s*(\d*)/i, "Inst"], [/^(interlude|interludio)\s*(\d*)/i, "Int"], [/^(turnaround)\s*(\d*)/i, "TA"],
    [/^(tag)\s*(\d*)/i, "Tag"], [/^(vamp)\s*(\d*)/i, "Vamp"], [/^(outro|final|ending)\s*(\d*)/i, "End"], [/^count/i, "CO"], [/^(breakdown)\s*(\d*)/i, "BD"]];
  function abbrev(name) {
    for (var i = 0; i < ABBR.length; i++) {
      var m = ABBR[i][0].exec(name);
      if (m) { var d = m[m.length - 1]; return ABBR[i][1] + (d && /^\d+$/.test(d) ? d : ""); }
    }
    return name.slice(0, 3);
  }
  function normName(n) {
    n = String(n).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    n = n.replace(/^[\s\d]+[-_.)\s]+/, "");
    if (n.indexOf(" - ") >= 0) n = n.slice(n.lastIndexOf(" - ") + 3);
    n = n.replace(/\([^)]*\)/g, " ").replace(/\btrack\b/g, " ").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
    var SYN = { click: "click", clic: "click", metronome: "click", metronomo: "click", guide: "guide", guides: "guide", cue: "guide", cues: "guide", guia: "guide", "vocal cues": "guide" };
    return SYN[n] || n;
  }

  // The map shows the song as it will play: its arrangement, section after
  // section, even when that order is not the order of the timeline.
  function mapLayout(s) {
    // a medley: its sections, song after song
    var mm = shownMed >= 0 ? medleys()[shownMed] : null;
    if (mm) {
      var dm = 0, mit = [];
      mm.slots.forEach(function (x, k) {
        var sg = songs()[x.s], sec = sg && sg.sections[x.j];
        if (!sec) return;
        mit.push({ k: k, j: x.j, s: x.s, sec: sec, d0: dm, d1: dm + sec.end - sec.start });
        dm += sec.end - sec.start;
      });
      return { items: mit, total: dm, edited: true, med: true };
    }
    var a = s.arr && s.arr.length ? s.arr : null;
    var list = a || s.sections.map(function (_, j) { return j; });
    var d = 0, items = [];
    list.forEach(function (j, k) {
      var sec = s.sections[j];
      if (!sec) return;
      var L = sec.end - sec.start;
      items.push({ k: k, j: j, s: shownIdx, sec: sec, d0: d, d1: d + L });
      d += L;
    });
    return { items: items, total: d, edited: !!a };
  }
  function curItem(L) {
    if (L.med) {
      if (!pos || pos.med !== shownMed) return null;
      var mk = L.items[pos.medK];
      if (mk && mk.s === pos.song && mk.j === pos.sec) return mk;
      for (var q = 0; q < L.items.length; q++) if (L.items[q].s === pos.song && L.items[q].j === pos.sec) return L.items[q];
      return null;
    }
    if (!pos || pos.song !== shownIdx) return null;
    if (!L.edited) return L.items[pos.sec] || null;
    var it = L.items[pos.arrK];
    if (it && it.j === pos.sec) return it;
    for (var i = 0; i < L.items.length; i++) if (L.items[i].j === pos.sec) return L.items[i];
    return null;
  }
  // where the playhead sits on the map: x in %, d in beats from the start of the arrangement
  function mapPos(s, t, here) {
    var L = sm.lay;
    if (!L || !L.total) return { x: 0, d: 0, total: 0 };
    var d = 0;
    if (L.med) here = !!(pos && pos.med === shownMed);
    if (here) {
      var it = curItem(L);
      if (it) d = it.d0 + Math.max(0, Math.min(it.d1 - it.d0, t - it.sec.start));
      else {
        d = L.total;
        if (L.med) d = 0;
        else for (var i = 0; i < L.items.length; i++) if (L.items[i].j > pos.sec) { d = L.items[i].d0; break; }
      }
    }
    return { x: Math.min(100, d / L.total * 100), d: d, total: L.total };
  }

  function renderSongmap(s) {
    var L = sm.lay = mapLayout(s), len = L.total || 1, bl = barLen(), bars = Math.max(1, Math.round(len / bl));
    var labels = "", regions = "", handles = "", ruler = "";
    L.items.forEach(function (it) {
      var l = it.d0 / len * 100, w = (it.d1 - it.d0) / len * 100;
      var fam = family(it.sec.name);
      labels += '<button class="sm-label" data-k="' + it.k + '" data-j="' + it.j + '" style="--c:' + SEC_HEX[fam] + ";left:" + l + "%;max-width:" + w + '%" title="' + esc(it.sec.name) + '">' +
        '<span class="full">' + esc(it.sec.name) + '</span><span class="short">' + esc(abbrev(it.sec.name)) + '</span><i class="auto-dot"></i></button>';
      regions += '<div class="sm-region" data-k="' + it.k + '" style="--c:' + SEC_HEX[fam] + ";left:" + l + "%;width:" + w + '%"></div>';
      if (!L.edited && it.j > 0 && !it.sec.implicit) handles += '<div class="sm-handle" data-j="' + it.j + '" style="left:' + l + '%"><i></i></div>';
    });
    var step = [1, 2, 4, 8, 16, 32].filter(function (n) { return bars / n <= 28; })[0] || 64;
    for (var b = 0; b < bars; b += step) ruler += '<span style="left:' + (b / bars * 100) + '%">' + (b + 1) + "</span>";
    $("smLabels").innerHTML = labels;
    $("smRegions").innerHTML = regions;
    $("smHandles").innerHTML = handles;
    $("smRuler").innerHTML = ruler;
    $("smEdited").hidden = !L.edited || !!L.med;
    $("smMed").hidden = !L.med;
    $("smArr").hidden = $("smEdit").hidden = !!L.med;
    $("smMedEdit").hidden = !L.med;
    if (L.med) $("smMedName").textContent = medleys()[shownMed].name;
    sm.drawnKey = "";
    fitLabels();
    var need = {};
    L.items.forEach(function (it) { need[it.s] = 1; });
    Object.keys(need).forEach(function (si) {
      var sg = songs()[si];
      if (sg && !waves[sg.name] && !waveAsked[sg.name] && isConsole()) { waveAsked[sg.name] = 1; send("wave", +si); }
    });
    drawWave();
    if (ae.open) {
      // Live echoes every edit back; only an outside change (or another song) rebuilds the editor
      var incoming = (s.arr && s.arr.length ? s.arr : s.sections.map(function (_, j) { return j; })).join(",");
      if (incoming === ae.sentKey) ae.sentKey = "";
      if (ae.song !== shownIdx || (incoming !== ae.list.join(",") && !(ae.sentKey && Date.now() - ae.sentAt < 2000))) { aeLoad(); renderArrEd(); }
    }
  }

  // full names where they fit, short ones where they don't
  function fitLabels() {
    var els = $("smLabels").children;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      el.classList.remove("is-short");
      if (el.scrollWidth > el.clientWidth + 1) el.classList.add("is-short");
    }
  }

  function itemState(L, it) {
    if (L.med) {
      var cm = curItem(L), sm1 = { current: !!cm && cm.k === it.k, queued: false, landing: false, loop: false, past: false };
      sm1.past = !!(cm && pos.playing && it.k < cm.k);
      sm1.queued = !!(pos && pos.med === shownMed && !pos.qAuto && pos.qMedK === it.k);
      return sm1;
    }
    var st = sectionState(it.j);
    if (!L.edited) return st;
    var ci = curItem(L);
    st.current = !!ci && ci.k === it.k;
    st.past = !!(ci && pos.playing && it.k < ci.k);
    st.queued = !!(pos && pos.qSong === shownIdx && !pos.qAuto && (pos.qArrK >= 0 ? pos.qArrK === it.k : pos.qSec === it.j));
    st.loop = st.loop && st.current;
    return st;
  }

  function updateSongmap(s) {
    var L = sm.lay || (sm.lay = mapLayout(s));
    var regs = $("smRegions").children, labs = $("smLabels").children;
    var auto = s.auto || {};
    var ci = curItem(L);
    L.items.forEach(function (it, i) {
      var st = itemState(L, it);
      var c = { "is-current": st.current, "is-live": st.current && !!pos.playing, "is-past": st.past, "is-queued": st.queued, "is-loop": st.loop, "is-sel": sm.edit && sm.sel === it.j, "has-auto": !L.med && !!auto[it.j] };
      for (var k in c) {
        if (regs[i] && regs[i].classList.contains(k) !== c[k]) regs[i].classList.toggle(k, c[k]);
        if (labs[i] && labs[i].classList.contains(k) !== c[k]) labs[i].classList.toggle(k, c[k]);
      }
    });
    var key = shownIdx + "|" + shownMed + "|" + (ci ? ci.k : -1) + ":" + (pos ? pos.playing : "") + "|" + Object.keys(waves).length + "|" + sm.sel + "|" + L.total;
    if (key !== sm.drawnKey) drawWave();
    $("smHint").textContent = sm.edit ? (pos && pos.playing ? T("smHintStopped") : (L.edited ? T("smHintEditArr") : T("smHintEdit"))) : T("smHintPlay");
    $("songmap").classList.toggle("editing", sm.edit);
    $("smGrid").hidden = !sm.edit || L.edited;
    setSeg("smGrid", sm.grid);
  }

  // one waveform slice per section of the arrangement
  function drawSlice(g, w, sec, x0, x1, H, step) {
    var mid = H / 2, amp = H * 0.44;
    if (w && w.peaks.length) {
      var n = w.peaks.length, span = w.to - w.from, L = sec.end - sec.start;
      for (var x = Math.floor(x0) + 1; x < x1 - 1; x += step) {
        var beat = sec.start + (x - x0) / (x1 - x0) * L;
        var k = Math.floor((beat - w.from) / span * n);
        var v = w.peaks[Math.max(0, Math.min(n - 1, k))] || 0;
        var h = Math.max(1.5, v * amp);
        g.fillRect(x, mid - h, step > 2 ? 2 : 1, h * 2);
      }
    } else {
      g.globalAlpha *= 0.25;
      g.fillRect(x0 + 1, mid - 1, x1 - x0 - 2, 2);
    }
  }

  function drawWave() {
    var s = songs()[shownIdx];
    var cv = $("smCanvas"), wrap = $("smCanvasWrap");
    if (!s || !isConsole() || !wrap.clientWidth) return;
    var L = sm.lay || (sm.lay = mapLayout(s));
    var ci = curItem(L);
    sm.drawnKey = shownIdx + "|" + shownMed + "|" + (ci ? ci.k : -1) + ":" + (pos ? pos.playing : "") + "|" + Object.keys(waves).length + "|" + sm.sel + "|" + L.total;
    var dpr = window.devicePixelRatio || 1, W = wrap.clientWidth, H = wrap.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    var g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    var len = L.total || 1, bl = barLen(), bars = Math.round(len / bl);
    g.fillStyle = "rgba(255,255,255,0.05)";
    for (var b = 1; b < bars; b++) g.fillRect(Math.round(b / bars * W), 0, 1, H);
    var playingHere = pos && pos.playing && (L.med ? pos.med === shownMed : pos.song === shownIdx);
    L.items.forEach(function (it, i) {
      var cur = ci && ci.k === it.k, past = playingHere && ci && it.k < ci.k;
      g.globalAlpha = past ? 0.3 : cur ? 1 : 0.78;
      g.fillStyle = SEC_HEX[family(it.sec.name)];
      var sg = songs()[it.s];
      drawSlice(g, sg ? waves[sg.name] : null, it.sec, it.d0 / len * W, it.d1 / len * W, H, 3);
      // where one song hands over to the next: a clear seam
      if (L.med && i > 0 && L.items[i - 1].s !== it.s) { g.globalAlpha = 0.9; g.fillStyle = "#fff"; g.fillRect(Math.round(it.d0 / len * W) - 1, 0, 2, H); }
    });
    g.globalAlpha = 1;
  }

  function itemAtX(x, W) {
    var L = sm.lay;
    if (!L || !L.items.length) return null;
    var d = x / W * L.total;
    for (var i = L.items.length - 1; i >= 0; i--) if (d >= L.items[i].d0 - 1e-6) return L.items[i];
    return L.items[0];
  }

  // taps on the map
  var smTap = { k: -1, at: 0 };
  $("smCanvasWrap").addEventListener("click", function (e) {
    if (e.target.closest(".sm-handle") || sm.dragged) { sm.dragged = false; return; }
    var r = this.getBoundingClientRect();
    var it = itemAtX(e.clientX - r.left, r.width);
    if (it) pickItem(it);
  });
  $("smLabels").addEventListener("click", function (e) {
    var b = e.target.closest(".sm-label");
    if (b && sm.lay) pickItem(sm.lay.items[+b.dataset.k]);
  });
  function pickItem(it) {
    if (!it) return;
    if (sm.edit) { sm.sel = sm.sel === it.j ? -1 : it.j; updateAutoMode(); render(); return; }
    var now = Date.now(), dbl = smTap.k === it.k && now - smTap.at < 350 ? 1 : 0;
    if (sm.lay && sm.lay.med) send("medgo", shownMed, it.k, dbl);
    else if (sm.lay && sm.lay.edited) send("arrgo", shownIdx, it.k, dbl);
    else send("section", shownIdx, it.j, dbl);
    smTap = { k: it.k, at: now };
    if (navigator.vibrate) try { navigator.vibrate(8); } catch (er) { }
  }

  $("smEdit").addEventListener("click", function () {
    sm.edit = !sm.edit;
    if (!sm.edit) sm.sel = -1;
    if (sm.edit && ae.open) closeArrEd();
    this.setAttribute("aria-pressed", sm.edit ? "true" : "false");
    updateAutoMode();
    render();
  });
  $("smGrid").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    sm.grid = +b.dataset.v;
    try { localStorage.setItem("sp_grid", sm.grid); } catch (er) { }
    setSeg("smGrid", sm.grid);
  });

  // drag the line between two sections, on the grid
  (function () {
    var d = null;
    $("smHandles").addEventListener("pointerdown", function (e) {
      var h = e.target.closest(".sm-handle");
      if (!h || !sm.edit) return;
      if (pos && pos.playing) { $("smHint").animate && $("smHint").animate([{ color: "#ffb547" }, { color: "" }], 900); return; }
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      d = { h: h, j: +h.dataset.j, r: $("smCanvasWrap").getBoundingClientRect(), at: null };
      h.classList.add("dragging");
    });
    $("smHandles").addEventListener("pointermove", function (e) {
      if (!d) return;
      var s = songs()[shownIdx], len = s.end - s.start, bl = barLen();
      var step = sm.grid * bl;
      var beat = s.start + Math.max(0, Math.min(1, (e.clientX - d.r.left) / d.r.width)) * len;
      var prev = s.sections[d.j - 1], sec = s.sections[d.j];
      var snapped = s.start + Math.round((beat - s.start) / step) * step;
      snapped = Math.max(prev.start + step, Math.min(sec.end - step, snapped));
      d.at = snapped;
      d.h.style.left = ((snapped - s.start) / len * 100) + "%";
      var inSong = snapped - s.start, bar = Math.floor(inSong / bl + 1e-6) + 1, bt = Math.round(((inSong % bl) / (4 / (pos ? pos.sigDen : 4))) * 100) / 100 + 1;
      var tip = $("smTip");
      tip.hidden = false;
      tip.textContent = sec.name + " · " + bar + (bt > 1.001 ? "." + String(bt).replace(/\.?0+$/, "") : "");
      tip.style.left = ((snapped - s.start) / len * 100) + "%";
    });
    function end() {
      if (!d) return;
      d.h.classList.remove("dragging");
      $("smTip").hidden = true;
      var s = songs()[shownIdx];
      if (d.at != null && Math.abs(d.at - s.sections[d.j].start) > 1e-4) {
        send("movesec", shownIdx, d.j, Math.round(d.at * 100));
        sm.dragged = true;
      }
      d = null;
    }
    $("smHandles").addEventListener("pointerup", end);
    $("smHandles").addEventListener("pointercancel", end);
  })();

  // ------------------------------------------------------------ arrangement editor
  // Reorder, remove or repeat sections. Nothing in Live is cut: SetPilot plays
  // the new order by jumping on the downbeat. The original sections are always
  // there to add again.
  var ae = { open: false, list: [], uids: [], sel: -1, nextUid: 1, drag: null, song: -1 };

  function aeSong() { return songs()[shownIdx]; }
  function aeLoad() {
    var s = aeSong();
    ae.song = shownIdx;
    ae.list = (s.arr && s.arr.length ? s.arr : s.sections.map(function (_, j) { return j; })).slice();
    ae.uids = ae.list.map(function () { return ae.nextUid++; });
    if (ae.sel >= ae.list.length) ae.sel = ae.list.length - 1;
  }
  function openArrEd() {
    if (!aeSong()) return;
    if (sm.edit) { sm.edit = false; sm.sel = -1; $("smEdit").setAttribute("aria-pressed", "false"); updateAutoMode(); }
    ae.open = true;
    ae.sel = -1;
    aeLoad();
    $("songmap").classList.add("arranging");
    $("arrEd").hidden = false;
    $("smArr").setAttribute("aria-pressed", "true");
    renderArrEd();
    if (!reduceMotion && $("arrEd").animate) $("arrEd").animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(.16,1,.3,1)" });
  }
  function closeArrEd() {
    ae.open = false;
    $("songmap").classList.remove("arranging");
    $("arrEd").hidden = true;
    $("smArr").setAttribute("aria-pressed", "false");
    var s = aeSong();
    if (s) { renderSongmap(s); updateSongmap(s); }
  }
  $("smArr").addEventListener("click", function () { if (ae.open) closeArrEd(); else openArrEd(); });
  $("aeDone").addEventListener("click", closeArrEd);
  $("aeReset").addEventListener("click", function () {
    var s = aeSong();
    if (!s) return;
    aeCommit(s.sections.map(function (_, j) { return j; }), null);
  });

  function barsText(n) { return n === 1 ? T("aeBar") : T("aeBars", { n: n }); }

  function renderArrEd() {
    var s = aeSong();
    if (!s || !ae.open) return;
    if (ae.song !== shownIdx) aeLoad();
    var bl = barLen();
    // pool: the song as it was imported, in timeline order
    $("aePool").innerHTML = s.sections.map(function (sec, j) {
      var n = Math.max(1, Math.round((sec.end - sec.start) / bl));
      return '<button class="ae-chip" data-j="' + j + '" style="--c:' + SEC_HEX[family(sec.name)] + '"><b>' + esc(sec.name) + "</b><small>" + n + "</small></button>";
    }).join("");
    var tot = 0;
    ae.list.forEach(function (j) { var sec = s.sections[j]; tot += sec.end - sec.start; });
    $("aeLane").innerHTML = ae.list.map(function (j, k) {
      var sec = s.sections[j], L = sec.end - sec.start, n = Math.max(1, Math.round(L / bl));
      return '<div class="ae-block' + (k === ae.sel ? " is-sel" : "") + '" data-k="' + k + '" data-u="' + ae.uids[k] + '" style="--c:' + SEC_HEX[family(sec.name)] + ";flex-grow:" + n + '">' +
        '<canvas></canvas><span class="ae-name">' + esc(sec.name) + '</span><span class="ae-bars">' + barsText(n) + "</span>" +
        '<button class="ae-x" aria-label="' + esc(T("aeRemove")) + '"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>';
    }).join("");
    var bpm = effBpm(s), orig = (s.end - s.start) * 60 / bpm, now = tot * 60 / bpm;
    var same = Math.abs(orig - now) < 0.5;
    $("aeInfo").textContent = T(same ? "aeInfoSame" : "aeInfo", { a: fmtTime(orig), b: fmtTime(now), n: ae.list.length });
    $("aeReset").disabled = !s.arr;
    aeDrawBlocks();
  }

  function aeDrawBlocks() {
    var s = aeSong();
    if (!s) return;
    var w = waves[s.name], blocks = $("aeLane").children, dpr = window.devicePixelRatio || 1;
    for (var i = 0; i < blocks.length; i++) {
      var cv = blocks[i].querySelector("canvas"), sec = s.sections[ae.list[+blocks[i].dataset.k]];
      var W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) continue;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      var g = cv.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = SEC_HEX[family(sec.name)];
      g.globalAlpha = 0.55;
      drawSlice(g, w, sec, 0, W, H, 3);
    }
  }

  // FLIP: blocks glide from where they were to where they are now
  function aeCommit(list, uids) {
    var s = aeSong();
    if (!s || !list.length) return;
    var before = {};
    var blocks = $("aeLane").children;
    for (var i = 0; i < blocks.length; i++) before[blocks[i].dataset.u] = blocks[i].getBoundingClientRect();
    ae.list = list;
    ae.uids = uids || list.map(function () { return ae.nextUid++; });
    renderArrEd();
    if (!reduceMotion) {
      blocks = $("aeLane").children;
      for (i = 0; i < blocks.length; i++) {
        var b = blocks[i], r0 = before[b.dataset.u], r1 = b.getBoundingClientRect();
        if (!b.animate) continue;
        if (r0) {
          var dx = r0.left - r1.left, dy = r0.top - r1.top, sx = r0.width / (r1.width || 1);
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(sx - 1) > 0.01)
            b.animate([{ transform: "translate(" + dx + "px," + dy + "px) scaleX(" + sx + ")", transformOrigin: "left" }, { transform: "none", transformOrigin: "left" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
        } else {
          b.animate([{ transform: "scale(.85)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" });
        }
      }
    }
    ae.sentKey = list.join(",");
    ae.sentAt = Date.now();
    send.apply(null, ["arrset", shownIdx].concat(list));
    if (navigator.vibrate) try { navigator.vibrate(6); } catch (er) { }
  }

  function aeInsert(j, at) {
    var list = ae.list.slice(), uids = ae.uids.slice();
    if (at == null) at = ae.sel >= 0 ? ae.sel + 1 : list.length;
    list.splice(at, 0, j);
    uids.splice(at, 0, ae.nextUid++);
    ae.sel = at;
    aeCommit(list, uids);
    var nb = $("aeLane").children[at];
    if (nb && nb.scrollIntoView) nb.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }
  function aeRemove(k) {
    if (ae.list.length <= 1) return;
    var el = $("aeLane").children[k];
    var go = function () {
      var list = ae.list.slice(), uids = ae.uids.slice();
      list.splice(k, 1); uids.splice(k, 1);
      if (ae.sel >= list.length) ae.sel = list.length - 1;
      else if (ae.sel > k) ae.sel--;
      else if (ae.sel === k) ae.sel = -1;
      aeCommit(list, uids);
    };
    if (el && el.animate && !reduceMotion) {
      el.style.pointerEvents = "none";
      el.animate([{ transform: "none", opacity: 1 }, { transform: "scale(.8)", opacity: 0 }], { duration: 160, easing: "ease-in", fill: "forwards" }).onfinish = go;
    } else go();
  }
  function aeMove(from, to) {
    if (to > from) to--;
    if (to === from) return;
    var list = ae.list.slice(), uids = ae.uids.slice();
    var j = list.splice(from, 1)[0], u = uids.splice(from, 1)[0];
    list.splice(to, 0, j); uids.splice(to, 0, u);
    ae.sel = to;
    aeCommit(list, uids);
  }

  // insertion point for a pointer x: index in the lane, and where to draw the caret
  function aeDropAt(x, y, skipK) {
    var lane = $("aeLane"), r = lane.getBoundingClientRect();
    if (y < r.top - 40 || y > r.bottom + 40) return null;
    var blocks = lane.children, at = blocks.length, cx = null;
    for (var i = 0; i < blocks.length; i++) {
      if (i === skipK) continue;
      var b = blocks[i].getBoundingClientRect();
      if (x < b.left + b.width / 2) { at = i; cx = b.left; break; }
    }
    if (cx == null) { var last = blocks[blocks.length - 1]; cx = last ? last.getBoundingClientRect().right : r.left; }
    var wr = lane.parentNode.getBoundingClientRect();
    return { at: at, x: cx - wr.left };
  }
  function aeCaret(d) {
    var c = $("aeCaret");
    if (!d) { c.hidden = true; return; }
    c.hidden = false;
    c.style.transform = "translateX(" + (d.x - 2) + "px)";
  }

  // one pointer handler for both: blocks (reorder) and chips (add)
  function aeStart(e, kind, ref) {
    if (e.button > 0) return;
    ae.drag = { kind: kind, ref: ref, x0: e.clientX, y0: e.clientY, on: false, ghost: null, src: e.currentTarget || e.target, id: e.pointerId };
  }
  $("aeLane").addEventListener("pointerdown", function (e) {
    if (e.target.closest(".ae-x")) return;
    var b = e.target.closest(".ae-block");
    if (!b) return;
    aeStart(e, "block", +b.dataset.k);
    ae.drag.src = b;
  });
  $("aePool").addEventListener("pointerdown", function (e) {
    var c = e.target.closest(".ae-chip");
    if (!c) return;
    aeStart(e, "chip", +c.dataset.j);
    ae.drag.src = c;
  });
  window.addEventListener("pointermove", function (e) {
    var d = ae.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.on) {
      if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < 7) return;
      d.on = true;
      var r = d.src.getBoundingClientRect();
      d.dx = d.x0 - r.left; d.dy = d.y0 - r.top;
      d.ghost = d.src.cloneNode(true);
      d.ghost.classList.add("ae-ghost");
      var c0 = d.src.querySelector("canvas"), c1 = d.ghost.querySelector("canvas");
      if (c0 && c1) { c1.width = c0.width; c1.height = c0.height; try { c1.getContext("2d").drawImage(c0, 0, 0); } catch (er) { } }
      d.ghost.style.width = r.width + "px";
      d.ghost.style.height = r.height + "px";
      document.body.appendChild(d.ghost);
      if (d.kind === "block") d.src.classList.add("is-lifted");
      try { d.src.setPointerCapture(d.id); } catch (er) { }
    }
    e.preventDefault();
    d.ghost.style.transform = "translate(" + (e.clientX - d.dx) + "px," + (e.clientY - d.dy) + "px) rotate(-1.5deg) scale(1.04)";
    d.drop = aeDropAt(e.clientX, e.clientY, d.kind === "block" ? d.ref : -1);
    aeCaret(d.drop);
  }, { passive: false });
  function aeEnd(e) {
    var d = ae.drag;
    if (!d || (e && e.pointerId !== d.id)) return;
    ae.drag = null;
    aeCaret(null);
    if (d.ghost) d.ghost.remove();
    if (d.src) d.src.classList.remove("is-lifted");
    if (!d.on) {
      // a tap
      if (d.kind === "chip") aeInsert(d.ref, null);
      else { ae.sel = ae.sel === d.ref ? -1 : d.ref; renderArrEd(); }
      return;
    }
    if (!d.drop || (e && e.type === "pointercancel")) return;
    if (d.kind === "chip") aeInsert(d.ref, d.drop.at);
    else aeMove(d.ref, d.drop.at);
  }
  window.addEventListener("pointerup", aeEnd);
  window.addEventListener("pointercancel", aeEnd);
  $("aeLane").addEventListener("click", function (e) {
    var x = e.target.closest(".ae-x");
    if (!x) return;
    aeRemove(+x.closest(".ae-block").dataset.k);
  });
  window.addEventListener("keydown", function (e) {
    if (!ae.open || ae.sel < 0 || /input|select|textarea/i.test(e.target.tagName)) return;
    if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); aeRemove(ae.sel); }
  });

  // ------------------------------------------------------------ medley wizard
  // Sections from any songs, in any order, played as one piece: one tempo and
  // one key (suggested from the first song, changeable). Drag sections from
  // the songs into the lane; a bar over each song's blocks shows how far it is
  // moved in key and tempo.
  var wiz = { open: false, mi: -1, id: "", list: [], uids: [], sel: -1, nextUid: 1, key: null, minor: "", bpm: 0, keyTouched: false, bpmTouched: false, tr: 1, drag: null, delArmed: false };

  function wizFirstSong() { return wiz.list.length ? songs()[wiz.list[0].s] : null; }
  function songRoot(sg) { var p = parseKey(sg && sg.key); return p ? p.root : null; }
  function wizSuggest() {
    var f = wizFirstSong();
    if (!wiz.keyTouched) {
      var r = songRoot(f);
      wiz.key = r == null ? null : ((r + (f.semis || 0)) % 12 + 12) % 12;
      wiz.minor = f ? ((parseKey(f.key) || {}).minor || "") : "";
    }
    if (!wiz.bpmTouched) wiz.bpm = f ? Math.round(effBpm(f) * 10) / 10 : 0;
  }
  // how far a song moves to reach the medley key: the shortest way, -5..+6
  function wizSemis(si) {
    var r = songRoot(songs()[si]);
    if (wiz.key == null || r == null) return 0;
    var d = ((wiz.key - r) % 12 + 12) % 12;
    return d > 6 ? d - 12 : d;
  }
  function wizKeyLabel() { return wiz.key == null ? "" : KEYS[wiz.key] + (wiz.minor || ""); }

  function openWizard(mi) {
    var m = mi >= 0 ? medleys()[mi] : null;
    wiz.open = true; wiz.mi = m ? mi : -1; wiz.id = m ? m.id : ""; wiz.sel = -1; wiz.delArmed = false;
    wiz.list = m ? m.slots.map(function (x) { return { s: x.s, j: x.j }; }) : [];
    wiz.uids = wiz.list.map(function () { return wiz.nextUid++; });
    wiz.tr = m ? (m.tr || 1) : 1;
    wiz.keyTouched = !!(m && m.key);
    wiz.bpmTouched = !!(m && m.bpm);
    if (m && m.key) { var pk = parseKey(m.key); wiz.key = pk ? pk.root : null; wiz.minor = pk ? pk.minor : ""; }
    if (m && m.bpm) wiz.bpm = m.bpm;
    wizSuggest();
    $("wizName").value = m ? m.name : T("medDefaultName", { n: medleys().length + 1 });
    $("wizDelete").hidden = !m;
    $("wizDelete").textContent = T("medDelete");
    $("wizSheet").hidden = false;
    closeSetlist();
    renderWizard();
  }
  function closeWizard() { wiz.open = false; $("wizSheet").hidden = true; }
  $("wizClose").addEventListener("click", closeWizard);
  $("wizCancel").addEventListener("click", closeWizard);
  $("wizSheet").addEventListener("click", function (e) { if (e.target === $("wizSheet")) closeWizard(); });
  $("smMedEdit").addEventListener("click", function () { if (shownMed >= 0) openWizard(shownMed); });
  $("wizImport").addEventListener("click", function () { openAdd(); });

  function renderWizard() {
    if (!wiz.open) return;
    var bl = barLen();
    // settings
    var f = wizFirstSong();
    $("wizKey").textContent = wiz.key == null ? "–" : wizKeyLabel();
    $("wizKeyHint").textContent = wiz.key == null ? T("medKeyOwn") : (!wiz.keyTouched && f ? T("medKeyHint", { song: f.name }) : "");
    if (document.activeElement !== $("wizBpm")) $("wizBpm").value = wiz.bpm ? fmtBpm(wiz.bpm) : "";
    $("wizBpmHint").textContent = !wiz.bpmTouched && f ? T("medBpmHint", { song: f.name }) : "";
    setSeg("wizTr", wiz.tr >= 3 ? 3 : 1);
    // the songs to pick from, in setlist order
    var html = "";
    order().forEach(function (i) {
      if (isMed(i)) return;
      var sg = songs()[i];
      if (!sg) return;
      var k = keyName(sg.key, sg.semis) || "";
      html += '<div class="wiz-song" data-s="' + i + '"><div class="ws-head"><b>' + esc(sg.name) + '</b><span>' + esc(k) + (k ? " · " : "") + fmtBpm(effBpm(sg)) + ' BPM</span>' +
        '<button type="button" class="ws-all" data-s="' + i + '">' + esc(T("medAll")) + "</button></div><div class=\"ws-chips\">" +
        sg.sections.map(function (sec, j) {
          var n = Math.max(1, Math.round((sec.end - sec.start) / bl));
          return '<button type="button" class="ae-chip" data-s="' + i + '" data-j="' + j + '" style="--c:' + SEC_HEX[family(sec.name)] + '"><b>' + esc(sec.name) + "</b><small>" + n + "</small></button>";
        }).join("") + "</div></div>";
    });
    $("wizSongs").innerHTML = html;
    // the lane: one run per song in a row, a bar over it with key and tempo
    var runs = "", k0 = 0, total = 0;
    while (k0 < wiz.list.length) {
      var s0 = wiz.list[k0].s, k1 = k0, bars = 0, blocks = "";
      while (k1 < wiz.list.length && wiz.list[k1].s === s0) {
        var it = wiz.list[k1], sg2 = songs()[it.s], sec2 = sg2.sections[it.j], nb = Math.max(1, Math.round((sec2.end - sec2.start) / bl));
        total += sec2.end - sec2.start;
        bars += nb;
        blocks += '<div class="ae-block' + (k1 === wiz.sel ? " is-sel" : "") + '" data-k="' + k1 + '" data-u="' + wiz.uids[k1] + '" style="--c:' + SEC_HEX[family(sec2.name)] + ";flex-grow:" + nb + '">' +
          '<canvas></canvas><span class="ae-name">' + esc(sec2.name) + '</span><span class="ae-bars">' + barsText(nb) + "</span>" +
          '<button class="ae-x" aria-label="' + esc(T("aeRemove")) + '"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>';
        k1++;
      }
      var sg0 = songs()[s0], sem = wizSemis(s0), own = keyName(sg0.key, 0);
      var keyTxt = own ? (wiz.key == null ? own : own + " → " + wizKeyLabel() + (sem ? " (" + semisLabel(sem) + ")" : "")) : T("medNoKey");
      var sb = effBpm(sg0), ratio = wiz.bpm && sb ? Math.round(wiz.bpm / sb * 100) : 100;
      var bpmTxt = fmtBpm(sb) + (wiz.bpm && Math.abs(wiz.bpm - sb) > 0.05 ? " → " + fmtBpm(wiz.bpm) : "") + " BPM";
      runs += '<div class="wiz-run" style="flex-grow:' + bars + '"><div class="wiz-runbar' + (Math.abs(ratio - 100) > 25 || Math.abs(sem) > 4 ? " warn" : "") + '">' +
        "<b>" + esc(sg0.name) + "</b><span>" + esc(keyTxt) + "</span><span>" + esc(bpmTxt) + (ratio !== 100 ? " · " + esc(T("medStretch", { p: ratio })) : "") + "</span></div>" +
        '<div class="wiz-blocks">' + blocks + "</div></div>";
      k0 = k1;
    }
    $("wizLane").innerHTML = runs;
    $("wizEmpty").hidden = wiz.list.length > 0;
    var secs = wiz.bpm ? total * 60 / wiz.bpm : 0, nsongs = {};
    wiz.list.forEach(function (x) { nsongs[x.s] = 1; });
    $("wizInfo").textContent = wiz.list.length ? T("medInfo", { t: fmtTime(secs), n: wiz.list.length, s: Object.keys(nsongs).length }) : T("medNeedTwo");
    $("wizSave").disabled = !wiz.list.length;
    wizDrawBlocks();
  }

  function wizDrawBlocks() {
    var blocks = $("wizLane").querySelectorAll(".ae-block"), dpr = window.devicePixelRatio || 1;
    for (var i = 0; i < blocks.length; i++) {
      var it = wiz.list[+blocks[i].dataset.k], sg = it && songs()[it.s];
      if (!sg) continue;
      if (!waves[sg.name] && !waveAsked[sg.name]) { waveAsked[sg.name] = 1; send("wave", it.s); }
      var cv = blocks[i].querySelector("canvas"), W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) continue;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      var g = cv.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = SEC_HEX[family(sg.sections[it.j].name)];
      g.globalAlpha = 0.55;
      drawSlice(g, waves[sg.name], sg.sections[it.j], 0, W, H, 3);
    }
  }

  function wizCommit(list, uids) {
    var before = {}, blocks = $("wizLane").querySelectorAll(".ae-block"), i;
    for (i = 0; i < blocks.length; i++) before[blocks[i].dataset.u] = blocks[i].getBoundingClientRect();
    var firstWas = wiz.list.length ? wiz.list[0].s : -1;
    wiz.list = list;
    wiz.uids = uids;
    if ((list.length ? list[0].s : -1) !== firstWas) wizSuggest();
    renderWizard();
    if (reduceMotion) return;
    blocks = $("wizLane").querySelectorAll(".ae-block");
    for (i = 0; i < blocks.length; i++) {
      var b = blocks[i], r0 = before[b.dataset.u], r1 = b.getBoundingClientRect();
      if (!b.animate) continue;
      if (r0) {
        var dx = r0.left - r1.left, dy = r0.top - r1.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) b.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
      } else b.animate([{ transform: "scale(.85)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    if (navigator.vibrate) try { navigator.vibrate(6); } catch (er) { }
  }
  function wizInsert(items, at) {
    var list = wiz.list.slice(), uids = wiz.uids.slice();
    if (at == null) at = wiz.sel >= 0 ? wiz.sel + 1 : list.length;
    items.forEach(function (x, n) { list.splice(at + n, 0, x); uids.splice(at + n, 0, wiz.nextUid++); });
    wiz.sel = at + items.length - 1;
    wizCommit(list, uids);
    var nb = $("wizLane").querySelector('.ae-block[data-k="' + wiz.sel + '"]');
    if (nb && nb.scrollIntoView) nb.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }
  function wizRemove(k) {
    var list = wiz.list.slice(), uids = wiz.uids.slice();
    list.splice(k, 1); uids.splice(k, 1);
    if (wiz.sel >= list.length) wiz.sel = list.length - 1; else if (wiz.sel > k) wiz.sel--; else if (wiz.sel === k) wiz.sel = -1;
    wizCommit(list, uids);
  }
  function wizMove(from, to) {
    if (to > from) to--;
    if (to === from) return;
    var list = wiz.list.slice(), uids = wiz.uids.slice();
    var x = list.splice(from, 1)[0], u = uids.splice(from, 1)[0];
    list.splice(to, 0, x); uids.splice(to, 0, u);
    wiz.sel = to;
    wizCommit(list, uids);
  }
  function wizDropAt(x, y, skipK) {
    var wrap = $("wizLaneWrap"), r = wrap.getBoundingClientRect();
    if (y < r.top - 30 || y > r.bottom + 30 || x < r.left - 30 || x > r.right + 30) return null;
    var blocks = Array.prototype.slice.call($("wizLane").querySelectorAll(".ae-block")), at = wiz.list.length, cx = null, cy = null, ch = 0;
    for (var i = 0; i < blocks.length; i++) {
      var k = +blocks[i].dataset.k;
      if (k === skipK) continue;
      var b = blocks[i].getBoundingClientRect();
      if (x < b.left + b.width / 2) { at = k; cx = b.left; cy = b.top; ch = b.height; break; }
    }
    if (cx == null) {
      var last = blocks.filter(function (e) { return +e.dataset.k !== skipK; }).pop();
      if (last) { var lb = last.getBoundingClientRect(); cx = lb.right; cy = lb.top; ch = lb.height; } else { cx = r.left + 14; cy = r.top + 40; ch = r.height - 60; }
    }
    return { at: at, x: cx - r.left, y: cy - r.top, h: ch };
  }
  function wizCaret(d) {
    var c = $("wizCaret");
    if (!d) { c.hidden = true; return; }
    c.hidden = false;
    c.style.top = d.y + "px"; c.style.height = d.h + "px"; c.style.bottom = "auto";
    c.style.transform = "translateX(" + (d.x - 3) + "px)";
  }
  $("wizLane").addEventListener("pointerdown", function (e) {
    if (e.target.closest(".ae-x") || e.button > 0) return;
    var b = e.target.closest(".ae-block");
    if (b) wiz.drag = { kind: "block", ref: +b.dataset.k, src: b, x0: e.clientX, y0: e.clientY, on: false, id: e.pointerId };
  });
  $("wizSongs").addEventListener("pointerdown", function (e) {
    var c = e.target.closest(".ae-chip");
    if (c && e.button <= 0) wiz.drag = { kind: "chip", ref: { s: +c.dataset.s, j: +c.dataset.j }, src: c, x0: e.clientX, y0: e.clientY, on: false, id: e.pointerId };
  });
  window.addEventListener("pointermove", function (e) {
    var d = wiz.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.on) {
      if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < 7) return;
      d.on = true;
      var r = d.src.getBoundingClientRect();
      d.dx = d.x0 - r.left; d.dy = d.y0 - r.top;
      d.ghost = d.src.cloneNode(true);
      d.ghost.classList.add("ae-ghost");
      d.ghost.style.width = r.width + "px"; d.ghost.style.height = r.height + "px";
      var c0 = d.src.querySelector("canvas"), c1 = d.ghost.querySelector("canvas");
      if (c0 && c1) { c1.width = c0.width; c1.height = c0.height; try { c1.getContext("2d").drawImage(c0, 0, 0); } catch (er) { } }
      document.body.appendChild(d.ghost);
      if (d.kind === "block") d.src.classList.add("is-lifted");
      try { d.src.setPointerCapture(d.id); } catch (er) { }
    }
    e.preventDefault();
    d.ghost.style.transform = "translate(" + (e.clientX - d.dx) + "px," + (e.clientY - d.dy) + "px) rotate(-1.5deg) scale(1.04)";
    d.drop = wizDropAt(e.clientX, e.clientY, d.kind === "block" ? d.ref : -1);
    wizCaret(d.drop);
  }, { passive: false });
  function wizEnd(e) {
    var d = wiz.drag;
    if (!d || (e && e.pointerId !== d.id)) return;
    wiz.drag = null;
    wizCaret(null);
    if (d.ghost) d.ghost.remove();
    if (d.src) d.src.classList.remove("is-lifted");
    if (!d.on) {
      if (d.kind === "chip") wizInsert([d.ref], null);
      else { wiz.sel = wiz.sel === d.ref ? -1 : d.ref; renderWizard(); }
      return;
    }
    if (!d.drop || (e && e.type === "pointercancel")) return;
    if (d.kind === "chip") wizInsert([d.ref], d.drop.at);
    else wizMove(d.ref, d.drop.at);
  }
  window.addEventListener("pointerup", wizEnd);
  window.addEventListener("pointercancel", wizEnd);
  $("wizLane").addEventListener("click", function (e) {
    var x = e.target.closest(".ae-x");
    if (x) wizRemove(+x.closest(".ae-block").dataset.k);
  });
  $("wizSongs").addEventListener("click", function (e) {
    var a = e.target.closest(".ws-all");
    if (!a) return;
    var si = +a.dataset.s, sg = songs()[si];
    wizInsert(sg.sections.map(function (_, j) { return { s: si, j: j }; }), null);
  });
  window.addEventListener("keydown", function (e) {
    if (!wiz.open || wiz.sel < 0 || /input|select|textarea/i.test(e.target.tagName)) return;
    if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); wizRemove(wiz.sel); }
  });
  function wizKeyStep(d) {
    if (wiz.key == null) { var f = wizFirstSong(), r = songRoot(f); wiz.key = r == null ? 0 : r; }
    wiz.key = ((wiz.key + d) % 12 + 12) % 12;
    wiz.keyTouched = true;
    renderWizard();
  }
  $("wizKeyDown").addEventListener("click", function () { wizKeyStep(-1); });
  $("wizKeyUp").addEventListener("click", function () { wizKeyStep(1); });
  function wizBpmSet(v) {
    v = Math.round(Math.max(30, Math.min(260, v)) * 10) / 10;
    if (!isFinite(v)) return;
    wiz.bpm = v;
    wiz.bpmTouched = true;
    renderWizard();
  }
  $("wizBpmDown").addEventListener("click", function () { wizBpmSet((wiz.bpm || 100) - 1); });
  $("wizBpmUp").addEventListener("click", function () { wizBpmSet((wiz.bpm || 100) + 1); });
  $("wizBpm").addEventListener("change", function () { var v = parseFloat(this.value.replace(",", ".")); if (v > 0) wizBpmSet(v); else renderWizard(); });
  $("wizTr").addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) { wiz.tr = +b.dataset.v; setSeg("wizTr", wiz.tr); } });

  function postMedley(body) {
    return fetch("/medley", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }).catch(function () { return { ok: false }; });
  }
  $("wizSave").addEventListener("click", function () {
    if (!wiz.list.length) return;
    var semis = {}, slots = wiz.list.map(function (x) {
      var sg = songs()[x.s];
      semis[sg.name] = wizSemis(x.s);
      return { song: sg.name, sec: x.j, name: sg.sections[x.j].name };
    });
    var f = wizFirstSong();
    // a new medley goes into the setlist right before its first song
    var at = -1;
    if (wiz.mi < 0) { var p = order().indexOf(wiz.list[0].s); at = p >= 0 ? p : -1; }
    postMedley({ action: "save", at: at, medley: { id: wiz.id || ("m" + Date.now().toString(36)), name: $("wizName").value.trim() || T("medDefaultName", { n: medleys().length + 1 }),
      bpm: wiz.bpm || 0, key: wizKeyLabel(), voice: f ? f.name : "", tr: wiz.tr, slots: slots, semis: semis } });
    closeWizard();
  });
  $("wizDelete").addEventListener("click", function () {
    if (!wiz.delArmed) { wiz.delArmed = true; this.textContent = T("medDeleteSure"); return; }
    postMedley({ action: "delete", id: wiz.id });
    closeWizard();
  });

  // the docked mixer edits the selected section's automation
  function autoMode() { return isConsole() && sm.edit && sm.sel >= 0 && songs()[shownIdx]; }
  function updateAutoMode() {
    var on = !!autoMode();
    $("dockAuto").hidden = !on;
    $("dock").classList.toggle("automating", on);
    if (on) {
      var sec = songs()[shownIdx].sections[sm.sel];
      $("dockAutoText").textContent = T("autoFor", { name: sec ? sec.name : "" });
      if (!dockOpen) { dockOpen = true; placeMixer(); }
    }
    $("mixStrips").dataset.k = "";
    renderMixer();
  }
  function autoEntry(name) {
    var s = songs()[shownIdx], a = s && s.auto && s.auto[sm.sel];
    return a ? a[normName(name)] || null : null;
  }
  $("dockAutoClear").addEventListener("click", function () { if (autoMode()) send("autoclear", shownIdx, sm.sel, -1); });
  $("dockAutoDone").addEventListener("click", function () { sm.sel = -1; updateAutoMode(); render(); });

  function sectionState(j) {
    var st = { current: false, queued: false, landing: false, loop: false, past: false };
    if (!pos) return st;
    var here = pos.song === shownIdx;
    st.current = here && pos.sec === j;
    st.past = here && pos.playing && pos.sec > j;
    // the arrangement's or medley's own next section is not a jump the user asked for
    st.queued = pos.qSong === shownIdx && pos.qSec === j && (!pos.qAuto || !!pos.qFired);
    st.landing = st.queued && pos.qFired;
    st.loop = pos.loopSong === shownIdx && pos.loopSec === j && !!pos.liveLoop;
    return st;
  }

  function updateSongState() {
    var s = songs()[shownIdx];
    if (!s) return;
    var pads = $("tiles").children;
    var segs = $("strip").querySelectorAll(".seg");
    for (var j = 0; j < s.sections.length; j++) {
      var st = sectionState(j);
      var pad = pads[j], seg = segs[j];
      if (!pad || !seg) continue;
      pad.classList.toggle("is-current", st.current);
      pad.classList.toggle("is-live", st.current && !!pos.playing);
      pad.classList.toggle("is-queued", st.queued && !st.landing);
      pad.classList.toggle("is-landing", st.landing);
      pad.classList.toggle("is-loop", st.loop);
      pad.classList.toggle("is-past", st.past);
      seg.classList.toggle("is-current", st.current);
      seg.classList.toggle("is-past", st.past);
      seg.classList.toggle("is-queued", st.queued);
      seg.classList.toggle("is-loop", st.loop);
      var tag = st.queued ? (st.landing ? T("badgeJumping") : T("badgeQueued")) : st.loop ? (pos.loopOnce ? "1×" : "∞") : "";
      pad.querySelector(".p-tag").textContent = tag;
    }
    updateHero(s);
    updateSongmap(s);
    drawArc();
  }

  // what plays now, what comes after it, and how it gets there
  function nextInfo(s, j) {
    if (!pos) return null;
    if (pos.qSong >= 0 && songs()[pos.qSong]) {
      var qs = songs()[pos.qSong], qsec = qs.sections[pos.qSec];
      // the arrangement's own next section is not a jump the user asked for
      if (pos.qAuto && qsec) return { kind: "nextK", name: qsec.name, c: color(qsec.name) };
      return { kind: pos.qFired ? "jumpingK" : "jumpK", name: (pos.qSong !== shownIdx ? qs.name + ": " : "") + (qsec ? qsec.name : ""), c: qsec ? color(qsec.name) : "", cancel: !pos.qFired };
    }
    if (pos.liveLoop && pos.loopSong === shownIdx && pos.loopSec === j && pos.song === shownIdx) {
      return { kind: pos.loopOnce ? "onceK" : "loopK", name: s.sections[j].name, c: color(s.sections[j].name) };
    }
    var L = sm.lay;
    if (L && L.med) {
      var cmi = curItem(L) || (pos.med !== shownMed ? null : L.items[pos.medK]);
      var nmi = cmi ? L.items[cmi.k + 1] : L.items[0];
      if (nmi) return { kind: "nextK", name: (nmi.s !== (cmi ? cmi.s : -1) ? songs()[nmi.s].name + ": " : "") + nmi.sec.name, c: color(nmi.sec.name) };
      var nxm = nextSongIdx(shownIdx);
      if (nxm < 0) return { kind: "endK", name: "", c: "" };
      var nnm = isMed(nxm) ? (medleys()[nxm - MED] || {}).name : songs()[nxm].name;
      var mm2 = (medleys()[shownMed] || {}).tr || 1;
      return mm2 >= 3 ? { kind: "nextSongK", name: nnm, c: "", mode: 3 } : { kind: "stopsK", name: nnm, c: "", mode: 1, quiet: true };
    } else if (L && L.edited && s === songs()[shownIdx]) {
      var ci = curItem(L) || (pos.song !== shownIdx ? L.items[0] : null);
      var ni = ci ? L.items[ci.k + 1] : null;
      if (!ci) { for (var i = 0; i < L.items.length; i++) if (L.items[i].j > j) { ni = L.items[i]; break; } }
      if (pos.song !== shownIdx && L.items[0]) ni = L.items[1] || null;
      if (ni) return { kind: "nextK", name: ni.sec.name, c: color(ni.sec.name) };
    } else if (j + 1 < s.sections.length) return { kind: "nextK", name: s.sections[j + 1].name, c: color(s.sections[j + 1].name) };
    var nx = nextSongIdx(shownIdx);
    if (nx < 0) return { kind: "endK", name: "", c: "" };
    var m = trEff(s);
    if (tailMissing(m)) m = 3;
    if (isMed(nx)) {
      var nmd = medleys()[nx - MED] || { name: "" };
      if (m >= 3) return { kind: "nextSongK", name: nmd.name, c: "", mode: 3 };
      return { kind: "stopsK", name: nmd.name, c: "", mode: m, quiet: true };
    }
    var ns = songs()[nx];
    if (m >= 3) return { kind: "nextSongK", name: ns.name, c: ns.sections[0] ? color(ns.sections[0].name) : "", mode: m };
    return { kind: "stopsK", name: ns.name, c: "", mode: m, quiet: true };
  }

  function swapIn(el) {
    if (reduceMotion || !el.animate) return;
    el.animate([{ opacity: 0, transform: "translateY(22px)", filter: "blur(6px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }],
      { duration: 420, easing: "cubic-bezier(.16,1,.3,1)" });
  }

  var heroSong = -1;
  function updateHero(s) {
    var here = pos && pos.song === shownIdx;
    var j = here ? pos.sec : 0;
    var sec = s.sections[j];
    if (!sec) return;
    var playing = !!(pos && pos.playing && here);
    var now = $("nowPanel");
    now.style.setProperty("--c", color(sec.name));
    now.classList.toggle("is-live", playing);
    $("nowLabel").textContent = playing ? T("nowK") : T("nowReady");
    if ($("curName").textContent !== sec.name) {
      $("curName").textContent = sec.name;
      swapIn($("curName"));
    }
    var looping = pos && pos.liveLoop && pos.loopSong === shownIdx && pos.loopSec === j;
    $("actLoop").classList.toggle("on", !!(looping && !pos.loopOnce));
    $("actRepeat").classList.toggle("on", !!(looping && pos.loopOnce));
    $("actLoop").disabled = $("actRepeat").disabled = !playing;

    var n = nextInfo(s, j);
    var next = $("nextPanel");
    next.className = "next k-" + (n ? n.kind : "none") + (n && n.quiet ? " quiet" : "");
    next.style.setProperty("--c", (n && n.c) || "var(--faint)");
    $("nextLabel").textContent = n ? T(n.kind) : "";
    var nm = n ? (n.mode ? TR_ICON[n.mode] : "") + "<span>" + esc(n.name) + "</span>" : "";
    if ($("nextName").dataset.k !== nm) { $("nextName").dataset.k = nm; $("nextName").innerHTML = nm; swapIn($("nextName")); }
    $("btnCancel").hidden = !(n && n.cancel);
    $("tnDot").style.background = color(sec.name);
    $("tnCur").textContent = sec.name;
    $("tnNext").textContent = n ? (n.kind === "endK" ? T("endK") : n.name) : "";
    $("tNow").className = "t-now k-" + (n ? n.kind : "none");
    var cueOn = !!(cue && cue.text && pos && pos.playing && cue.speak);
    $("nextCue").hidden = !cueOn;
    $("nextCue").title = T("cueVoice");
    if (heroSong !== shownIdx) { heroSong = shownIdx; BEATS_DONE = -1; }
  }

  function drawArc() {
    var svg = $("arc");
    var s = songs()[shownIdx];
    if (!s || !pos || pos.qSong !== shownIdx || pos.song !== shownIdx || pos.qSec === pos.sec + 1) { svg.innerHTML = ""; return; }
    var w = $("strip").clientWidth;
    var len = s.end - s.start;
    var from = s.sections[pos.sec];
    var to = s.sections[pos.qSec];
    if (!from || !to) { svg.innerHTML = ""; return; }
    var x1 = ((from.end - s.start) / len) * w;
    var x2 = ((to.start - s.start) / len) * w + 6;
    var h = 26;
    svg.setAttribute("viewBox", "0 0 " + w + " 34");
    svg.innerHTML = '<path d="M' + x1 + " 32 C " + x1 + " " + (32 - h) + ", " + x2 + " " + (32 - h) + ", " + x2 + ' 32"/>' +
      '<polygon class="arc-head" points="' + (x2 - 5) + ",25 " + (x2 + 5) + ",25 " + x2 + ',34"/>';
  }

  // ------------------------------------------------------------ status

  function updateStatus() {
    var s = songs()[shownIdx];
    var text, cls = "", showCancel = false;
    if (!pos || !s) { text = struct ? T("statusNoSongs") : T("statusWaiting"); }
    else if (pos.qSong >= 0) {
      var tgt = songs()[pos.qSong] && songs()[pos.qSong].sections[pos.qSec];
      var tname = tgt ? tgt.name : "";
      if (pos.qSong !== pos.song) tname = songs()[pos.qSong].name + ": " + tname;
      var cur = pos.song >= 0 ? songs()[pos.song].sections[pos.sec] : null;
      if (pos.qFired) text = T("statusJumping", { target: tname });
      else text = cur ? T("statusQueued", { cur: cur.name, target: tname }) : T("statusNextBar", { target: tname });
      cls = "queued";
      showCancel = !pos.qFired;
    } else if (pos.loopSong >= 0 && pos.liveLoop) {
      var ls = songs()[pos.loopSong] && songs()[pos.loopSong].sections[pos.loopSec];
      text = ls ? (pos.loopOnce ? T("statusLoopOnce", { name: ls.name }) : T("statusLoop", { name: ls.name })) : T("statusLoopGeneric");
      cls = "loop";
    } else if (pos.playing) {
      var nx = nextSongIdx(pos.song);
      var trm = shownMed >= 0 ? ((medleys()[shownMed] || {}).tr || 1) : trEff(songs()[pos.song]);
      if (tailMissing(trm)) trm = 3;
      var nxName = nx < 0 ? "" : isMed(nx) ? (medleys()[nx - MED] || {}).name : songs()[nx].name;
      if (nx < 0) text = T("statusLast");
      else text = T({ 1: "statusTrCue", 2: "statusTrStay", 3: "statusTrLink", 4: "statusTrOverlap", 5: "statusTrXfade" }[trm], { name: nxName });
    } else {
      text = T("statusIdle");
    }
    $("statusText").textContent = text;
    $("tStatus").className = "t-status " + cls;
    $("tStatus").dataset.cancel = showCancel ? "1" : "";

    var nxi = nextSongIdx(shownIdx);
    $("nextSong").textContent = nxi >= 0 ? (isMed(nxi) ? (medleys()[nxi - MED] || {}).name : songs()[nxi].name) : T("endOfSetlist");
    $("tNext").classList.toggle("override", !!pos && pos.pendingSong >= 0);

    var playing = !!(pos && pos.playing);
    $("btnPlay").classList.toggle("is-playing", playing);
    var fd = pos ? pos.fade : 0;
    $("btnFadeOut").classList.toggle("on", fd === 1);
    $("btnFadeIn").classList.toggle("on", fd === 2);
    $("btnFadeIn").disabled = !fd;
    $("app").classList.toggle("counting-in", !!(pos && pos.countIn));
    $("app").classList.toggle("is-playing", playing);
    $("liveChip").classList.toggle("playing", playing);
    $("liveText").textContent = connected ? (playing ? T("live") : T("connected")) : T("offline");
    if (pos) {
      $("tempo").textContent = fmtBpm(pos.tempo);
      $("meter").textContent = pos.sigNum + "/" + pos.sigDen;
    }
    var key = s && (keyName(s.key, s.semis) || (s.semis ? semisLabel(s.semis) : ""));
    if (shownMed >= 0 && medleys()[shownMed] && medleys()[shownMed].key) key = medleys()[shownMed].key;
    $("keyStat").hidden = !key;
    if (key) $("key").textContent = key;
    $("keyStat").classList.toggle("mod", !!(s && s.semis));
    $("statTempo").classList.toggle("mod", !!(s && s.tempoSet));
  }

  // ------------------------------------------------------------ settings

  function setSeg(id, v) {
    Array.prototype.forEach.call($(id).children, function (b) {
      b.setAttribute("aria-checked", String(String(b.dataset.v) === String(v)));
    });
  }

  function updateSettings() {
    var st = (struct && struct.settings) || { cueMode: 2, cueBars: 1, cueLang: 2 };
    setSeg("optCueMode", st.cueMode);
    setSeg("optCueBars", st.cueBars);
    setSeg("optCueLang", st.cueLang);
    setSeg("optCueStyle", st.cueStyle || 0);
    setSeg("optCueSource", st.cueSource == null ? 1 : st.cueSource);
    setSeg("countIn", st.precount || 0);
    setSeg("optLang", window.SPI18N.lang);
    $("cueModeHelp").textContent = T(["cueHelpOff", "cueHelpFix", "cueHelpAll"][st.cueMode] || "cueHelpAll");
    $("voiceInfo").textContent = voice && voice.name ? T("voiceName", { name: voice.name }) : "";

    var c = (struct && struct.click) || {};
    $("optClickOn").checked = c.on !== 0;
    $("optClickMute").checked = c.muteSong !== 0;
    setSeg("optClickSound", c.sound || 0);
    setSeg("optClickSub", c.sub || 1);
    var levels = [c.acc, c.beat, c.subl, c.gain];
    Array.prototype.forEach.call(document.querySelectorAll("[data-level]"), function (r) {
      if (document.activeElement !== r) r.value = levels[+r.dataset.level] != null ? levels[+r.dataset.level] : 100;
    });
    renderAccents(c.accents || [2, 1, 1, 1]);
    renderTrDefault();
    renderSetup();
  }

  function renderOutputs() {
    var list = (routes && routes.list) || [], outs = (routes && routes.outputs) || {};
    $("optOutputs").innerHTML = KINDS.map(function (k, ki) {
      var cur = outs[k], selIdx = -1;
      if (cur) list.forEach(function (r, i) { if (r.type === cur.type && (r.chan || "") === (cur.chan || "")) selIdx = i; });
      var opts = '<option value="-1">' + esc(T("outKeep")) + "</option>" + list.map(function (r, i) {
        return '<option value="' + i + '"' + (i === selIdx ? " selected" : "") + ">" + esc(r.label) + "</option>";
      }).join("");
      if (cur && selIdx < 0) opts += "<option selected disabled>" + esc(cur.type + " " + (cur.chan || "")) + "</option>";
      return '<label class="instr-row"><span>' + esc(kindLabel(k)) + '</span><select class="sel" data-k="' + ki + '">' + opts + "</select></label>";
    }).join("");
  }
  $("optOutputs").addEventListener("change", function (e) {
    var sel = e.target.closest("select");
    if (sel) send("setoutput", +sel.dataset.k, +sel.value);
  });
  $("btnApplyOutputs").addEventListener("click", function () { send("applyoutputs"); });

  function renderAccents(acc) {
    var n = pos ? pos.sigNum : acc.length;
    var html = "";
    for (var i = 0; i < n; i++) {
      var v = acc[i] != null ? acc[i] : (i === 0 ? 2 : 1);
      var cls = v === 2 ? "acc" : v === 0 ? "off" : "";
      html += '<button class="beat ' + cls + '" data-b="' + i + '" data-v="' + v + '">' + (i + 1) + "</button>";
    }
    $("optAccents").innerHTML = html;
  }

  function renderSetup() {
    var comp = (struct && struct.companions) || {};
    var g = (struct && struct.guide) || {};
    var rows = [
      [true, T("setupCues"), ""],
      [!!comp.click, T("setupClick"), comp.click ? (g.clicks && g.clicks.length ? T("setupClickTracks", { names: g.clicks.join(", ") }) : "") : T("setupMissingClick")],
      [!!comp.tail, T("setupTail"), comp.tail ? "" : T("setupMissingTail")],
      [!!comp.gate, T("setupGuide"), comp.gate ? "" : (g.tracks && g.tracks.length ? T("setupMissingGuide", { names: g.tracks.join(", ") }) : T("setupMissingGuideNone"))]
    ];
    $("setupList").innerHTML = rows.map(function (r) {
      return '<li class="' + (r[0] ? "ok" : "missing") + '"><span class="mark">' + (r[0] ? "✓" : "!") + "</span><div><strong>" +
        esc(r[1]) + "</strong>" + (r[2] ? "<small>" + esc(r[2]) + "</small>" : "") + "</div></li>";
    }).join("");
  }

  function bindSeg(id, cmd, numeric) {
    $(id).addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      setSeg(id, b.dataset.v);
      send(cmd, numeric === false ? b.dataset.v : +b.dataset.v);
    });
  }
  bindSeg("optCueMode", "cuemode");
  bindSeg("optCueBars", "cuebars");
  bindSeg("optCueLang", "cuelang");
  bindSeg("optCueStyle", "cuestyle");
  bindSeg("optCueSource", "cuesource");
  bindSeg("optClickSound", "clicksound");
  bindSeg("optClickSub", "clicksub");

  $("optLang").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    window.SPI18N.setLang(b.dataset.v);
    renderedKey = "";
    render();
    updateSettings();
    $("addr").textContent = T("openOn", { addr: location.host });
  });

  $("optAccents").addEventListener("click", function (e) {
    var b = e.target.closest(".beat");
    if (!b) return;
    var next = { 2: 1, 1: 0, 0: 2 }[+b.dataset.v];
    b.dataset.v = next;
    b.className = "beat " + (next === 2 ? "acc" : next === 0 ? "off" : "");
    send("clickaccent", +b.dataset.b, next);
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-level]"), function (r) {
    r.addEventListener("change", function () { send("clicklevel", +r.dataset.level, +r.value); });
  });
  $("optClickOn").addEventListener("change", function () { send("clickon", this.checked ? 1 : 0); });
  $("optClickMute").addEventListener("change", function () { send("clickmute", this.checked ? 1 : 0); });

  function updateCue() {
    var s = songs()[shownIdx];
    if (s) updateHero(s);
  }

  // ------------------------------------------------------------ tempo and key

  var tk = { s: -1, taps: [] };

  function openTk(focus) {
    var s = songs()[shownIdx];
    if (!s) return;
    tk.s = shownIdx;
    tk.taps = [];
    renderTk();
    $("tkSheet").hidden = false;
    var target = focus === "key" ? document.querySelector("#tkSheet [data-semis]") : $("tkSlider");
    if (target) target.focus();
  }

  function tkLocked() { return !!(pos && pos.playing && pos.song === tk.s); }
  function updateTkLock() {
    var locked = tkLocked();
    $("tkSheet").classList.toggle("locked", locked);
    $("tkLock").hidden = !locked;
  }
  function renderTk() {
    var s = songs()[tk.s];
    if (!s) return;
    updateTkLock();
    $("tkTitle").textContent = s.name;
    var base = baseBpm(s) || (pos && pos.tempo) || 120;
    var cur = effBpm(s);
    $("tkTempo").textContent = fmtBpm(cur);
    $("tkTempoOrig").textContent = T("original", { v: fmtBpm(base) });
    var sl = $("tkSlider");
    sl.min = Math.round(base * 0.8 * 2) / 2;
    sl.max = Math.round(base * 1.2 * 2) / 2;
    if (document.activeElement !== sl) sl.value = cur;
    $("tkTempoReset").disabled = !s.tempoSet;

    var semis = s.semis || 0;
    var k = keyName(s.key, semis);
    $("tkKey").textContent = k || semisLabel(semis);
    $("tkSemis").textContent = k ? (semis ? semisLabel(semis) : "") : T("transpose");
    $("tkKeyOrig").textContent = s.key ? T("original", { v: s.key }) : "";
    $("tkKeyReset").disabled = !semis;
    var p = parseKey(s.key);
    if (p) {
      var html = "";
      for (var i = -5; i <= 6; i++) {
        var name = KEYS[((p.root + i) % 12 + 12) % 12] + p.minor;
        html += '<button class="tk-key' + (i === semis ? " on" : "") + (i === 0 ? " orig" : "") + '" data-to="' + i + '">' + name + "<small>" + semisLabel(i) + "</small></button>";
      }
      $("tkKeys").innerHTML = html;
      $("tkKeys").hidden = false;
    } else {
      $("tkKeys").hidden = true;
    }
  }

  function setTempo(v) {
    var s = songs()[tk.s];
    if (!s || tkLocked()) return;
    v = Math.max(20, Math.min(300, Math.round(v * 10) / 10));
    var base = baseBpm(s);
    s.tempoSet = base && Math.abs(v - base) < 0.05 ? 0 : v;
    send("temposet", tk.s, s.tempoSet ? Math.round(v * 10) : 0);
    renderTk();
    updateStatus();
  }

  function setSemis(n) {
    var s = songs()[tk.s];
    if (!s || tkLocked()) return;
    n = Math.max(-12, Math.min(12, n));
    s.semis = n;
    send("keyset", tk.s, n);
    renderTk();
    updateStatus();
  }

  $("statTempo").addEventListener("click", function () { openTk("tempo"); });
  $("keyStat").addEventListener("click", function () { openTk("key"); });
  $("tkClose").addEventListener("click", function () { $("tkSheet").hidden = true; });
  $("tkSheet").addEventListener("click", function (e) {
    if (e.target === $("tkSheet")) { $("tkSheet").hidden = true; return; }
    var t = e.target.closest("[data-tempo]");
    if (t) { setTempo(effBpm(songs()[tk.s]) + +t.dataset.tempo); return; }
    var k = e.target.closest("[data-semis]");
    if (k) { setSemis((songs()[tk.s].semis || 0) + +k.dataset.semis); return; }
    var to = e.target.closest("[data-to]");
    if (to) setSemis(+to.dataset.to);
  });
  $("tkSlider").addEventListener("input", function () { $("tkTempo").textContent = fmtBpm(+this.value); });
  $("tkSlider").addEventListener("change", function () { setTempo(+this.value); });
  $("tkTempoReset").addEventListener("click", function () { var s = songs()[tk.s]; setTempo(baseBpm(s) || effBpm(s)); });
  $("tkKeyReset").addEventListener("click", function () { setSemis(0); });
  $("tkTap").addEventListener("click", function () {
    var now = performance.now();
    if (tk.taps.length && now - tk.taps[tk.taps.length - 1] > 2000) tk.taps = [];
    tk.taps.push(now);
    if (tk.taps.length > 5) tk.taps.shift();
    if (tk.taps.length >= 3) {
      var span = (tk.taps[tk.taps.length - 1] - tk.taps[0]) / (tk.taps.length - 1);
      setTempo(Math.round(60000 / span * 2) / 2);
    }
  });

  // ------------------------------------------------------------ add song

  var add = { sessions: [], pick: null, gap: 4, busy: false };
  function showAddPane(name) {
    $("addPick").hidden = name !== "pick";
    $("addForm").hidden = name !== "form";
    $("addProgress").hidden = name !== "progress";
  }
  function openAdd() {
    $("addSheet").hidden = false;
    if (add.busy) { showAddPane("progress"); return; }
    showAddPane("pick");
    $("dropNote").textContent = "";
    $("sessions").innerHTML = "<li class='set-help'>" + esc(T("addLoading")) + "</li>";
    fetch("/import/list").then(function (r) { return r.json(); }).then(function (d) {
      add.sessions = d.sessions || [];
      add.gap = [2, 4, 8].indexOf(d.gap) >= 0 ? d.gap : 4;
      if (!add.sessions.length) { $("sessions").innerHTML = "<li class='set-help'>" + esc(T("addNone")) + "</li>"; return; }
      $("sessions").innerHTML = add.sessions.map(function (x, i) {
        var chips = (x.key ? "<span>" + esc(x.key) + "</span>" : "") + (x.bpm ? "<span>" + fmtBpm(x.bpm) + " BPM</span>" : "");
        return '<li class="session" data-i="' + i + '"><div><strong>' + esc(x.title) + "</strong><small>" + esc(x.folder) + " · " +
          new Date(x.mtime).toLocaleDateString() + '</small></div><div class="chips">' + chips + "</div></li>";
      }).join("");
    }).catch(function () { $("sessions").innerHTML = "<li class='set-help'>" + esc(T("addNone")) + "</li>"; });
  }
  $("btnAddSong").addEventListener("click", openAdd);
  $("addClose").addEventListener("click", function () { $("addSheet").hidden = true; });
  $("addSheet").addEventListener("click", function (e) { if (e.target === $("addSheet")) $("addSheet").hidden = true; });
  $("sessions").addEventListener("click", function (e) {
    var li = e.target.closest(".session");
    if (!li) return;
    pickSession(add.sessions[+li.dataset.i]);
  });
  function pickSession(x) {
    add.pick = x;
    add.instr = null;
    $("addInstr").innerHTML = "<small class='set-help'>" + esc(T("addLoading")) + "</small>";
    fetch("/import/peek", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: x.path }) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r.ok) { $("addInstr").innerHTML = ""; return; }
        add.instr = {};
        $("addInstr").innerHTML = r.tracks.map(function (t, i) {
          add.instr[t.name] = t.instr;
          return '<label class="instr-row"><span>' + esc(t.name) + '</span><select class="sel" data-t="' + i + '">' + kindOptions(t.instr) + "</select></label>";
        }).join("");
        add.instrNames = r.tracks.map(function (t) { return t.name; });
      })
      .catch(function () { $("addInstr").innerHTML = ""; });
    $("addName").value = add.pick.title;
    $("addKey").value = add.pick.key || "";
    $("addBpm").value = add.pick.bpm || "";
    setSeg("addGap", add.gap);
    $("addNote").textContent = pos && pos.playing ? T("addStopFirst") : "";
    showAddPane("form");
  }

  // A Live Set dragged from Finder. The browser never gives the file's path,
  // only its name, size and date, so the server finds it on the Mac.
  function alsFromEntry(entry, depth) {
    return new Promise(function (resolve) {
      if (!entry) return resolve(null);
      if (entry.isFile) {
        if (!/\.als$/i.test(entry.name)) return resolve(null);
        entry.file(function (f) { resolve(f); }, function () { resolve(null); });
        return;
      }
      if (!entry.isDirectory || depth > 3) return resolve(null);
      var reader = entry.createReader(), all = [];
      (function more() {
        reader.readEntries(function (list) {
          if (list.length) { all = all.concat(list); more(); return; }
          all.sort(function (a, b) { return (b.isFile ? 1 : 0) - (a.isFile ? 1 : 0); });
          (function next(k) {
            if (k >= all.length) return resolve(null);
            if (/^(Backup|Ableton Project Info|Samples)$/.test(all[k].name)) return next(k + 1);
            alsFromEntry(all[k], depth + 1).then(function (f) { if (f) resolve(f); else next(k + 1); });
          })(0);
        }, function () { resolve(null); });
      })();
    });
  }
  function findDropped(f) {
    if (!f) { $("dropNote").textContent = T("dropNoAls"); return; }
    $("dropNote").textContent = T("dropLooking", { name: f.name });
    fetch("/import/find", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: f.name, size: f.size, mtime: f.lastModified }) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r.ok && r.session) { $("dropNote").textContent = ""; pickSession(r.session); }
        else $("dropNote").textContent = T("dropNotFound", { name: f.name });
      })
      .catch(function () { $("dropNote").textContent = T("dropNotFound", { name: f.name }); });
  }
  var dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0; }
  window.addEventListener("dragenter", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add("dragging-file");
    if ($("addSheet").hidden && !add.busy) openAdd();
  });
  window.addEventListener("dragleave", function () { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging-file"); } });
  window.addEventListener("dragover", function (e) { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  window.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging-file");
    if (add.busy) return;
    if ($("addSheet").hidden) openAdd();
    showAddPane("pick");
    var item = e.dataTransfer.items && e.dataTransfer.items[0];
    var entry = item && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry) alsFromEntry(entry, 0).then(findDropped);
    else findDropped(e.dataTransfer.files[0] && /\.als$/i.test(e.dataTransfer.files[0].name) ? e.dataTransfer.files[0] : null);
  });
  $("dropZone").addEventListener("click", function () { $("dropFile").click(); });
  $("dropFile").addEventListener("change", function () { if (this.files[0]) findDropped(this.files[0]); this.value = ""; });
  $("addInstr").addEventListener("change", function (e) {
    var sel = e.target.closest("select");
    if (sel && add.instr) add.instr[add.instrNames[+sel.dataset.t]] = sel.value;
  });
  $("addGap").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    add.gap = +b.dataset.v;
    setSeg("addGap", add.gap);
  });
  $("addBack").addEventListener("click", function () { showAddPane("pick"); });
  $("addGo").addEventListener("click", function () {
    if (!add.pick) return;
    if (pos && pos.playing) { $("addNote").textContent = T("addStopFirst"); return; }
    var body = { path: add.pick.path, title: $("addName").value.trim(), key: $("addKey").value.trim(), bpm: +$("addBpm").value || 0, gap: add.gap, instr: add.instr || undefined };
    fetch("/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r.ok) { $("addNote").textContent = T("addFailed", { why: whyText(r.error) }); return; }
        add.busy = true;
        add.title = r.title;
        $("addStatus").textContent = T("addWorking", { title: r.title }) + (r.missing ? " " + T("addMissing", { n: r.missing }) : "");
        $("addBar").style.width = "4%";
        showAddPane("progress");
      });
  });
  function whyText(code) {
    return T({ busy: "whyBusy", playing: "whyPlaying", parse: "whyParse", not_found: "whyNotFound", no_audio: "whyNoAudio", no_als: "whyNoAls" }[code] || "whyParse");
  }
  function onImport(m) {
    if (m.kind === "start") { add.busy = true; add.title = m.a; $("addSheet").hidden = false; showAddPane("progress"); $("addStatus").textContent = T("addWorking", { title: m.a }); }
    else if (m.kind === "progress") { $("addBar").style.width = Math.round(100 * (+m.a) / (+m.b || 1)) + "%"; }
    else if (m.kind === "done") {
      add.busy = false;
      $("addBar").style.width = "100%";
      var ok = +m.b || 0, tot = +m.c || 0;
      $("addStatus").textContent = tot ? (ok === tot ? T("addChecked", { title: m.a, total: tot }) : T("addCheckedBad", { title: m.a, bad: tot - ok, total: tot })) : T("addDone", { title: m.a });
    }
    else if (m.kind === "error") { add.busy = false; $("addSheet").hidden = false; showAddPane("progress"); $("addBar").style.width = "0"; $("addStatus").textContent = T("addFailed", { why: whyText(m.a) }); }
  }

  // ------------------------------------------------------------ notices
  // Short messages from SetPilot (a fixed song, cues found in a guide): they
  // slide in at the bottom and leave on their own.
  function notice(n) {
    var txt = "", warn = false;
    if (n.kind === "warpfixed") { warn = +n.c > 0; txt = T(warn ? "ntWarpStill" : (+n.b === 1 ? "ntWarpFixed1" : "ntWarpFixed"), { song: n.a, n: n.b, still: n.c }); }
    else if (n.kind === "warpnoref") { warn = true; txt = T("ntWarpNoRef", { song: n.a }); }
    else if (n.kind === "guideready") txt = +n.b > 0 ? T("ntGuide", { song: n.a, found: n.b, total: n.c }) : T("ntGuideNone", { song: n.a });
    if (!txt) return;
    var box = $("toasts"), el = document.createElement("div");
    el.className = "toast" + (warn ? " warn" : "");
    el.textContent = txt;
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    if (!reduceMotion && el.animate) el.animate([{ opacity: 0, transform: "translateY(14px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(.16,1,.3,1)" });
    setTimeout(function () {
      var gone = function () { if (el.parentNode) el.parentNode.removeChild(el); };
      if (!reduceMotion && el.animate) el.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(8px)" }], { duration: 260, easing: "ease-in", fill: "forwards" }).onfinish = gone;
      else gone();
    }, warn ? 9000 : 6000);
  }

  // ------------------------------------------------------------ animation frame

  var lastBeatKey = "";
  function frame(ts) {
    requestAnimationFrame(frame);
    drawMeters(ts || performance.now());
    var now = new Date();
    var clock = now.getHours() + ":" + ("0" + now.getMinutes()).slice(-2);
    if ($("clock").textContent !== clock) $("clock").textContent = clock;
    var s = songs()[shownIdx];
    if (!s || !pos) return;
    var t = nowT();
    var here = pos.song === shownIdx;
    var playing = here && !!pos.playing;
    var bl = barLen();
    var beatUnit = 4 / (pos.sigDen || 4);
    var inSong = here ? Math.max(0, t - s.start) : 0;
    // with an edited arrangement, bars count along the arrangement
    var inArr = sm.lay && sm.lay.edited && here ? mapPos(s, t, here).d : inSong;
    var bar = Math.floor(inArr / bl + 1e-6) + 1;
    var beat = Math.floor((inArr % bl) / beatUnit + 1e-6) + 1;
    var bb = bar + "." + beat;
    if ($("barBeat").textContent !== bb) {
      $("barBeat").textContent = bb;
      if (playing && beat === 1 && !reduceMotion && $("barBeat").animate) $("barBeat").animate([{ transform: "translateY(-35%)", opacity: 0.3 }, { transform: "none", opacity: 1 }], { duration: 220, easing: "cubic-bezier(.2,.8,.3,1)" });
    }
    var secPerBeat = 60 / (here ? pos.tempo : effBpm(s));
    $("elapsed").textContent = fmtTime(inSong * secPerBeat);
    $("remaining").textContent = "-" + fmtTime((s.end - s.start - inSong) * secPerBeat);

    var len = s.end - s.start;
    var ph = $("playhead");
    var phx = Math.min(100, (inSong / len) * 100);
    if (ph) ph.style.transform = "translateX(" + phx + "%)";
    var mp = mapPos(s, t, here);
    $("smHead").style.transform = "translateX(" + mp.x + "%)";
    if ($("smHead").classList.contains("live") !== playing) $("smHead").classList.toggle("live", playing);
    if (mp.total) {
      $("elapsed").textContent = fmtTime(mp.d * secPerBeat);
      $("remaining").textContent = "-" + fmtTime(Math.max(0, mp.total - mp.d) * secPerBeat);
    }

    var j = here ? pos.sec : 0;
    var sec = s.sections[j];
    if (!sec) return;
    var p = here ? Math.min(1, Math.max(0, (t - sec.start) / (sec.end - sec.start))) : 0;
    var segs = $("strip").children;
    var pads = $("tiles").children;
    for (var k = 0; k < segs.length; k++) {
      var f = segs[k].firstChild;
      if (!f || !segs[k].classList.contains("seg")) continue;
      var fx = "scaleX(" + (k === j ? p : 0) + ")";
      if (f.style.transform !== fx) f.style.transform = fx;
      var pf = pads[k] && pads[k].firstChild;
      if (pf && pf.style.transform !== fx) pf.style.transform = fx;
    }
    $("nowFill").style.transform = "scaleX(" + p + ")";

    // bars and beats left until the change
    var secBars = Math.max(1, Math.round((sec.end - sec.start) / bl));
    var barInSec = Math.min(secBars, Math.floor((Math.max(0, t - sec.start)) / bl + 1e-6) + 1);
    $("curLeft").textContent = playing ? T("barOf", { a: barInSec, b: secBars }) : (secBars === 1 ? T("barCount") : T("barsCount", { n: secBars }));
    var left = sec.end - t;
    var cd = $("countdown"), txt = "", beats = false;
    if (!playing && $("nextPanel").className.indexOf("k-endK") < 0) txt = secBars === 1 ? T("inBar") : T("inBars", { n: secBars });
    else if (playing && $("nextPanel").className.indexOf("k-endK") < 0) {
      if (left <= bl + 1e-6) { txt = String(Math.max(1, Math.ceil(left / beatUnit - 1e-6))); beats = true; }
      else { var bL = Math.ceil(left / bl - 1e-6); txt = bL === 1 ? T("inBar") : T("inBars", { n: bL }); }
    }
    if (cd.textContent !== txt) {
      cd.textContent = txt;
      $("smCount").textContent = beats ? txt : "";
      $("tnIn").textContent = txt;
      if (beats && !reduceMotion && $("smCount").animate) $("smCount").animate([{ transform: "scale(1.25)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 260, easing: "cubic-bezier(.2,.8,.3,1)" });
    }
    $("smCount").style.color = beats ? $("nextPanel").style.getPropertyValue("--c") : "";
    cd.classList.toggle("beats", beats);
    $("nextPanel").classList.toggle("imminent", beats);

    // beat lights and the pulse of the current section
    var lights = $("beatLights").children;
    var key = playing ? bar + ":" + beat : "";
    if (key !== lastBeatKey) {
      lastBeatKey = key;
      for (var b = 0; b < lights.length; b++) lights[b].classList.toggle("on", playing && b === beat - 1);
      if (playing && !reduceMotion) {
        var pulse = $("nowPanel");
        if (pulse.animate) pulse.animate([{ "--pulse": beat === 1 ? 1 : 0.55 }, { "--pulse": 0 }], { duration: Math.min(420, secPerBeat * 900), easing: "cubic-bezier(.2,.7,.3,1)" });
        if (beats && cd.animate) cd.animate([{ transform: "scale(1.18)", opacity: 1 }, { transform: "scale(1)", opacity: 1 }], { duration: 260, easing: "cubic-bezier(.2,.8,.3,1)" });
      }
    }

    // song progress on its setlist row
    var row = document.querySelector('.song[data-i="' + shownIdx + '"] .s-prog');
    if (row) row.style.transform = "scaleX(" + (here ? Math.min(1, inSong / len) : 0) + ")";
  }

  // ------------------------------------------------------------ main render

  var lastSig = 0;
  function render() {
    var idx = computeShown();
    var key = (struct ? struct.version : 0) + "|" + idx + "|" + shownMed + "|" + barLen() + "|" + window.SPI18N.lang;
    if (key !== renderedKey) {
      renderedKey = key;
      var songChanged = idx !== shownIdx && shownIdx >= 0 && idx >= 0;
      var doRender = function () {
        shownIdx = idx;
        renderSetlist();
        renderSong();
        renderTrDefault();
        renderBeatLights();
        updateSetlistState();
        updateSongState();
        if (!$("tkSheet").hidden) renderTk();
        if (!$("trSheet").hidden) renderTrans();
      };
      if (songChanged && document.startViewTransition && !reduceMotion) document.startViewTransition(doRender);
      else doRender();
    }
    renderBeatLights();
    if (!$("tkSheet").hidden) updateTkLock();
    if (pos && pos.sigNum !== lastSig) { lastSig = pos.sigNum; updateSettings(); }
    updateSetlistState();
    updateSongState();
    updateStatus();
    updateCue();
  }

  // ------------------------------------------------------------ tiles + strip interaction

  var press = null;
  var lastTap = { j: -1, at: 0 };
  function tileFromEvent(e) { return e.target.closest(".pad, .seg"); }

  function openSheet(j) {
    var s = songs()[shownIdx];
    if (!s) return;
    $("sheetTitle").textContent = s.sections[j].name;
    $("sheet").dataset.j = j;
    $("sheet").hidden = false;
  }

  document.addEventListener("pointerdown", function (e) {
    var el = tileFromEvent(e);
    if (!el) return;
    var j = +el.dataset.j;
    press = { j: j, timer: setTimeout(function () { press.long = true; openSheet(j); }, 520) };
  });
  document.addEventListener("pointerup", function () { if (press) clearTimeout(press.timer); });
  document.addEventListener("pointercancel", function () { if (press) clearTimeout(press.timer); press = null; });
  document.addEventListener("contextmenu", function (e) {
    var el = tileFromEvent(e);
    if (!el) return;
    e.preventDefault();
    if (press) clearTimeout(press.timer);
    openSheet(+el.dataset.j);
  });

  function onSectionClick(e) {
    var el = tileFromEvent(e);
    if (!el) return;
    var j = +el.dataset.j;
    if (navigator.vibrate) try { navigator.vibrate(8); } catch (er) { }
    if (press && press.long) { press = null; return; }
    press = null;
    var now = Date.now();
    if (lastTap.j === j && now - lastTap.at < 350) send("section", shownIdx, j, 1);
    else send("section", shownIdx, j, 0);
    lastTap = { j: j, at: now };
  }
  $("tiles").addEventListener("click", onSectionClick);
  $("lane").addEventListener("click", function (e) {
    var s = songs()[shownIdx];
    if (!s) return;
    var r = this.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    var t = s.start + x * (s.end - s.start);
    for (var j = s.sections.length - 1; j >= 0; j--) if (t >= s.sections[j].start) { send("section", shownIdx, j, 0); return; }
  });
  $("strip").addEventListener("click", onSectionClick);

  $("sheet").addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b && e.target !== $("sheet")) return;
    var act = b ? b.dataset.act : "close";
    var j = +$("sheet").dataset.j;
    if (act === "now") send("section", shownIdx, j, 1);
    else if (act === "queue") send("section", shownIdx, j, 0);
    else if (act === "loop") send("loop", shownIdx, j);
    else if (act === "repeat") send("repeat", shownIdx, j);
    $("sheet").hidden = true;
  });

  // ------------------------------------------------------------ transport + chrome

  $("btnPlay").addEventListener("click", function () { send(pos && pos.playing ? "stop" : "play"); });
  Array.prototype.forEach.call(document.querySelectorAll("[data-cmd]"), function (b) {
    b.addEventListener("click", function () { send(b.dataset.cmd); });
  });
  $("btnCancel").addEventListener("click", function () { send("cancel"); });
  $("tStatus").addEventListener("click", function () { if (this.dataset.cancel) send("cancel"); });
  $("actLoop").addEventListener("click", function () { if (pos && pos.song >= 0) send("loop", pos.song, pos.sec); });
  $("actRepeat").addEventListener("click", function () { if (pos && pos.song >= 0) send("repeat", pos.song, pos.sec); });
  $("emptyAdd").addEventListener("click", function () { openAdd(); });
  $("countIn").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    setSeg("countIn", b.dataset.v);
    send("precount", +b.dataset.v);
  });
  $("btnFadeOut").addEventListener("click", function () { send("fadeout", 4000); });
  $("btnFadeIn").addEventListener("click", function () { send("fadein", 3000); });

  function closeSetlist() { $("app").classList.remove("setlist-open"); }
  $("btnSetlist").addEventListener("click", function () { $("app").classList.toggle("setlist-open"); });
  $("scrim").addEventListener("click", closeSetlist);

  $("btnSettings").addEventListener("click", function (e) {
    e.stopPropagation();
    send("routeopts");
    var open = $("settings").hidden;
    $("settings").hidden = !open;
    $("btnSettings").setAttribute("aria-expanded", open ? "true" : "false");
    if (open) updateSettings();
  });
  document.addEventListener("click", function (e) {
    if (!$("settings").hidden && !e.target.closest("#settings") && !e.target.closest("#btnSettings")) $("settings").hidden = true;
  });
  $("btnRefresh").addEventListener("click", function () { send("refresh"); $("settings").hidden = true; });
  $("btnFullscreen").addEventListener("click", function () {
    var d = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (d.requestFullscreen) d.requestFullscreen();
    else if (d.webkitRequestFullscreen) d.webkitRequestFullscreen();
    $("settings").hidden = true;
  });

  document.addEventListener("keydown", function (e) {
    var k = e.key;
    if (k !== "Escape" && e.target.matches && e.target.matches("input, textarea, select")) return;
    if (k === " ") { e.preventDefault(); send("toggle"); }
    else if (k === "ArrowRight") send("nextsec");
    else if (k === "ArrowLeft") send("prevsec");
    else if (k === "ArrowDown") { e.preventDefault(); send("nextsong"); }
    else if (k === "ArrowUp") { e.preventDefault(); send("prevsong"); }
    else if (k === "Escape") { send("cancel"); $("sheet").hidden = true; $("settings").hidden = true; $("tkSheet").hidden = true; $("addSheet").hidden = true; $("trSheet").hidden = true; $("mixSheet").hidden = true; }
    else if (k === "l" || k === "L" || k === "i" || k === "I") { if (pos && pos.song >= 0) send("loop", pos.song, pos.sec); }
    else if (k === "r" || k === "R") { if (pos && pos.song >= 0) send("repeat", pos.song, pos.sec); }
    else if (k === "t" || k === "T") openTk("tempo");
    else if (k === "k" || k === "K") openTk("key");
    else if (/^[1-9]$/.test(k)) {
      var j = +k - 1;
      var s = songs()[shownIdx];
      if (s && j < s.sections.length) send("section", shownIdx, j, e.shiftKey ? 1 : 0);
    }
  });

  window.addEventListener("resize", function () { drawArc(); fitLabels(); sm.drawnKey = ""; drawWave(); });

  // ------------------------------------------------------------ connection

  var offlineTimer = null;
  function setConnected(ok) {
    connected = ok;
    $("liveChip").classList.toggle("ok", ok);
    $("liveChip").classList.toggle("bad", !ok);
    clearTimeout(offlineTimer);
    if (ok) $("offline").hidden = true;
    else offlineTimer = setTimeout(function () { $("offline").hidden = false; }, 2500);
    updateStatus();
  }

  function connect() {
    var es = new EventSource("/events");
    es.onopen = function () { setConnected(true); };
    es.onerror = function () { setConnected(false); };
    es.addEventListener("struct", function (e) {
      struct = JSON.parse(e.data);
      renderedKey = "";
      render();
      if (wiz.open && !wiz.drag) renderWizard();
      updateSettings();
    });
    es.addEventListener("cue", function (e) { cue = JSON.parse(e.data); updateCue(); });
    es.addEventListener("mixer", function (e) { mixer = JSON.parse(e.data); renderMixer(); });
    es.addEventListener("meters", function (e) { onMeters(JSON.parse(e.data)); });
    es.addEventListener("notice", function (e) { notice(JSON.parse(e.data)); });
    es.addEventListener("routes", function (e) { routes = JSON.parse(e.data); renderOutputs(); });
    es.addEventListener("wave", function (e) {
      var w = JSON.parse(e.data);
      waves[w.song] = w;
      var s = songs()[shownIdx];
      if (s && s.name === w.song) { sm.drawnKey = ""; drawWave(); if (ae.open) aeDrawBlocks(); }
      else if (shownMed >= 0) { sm.drawnKey = ""; drawWave(); }
      if (wiz.open) wizDrawBlocks();
    });
    var firstImport = true;
    es.addEventListener("import", function (e) {
      var m = JSON.parse(e.data);
      if (firstImport && Date.now() - m.at > 5000) { firstImport = false; return; }  // old news on reconnect
      firstImport = false;
      onImport(m);
    });
    es.addEventListener("voice", function (e) { voice = JSON.parse(e.data); updateSettings(); });
    var posKey = "";
    es.addEventListener("pos", function (e) {
      var p = JSON.parse(e.data), tt = p.t;
      p.t = 0;
      var k = JSON.stringify(p);
      p.t = tt;
      pos = p;
      recvAt = performance.now();
      syncClock(p);
      // only the time moved: the animation frame takes care of it
      if (k === posKey) return;
      posKey = k;
      render();
    });
  }

  // ------------------------------------------------------------ layouts
  // Stage: big and readable from the floor. Console: Playback-style, with the
  // setlist as a row of tiles, a large song map and the mixer docked below.
  var layout = "stage";
  try { layout = localStorage.getItem("sp_layout") || "stage"; } catch (e) { }
  var dockOpen = true;
  try {
    var dk = localStorage.getItem("sp_dock");
    dockOpen = dk === null ? window.innerWidth > 640 : dk !== "0";
  } catch (e) { }
  function isConsole() { return layout === "console"; }
  var dockPing = null;
  function placeMixer() {
    var strips = $("mixStrips");
    var inDock = isConsole() && dockOpen;
    if (inDock && strips.parentNode !== $("dockInner")) $("dockInner").appendChild(strips);
    if (!inDock && strips.parentNode === $("dockInner")) $("mixSheet").querySelector(".mix-card").insertBefore(strips, $("mixSheet").querySelector(".mix-card .set-help"));
    clearInterval(dockPing);
    if (inDock) {
      send("mixeron");
      dockPing = setInterval(function () { send("mixeron"); }, 5000);
      $("mixStrips").dataset.k = "";
      renderMixer();
    }
    $("dock").classList.toggle("open", dockOpen);
    $("dockToggle").setAttribute("aria-expanded", dockOpen ? "true" : "false");
  }
  function applyLayout(l, animate) {
    var go = function () {
      layout = l === "console" ? "console" : "stage";
      document.documentElement.dataset.layout = layout;
      setSeg("layoutSwitch", layout);
      setSeg("optLayout", layout);
      $("app").classList.remove("setlist-open");
      placeMixer();
      drawArc();
      updateAutoMode();
      var s = songs()[shownIdx];
      if (s) { renderSongmap(s); updateSongmap(s); }
    };
    if (animate && document.startViewTransition && !reduceMotion) document.startViewTransition(go);
    else go();
    try { localStorage.setItem("sp_layout", l); } catch (e) { }
  }
  $("layoutSwitch").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (b && b.dataset.v !== layout) applyLayout(b.dataset.v, true);
  });
  $("optLayout").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (b && b.dataset.v !== layout) applyLayout(b.dataset.v, true);
  });
  $("dockToggle").addEventListener("click", function () {
    dockOpen = !dockOpen;
    try { localStorage.setItem("sp_dock", dockOpen ? "1" : "0"); } catch (e) { }
    placeMixer();
  });
  applyLayout(layout, false);

  // a soft ripple where a finger lands, on everything that can be pressed
  var RIPPLE = ".pad, .seg, .t-btn, .song, .act, .chip, .tr-chip, .sheet-btn, .tr-opt, .cta, .tk-step, .tk-key, .session, .tk-act, .add-song, .dock-head, .lane";
  document.addEventListener("pointerdown", function (e) {
    if (reduceMotion) return;
    var el = e.target.closest(RIPPLE);
    if (!el || el.disabled) return;
    var r = el.getBoundingClientRect();
    var d = Math.max(r.width, r.height) * 2.2;
    var dot = document.createElement("span");
    dot.className = "ripple";
    dot.style.cssText = "width:" + d + "px;height:" + d + "px;left:" + (e.clientX - r.left - d / 2) + "px;top:" + (e.clientY - r.top - d / 2) + "px";
    el.appendChild(dot);
    var a = dot.animate([{ transform: "scale(0)", opacity: 0.35 }, { transform: "scale(1)", opacity: 0 }], { duration: 650, easing: "cubic-bezier(.2,.7,.3,1)" });
    a.onfinish = function () { dot.remove(); };
  }, true);

  // keep the screen awake during the show: Wake Lock where the browser allows
  // it (localhost, https), otherwise a silent looping video (iPad over Wi-Fi)
  (function keepAwake() {
    var lock = null, video = null;
    function viaVideo() {
      if (!video) {
        video = document.createElement("video");
        video.setAttribute("playsinline", "");
        video.setAttribute("muted", "");
        video.muted = true; video.loop = true;
        video.src = "keepawake.mp4";
        video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0";
        document.body.appendChild(video);
      }
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    }
    function request() {
      if ("wakeLock" in navigator && window.isSecureContext) {
        navigator.wakeLock.request("screen").then(function (l) { lock = l; }).catch(viaVideo);
      } else viaVideo();
    }
    document.addEventListener("pointerdown", function first() {
      document.removeEventListener("pointerdown", first, true);
      request();
    }, true);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && (lock || video)) request();
    });
  })();

  window.SPI18N.apply();
  $("addr").textContent = T("openOn", { addr: location.host });
  render();
  requestAnimationFrame(frame);
  connect();
})();
