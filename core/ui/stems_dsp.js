// Listening to a folder of stems: the tempo and the first downbeat from the
// click, the key from the pitched tracks, and where the parts of the song
// change (from the guide's spoken cues, or from instruments coming and going).
// Pure functions on Float32Arrays, so they run the same in the browser and in
// the tests (node).
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- helpers
  function median(a) {
    if (!a.length) return 0;
    var b = Array.prototype.slice.call(a).sort(function (x, y) { return x - y; });
    var m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
  function std(a) { var m = mean(a), s = 0; for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m); return a.length ? Math.sqrt(s / a.length) : 0; }

  // RMS in frames of hop samples: the loudness curve of a track
  function envelope(x, sr, fps) {
    var hop = Math.max(1, Math.round(sr / (fps || 100))), n = Math.floor(x.length / hop), out = new Float32Array(n);
    for (var f = 0; f < n; f++) {
      var s = 0, o = f * hop;
      for (var i = 0; i < hop; i++) { var v = x[o + i]; s += v * v; }
      out[f] = Math.sqrt(s / hop);
    }
    return out;
  }

  // ---------------------------------------------------------------- click
  // The clicks: sharp onsets, each with its loudness and brightness (the
  // accented click on beat one is usually louder or higher).
  function clickOnsets(x, sr) {
    var hop = Math.round(sr * 0.002), n = Math.floor(x.length / hop), e = new Float32Array(n), prev = 0;
    for (var f = 0; f < n; f++) {
      var s = 0, o = f * hop;
      for (var i = 0; i < hop; i++) { var v = x[o + i] - prev; prev = x[o + i]; s += v * v; }   // a first difference: the attack
      e[f] = s;
    }
    var mx = 0;
    for (f = 0; f < n; f++) if (e[f] > mx) mx = e[f];
    if (!mx) return [];
    var out = [], last = -1e9, refr = Math.round(0.07 / 0.002);
    for (f = 3; f < n; f++) {
      if (e[f] < mx * 0.02 || f - last < refr) continue;
      var before = (e[f - 1] + e[f - 2] + e[f - 3]) / 3;
      if (e[f] > before * 6 + mx * 0.002) {
        // the peak and the brightness (zero crossings) over the next 25 ms
        var a = f * hop, b = Math.min(x.length, a + Math.round(sr * 0.025)), pk = 0, zc = 0;
        for (var k = a; k < b; k++) { var av = Math.abs(x[k]); if (av > pk) pk = av; if (k > a && (x[k] >= 0) !== (x[k - 1] >= 0)) zc++; }
        out.push({ t: a / sr, amp: pk, zcr: zc / ((b - a) / sr) });
        last = f;
      }
    }
    return out;
  }

  // Tempo from the clicks: the beat period from the gaps between them, then a
  // straight line through all of them. Meter and beat one from the accents.
  function tempoFromClick(on, hintBpm) {
    if (on.length < 8) return null;
    var gaps = [];
    for (var i = 1; i < on.length; i++) gaps.push(on[i].t - on[i - 1].t);
    var T0 = median(gaps);
    if (!(T0 > 0.1 && T0 < 2)) return null;
    // count the clicks one gap at a time (a click track may stop in places)
    var n = [0], t = [on[0].t], keep = [on[0]];
    for (i = 1; i < on.length; i++) {
      var steps = Math.round(gaps[i - 1] / T0);
      if (steps < 1 || Math.abs(gaps[i - 1] - steps * T0) > T0 * 0.25) continue;
      n.push(n[n.length - 1] + steps); t.push(on[i].t); keep.push(on[i]);
    }
    var fit = function () {
      var mn = mean(n), mt = mean(t), sxy = 0, sxx = 0;
      for (var q = 0; q < n.length; q++) { sxy += (n[q] - mn) * (t[q] - mt); sxx += (n[q] - mn) * (n[q] - mn); }
      var b = sxx ? sxy / sxx : T0;
      return { a: mt - b * mn, b: b };
    };
    var L = fit();
    // a click in eighths (every beat louder or brighter than its "and"): count the beats only
    var byN = {};
    for (i = 0; i < n.length; i++) byN[n[i]] = keep[i];
    var louder = function (x, y) { return x.amp > y.amp * 1.08 || x.zcr > y.zcr * 1.12; };
    var pairs = [0, 0], wins = [0, 0];
    for (i = 0; i < n.length; i++) {
      var nx = byN[n[i] + 1];
      if (!nx) continue;
      var phx = ((n[i] % 2) + 2) % 2;
      pairs[phx]++;
      if (louder(keep[i], nx)) wins[phx]++;
    }
    var c0 = pairs[0] ? wins[0] / pairs[0] : 0, c1 = pairs[1] ? wins[1] / pairs[1] : 0;
    var bpm0 = 60 / L.b;
    var halve = Math.max(c0, c1) > 0.85 || (hintBpm && Math.abs(bpm0 / 2 - hintBpm) < Math.abs(bpm0 - hintBpm) * 0.5);
    if (halve) {
      var ph = c0 >= c1 ? 0 : 1, n2 = [], t2 = [], k2 = [];
      for (i = 0; i < n.length; i++) if ((((n[i] - ph) % 2) + 2) % 2 === 0) { n2.push((n[i] - ph) / 2); t2.push(t[i]); k2.push(keep[i]); }
      n = n2; t = t2; keep = k2;
      L = fit();
    }
    // a straight line through the clicks, without the ones that are off
    for (var pass = 0; pass < 2; pass++) {
      var nn = [], tt = [], kk = [];
      for (i = 0; i < n.length; i++) if (Math.abs(t[i] - (L.a + n[i] * L.b)) < L.b * 0.12) { nn.push(n[i]); tt.push(t[i]); kk.push(keep[i]); }
      if (nn.length >= 8) { n = nn; t = tt; keep = kk; L = fit(); }
    }
    var bpm = 60 / L.b;
    // most songs sit on a whole number (or a half): use it when it is that close
    var whole = Math.round(bpm), half = Math.round(bpm * 2) / 2;
    if (Math.abs(bpm - whole) < 0.06) bpm = whole;
    else if (Math.abs(bpm - half) < 0.04) bpm = half;
    else bpm = Math.round(bpm * 100) / 100;
    var P = 60 / bpm, a = 0;
    for (i = 0; i < n.length; i++) a += t[i] - n[i] * P;
    a /= n.length;
    var res = [];
    for (i = 0; i < n.length; i++) res.push(t[i] - (a + n[i] * P));
    var steady = std(res) < 0.015;

    // the accent: beat one louder or brighter than every other beat of its bar, bar after bar
    byN = {};
    for (i = 0; i < n.length; i++) byN[n[i]] = keep[i];
    var best = { beats: 4, phase: 0, contrast: 0 };
    [4, 3, 6].forEach(function (Pm) {
      for (var ph = 0; ph < Pm; ph++) {
        var bars = 0, good = 0;
        for (var q = 0; q < n.length; q++) {
          if ((((n[q] - ph) % Pm) + Pm) % Pm !== 0) continue;
          var others = [], ok = true;
          for (var d = 1; d < Pm; d++) { var o = byN[n[q] + d]; if (o) others.push(o); }
          if (others.length < Pm - 1) continue;
          bars++;
          for (var w = 0; w < others.length && ok; w++) if (!louder(keep[q], others[w])) ok = false;
          if (ok) good++;
        }
        var c = bars >= 3 ? good / bars : 0;
        var bias = Pm === 4 ? 1.05 : 1;
        if (c * bias > best.contrast) best = { beats: Pm, phase: ph, contrast: c * bias };
      }
    });
    var accented = best.contrast > 0.8;
    if (!accented) best = { beats: 4, phase: 0, contrast: 0 };
    // beat one: the first click on the accented phase
    var first = n[0];
    while ((((first - best.phase) % best.beats) + best.beats) % best.beats !== 0) first++;
    var meter = best.beats === 6 ? "6/8" : best.beats + "/4";
    var down = a + first * P;
    if (down < 0 && down > -0.06) down = 0;
    return { bpm: bpm, downbeat: down, firstClick: a + n[0] * P, lastClick: a + n[n.length - 1] * P, meter: meter, beats: best.beats, steady: steady, accented: accented, clicks: keep.length, eighths: !!halve };
  }

  // ---------------------------------------------------------------- no click: tempo and beat from the music
  // An onset strength curve (positive change in loudness, 100 per second)
  function onsetCurve(env) {
    var o = new Float32Array(env.length);
    for (var i = 1; i < env.length; i++) { var d = Math.log(1e-4 + env[i]) - Math.log(1e-4 + env[i - 1]); o[i] = d > 0 ? d : 0; }
    return o;
  }
  function tempoGuess(oc, fps) {
    // autocorrelation between 60 and 180 BPM, leaning to 70-140
    var best = 0, bestL = 0;
    for (var bpm = 60; bpm <= 180; bpm += 0.5) {
      var L = fps * 60 / bpm, s = 0, Li = Math.floor(L), fr = L - Li;
      for (var i = 0; i + Li + 1 < oc.length; i++) s += oc[i] * (oc[i + Li] * (1 - fr) + oc[i + Li + 1] * fr);
      var w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 105), 2) / 0.36);
      if (s * w > best) { best = s * w; bestL = bpm; }
    }
    return bestL;
  }
  // where the beats fall for a known tempo (and which beat is likely one: the strongest low end)
  function beatPhase(oc, fps, bpm, low) {
    var P = fps * 60 / bpm, best = -1, ph = 0;
    for (var p = 0; p < P; p += 0.5) {
      var s = 0;
      for (var x = p; x < oc.length; x += P) { var i = Math.round(x); if (i < oc.length) s += oc[i]; }
      if (s > best) { best = s; ph = p; }
    }
    var one = 0;
    if (low) {
      var bestB = -1;
      for (var b = 0; b < 4; b++) {
        var sb = 0;
        for (var y = ph + b * P; y < low.length; y += 4 * P) { var j = Math.round(y); if (j < low.length) sb += low[j]; }
        if (sb > bestB) { bestB = sb; one = b; }
      }
    }
    return (ph + one * P) / fps;
  }

  // ---------------------------------------------------------------- key
  var MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  var MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  var NAMES_MAJ = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  var NAMES_MIN = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];

  function fft(re, im) {
    var n = re.length, i, j = 0, k;
    for (i = 1; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { var tr = re[i]; re[i] = re[j]; re[j] = tr; var ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        var cr = 1, ci = 0;
        for (k = 0; k < len / 2; k++) {
          var ar = re[i + k], ai = im[i + k], br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ar + br; im[i + k] = ai + bi; re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
          var nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }
  // the twelve notes, summed over the song (x at sr, mono)
  function chroma(x, sr) {
    var N = 8192, hop = 8192, c = new Float64Array(12), re = new Float64Array(N), im = new Float64Array(N), win = new Float64Array(N);
    for (var i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    var lo = Math.ceil(70 * N / sr), hi = Math.min(N / 2 - 1, Math.floor(2100 * N / sr));
    var bins = [];
    for (var b = lo; b <= hi; b++) { var f = b * sr / N, midi = 69 + 12 * Math.log2(f / 440); bins.push([b, ((Math.round(midi) % 12) + 12) % 12, Math.abs(midi - Math.round(midi))]); }
    for (var o = 0; o + N <= x.length; o += hop) {
      var e = 0;
      for (i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; e += re[i] * re[i]; }
      if (e < 1e-6) continue;
      fft(re, im);
      var frame = new Float64Array(12), tot = 0;
      for (var q = 0; q < bins.length; q++) {
        if (bins[q][2] > 0.35) continue;
        var m = Math.sqrt(re[bins[q][0]] * re[bins[q][0]] + im[bins[q][0]] * im[bins[q][0]]);
        frame[bins[q][1]] += m; tot += m;
      }
      if (tot > 0) for (q = 0; q < 12; q++) c[q] += frame[q] / tot;
    }
    return c;
  }
  function corr(a, b) {
    var ma = mean(a), mb = mean(b), s = 0, sa = 0, sb = 0;
    for (var i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) * (a[i] - ma); sb += (b[i] - mb) * (b[i] - mb); }
    return sa && sb ? s / Math.sqrt(sa * sb) : 0;
  }
  function keyFromChroma(c) {
    var all = [];
    for (var r = 0; r < 12; r++) {
      var rot = [];
      for (var i = 0; i < 12; i++) rot.push(c[(i + r) % 12]);
      all.push({ key: NAMES_MAJ[r], root: r, minor: false, r: corr(rot, MAJ) });
      all.push({ key: NAMES_MIN[r], root: r, minor: true, r: corr(rot, MIN) });
    }
    all.sort(function (a, b) { return b.r - a.r; });
    // worship songs are mostly major: a relative minor only when it is clearly better
    var top = all[0];
    if (top.minor) {
      var rel = all.filter(function (k) { return !k.minor && k.root === (top.root + 3) % 12; })[0];
      if (rel && top.r - rel.r < 0.04) top = rel;
    }
    return { key: top.key, confidence: Math.max(0, Math.min(1, (top.r - all[2].r) * 4 + top.r * 0.5)), list: all.slice(0, 4) };
  }

  // ---------------------------------------------------------------- the parts of the song
  // per bar: how loud each track is (0..1 of its own loudest)
  function barActivity(envs, fps, downbeat, barSec, nBars) {
    var A = [];
    for (var b = 0; b < nBars; b++) {
      var a = Math.round((downbeat + b * barSec) * fps), z = Math.round((downbeat + (b + 1) * barSec) * fps), row = [];
      for (var s = 0; s < envs.length; s++) {
        var e = envs[s], sum = 0, n = 0;
        for (var i = Math.max(0, a); i < Math.min(e.length, z); i++) { sum += e[i]; n++; }
        row.push(n ? sum / n : 0);
      }
      A.push(row);
    }
    for (var s2 = 0; s2 < envs.length; s2++) {
      var mx = 0;
      for (b = 0; b < nBars; b++) mx = Math.max(mx, A[b][s2]);
      for (b = 0; b < nBars; b++) A[b][s2] = mx ? Math.sqrt(A[b][s2] / mx) : 0;
    }
    return A;
  }
  function cosine(a, b) { var s = 0, x = 0, y = 0; for (var i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? s / Math.sqrt(x * y) : (x === y ? 1 : 0); }
  function dist(a, b) { var s = 0; for (var i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i]); return Math.sqrt(s); }
  function avgRows(A, a, z) {
    var n = 0, out = null;
    for (var b = Math.max(0, a); b < Math.min(A.length, z); b++) {
      if (!out) out = A[b].map(function () { return 0; });
      for (var i = 0; i < out.length; i++) out[i] += A[b][i];
      n++;
    }
    return out ? out.map(function (v) { return v / n; }) : null;
  }

  // the bars where something changes (0-based bar index = a new part starts there)
  function noveltyBounds(A) {
    var nb = A.length, d = [];
    for (var b = 0; b < nb; b++) {
      var L = avgRows(A, b - 4, b), R = avgRows(A, b, b + 4);
      d.push(L && R ? dist(L, R) : 0);
    }
    var md = mean(d), sd = std(d), out = [];
    for (b = 2; b < nb - 1; b++) {
      var w = b % 8 === 0 ? 1.45 : b % 4 === 0 ? 1.25 : b % 2 === 0 ? 1 : 0.7;
      var v = d[b] * w;
      if (v < md + 0.6 * sd) continue;
      if (d[b] < d[b - 1] * 0.8 || d[b] < d[b + 1] * 0.8) continue;
      out.push({ bar: b, v: v });
    }
    // strongest first, at least 4 bars apart
    out.sort(function (x, y) { return y.v - x.v; });
    var picked = [];
    out.forEach(function (c) { if (picked.every(function (p) { return Math.abs(p - c.bar) >= 4; })) picked.push(c.bar); });
    return picked.sort(function (x, y) { return x - y; });
  }

  // the guide speaks a part's name just before it starts: the next bar line
  // after each thing it says is where a part starts
  // what the guide says, as [start, end] seconds, joined when less than half a bar apart
  function guideRegions(env, fps, barSec) {
    var mx = 0;
    for (var i = 0; i < env.length; i++) if (env[i] > mx) mx = env[i];
    if (!mx) return [];
    var on = false, start = 0, regions = [], thr = mx * 0.06;
    for (i = 0; i < env.length; i++) {
      var v = env[i] > thr;
      if (v && !on) { on = true; start = i; }
      if (!v && on) { on = false; regions.push([start / fps, i / fps]); }
    }
    if (on) regions.push([start / fps, env.length / fps]);
    var joined = [];
    regions.forEach(function (r) {
      if (r[1] - r[0] < 0.08) return;
      var l = joined[joined.length - 1];
      if (l && r[0] - l[1] < barSec * 0.5) l[1] = r[1]; else joined.push(r.slice());
    });
    return joined;
  }
  // each cue: the bar it announces and when it was said
  function guideCues(env, fps, downbeat, barSec, nBars) {
    var out = [];
    guideRegions(env, fps, barSec).forEach(function (r) {
      var b = Math.ceil((r[1] - 0.12 - downbeat) / barSec - 1e-6);
      if (b >= 0 && b < nBars && (b * barSec + downbeat) - r[1] < barSec && !out.some(function (c) { return c.bar === b; })) out.push({ bar: b, a: r[0], z: r[1] });
    });
    return out;
  }
  function guideBounds(env, fps, downbeat, barSec, nBars) {
    return guideCues(env, fps, downbeat, barSec, nBars).map(function (c) { return c.bar; });
  }
  // a click with no accent: beat one from the guide (the count in ends just before a bar line)
  function downbeatFromGuide(env, fps, firstClick, beatSec, beats) {
    var regs = guideRegions(env, fps, beatSec * beats);
    var count = regs.filter(function (r) { return r[1] - r[0] >= beatSec * (beats - 1) * 0.9; })[0];
    if (!count) return null;
    // the beat line right after the count: a bar line
    var k = Math.ceil((count[1] - 0.12 - firstClick) / beatSec - 1e-6);
    var bar = firstClick + k * beatSec;
    while (bar - beats * beatSec >= firstClick - beatSec * 0.25) bar -= beats * beatSec;
    return bar;
  }

  // names for the parts: parts that sound alike get the same name
  function nameParts(A, bounds, opts) {
    opts = opts || {};
    var segs = [];
    for (var i = 0; i < bounds.length; i++) {
      var a = bounds[i], z = i + 1 < bounds.length ? bounds[i + 1] : A.length;
      if (z <= a) continue;
      var v = avgRows(A, a, z);
      segs.push({ bar: a, len: z - a, v: v, e: v ? mean(v) : 0 });
    }
    if (!segs.length) return [];
    // groups of similar parts: from the guide's words when they are known, otherwise from how they sound
    var groups = [];
    if (opts.groups && opts.groups.length === segs.length) {
      var byId = {};
      segs.forEach(function (s, k) {
        var id = opts.groups[k];
        if (id == null || id < 0) { groups.push([s]); s.g = groups[groups.length - 1]; return; }
        if (!byId[id]) { byId[id] = []; groups.push(byId[id]); }
        byId[id].push(s); s.g = byId[id];
      });
    } else segs.forEach(function (s) {
      var g = null;
      for (var q = 0; q < groups.length && !g; q++) {
        var r = groups[q][0];
        if (cosine(r.v, s.v) > 0.97 && Math.abs(mean(r.v) - mean(s.v)) < 0.12) g = groups[q];
      }
      if (g) g.push(s); else groups.push([s]);
      s.g = g || groups[groups.length - 1];
    });
    var emax = Math.max.apply(null, segs.map(function (s) { return s.e; }));
    var quiet = function (s) { return s.e < emax * 0.25; };
    // the loudest group that comes back: the chorus; the other one that comes back: the verse
    // a group that comes back after something else (not just twice in a row)
    var idx = function (x) { return segs.indexOf(x); };
    var rep = groups.filter(function (g) { return g.length >= 2 && g.some(function (a) { return g.some(function (b) { return idx(b) - idx(a) > 1; }); }); }).sort(function (x, y) { return mean(y.map(function (s) { return s.e; })) - mean(x.map(function (s) { return s.e; })); });
    var chorus = rep[0] || null, verse = rep[1] || null;
    var vn = 0;
    segs.forEach(function (s, k) {
      var last = k === segs.length - 1;
      if (opts.countIn && k === 0 && quiet(s)) s.name = "Count In";
      else if (k === 0 || (k === 1 && segs[0].name === "Count In" && s.g !== chorus)) s.name = "Intro";
      else if (last && s.g !== chorus) s.name = "Outro";
      else if (chorus && s.g === chorus) s.name = "Chorus";
      else if (verse && s.g === verse) s.name = "Verse " + (++vn);
      else {
        var next = segs[k + 1];
        if (next && chorus && next.g === chorus && s.len <= 8 && s.g.length >= 2) s.name = "Pre-Chorus";
        else if (s.g.length === 1 && k > segs.length / 2 && !segs.some(function (x) { return x.name === "Bridge"; })) s.name = "Bridge";
        else s.name = "Part";      // not sure: the musician names it
      }
    });
    if (vn === 1) segs.forEach(function (s) { if (s.name === "Verse 1") s.name = "Verse"; });
    return segs.map(function (s) { return { bar: s.bar, name: s.name }; });
  }

  root.SPStemsDSP = {
    envelope: envelope, clickOnsets: clickOnsets, tempoFromClick: tempoFromClick,
    onsetCurve: onsetCurve, tempoGuess: tempoGuess, beatPhase: beatPhase,
    chroma: chroma, keyFromChroma: keyFromChroma,
    barActivity: barActivity, noveltyBounds: noveltyBounds, guideBounds: guideBounds, guideCues: guideCues, guideRegions: guideRegions, downbeatFromGuide: downbeatFromGuide, nameParts: nameParts,
    median: median, mean: mean
  };
  if (typeof module !== "undefined") module.exports = root.SPStemsDSP;
})(typeof window !== "undefined" ? window : globalThis);
