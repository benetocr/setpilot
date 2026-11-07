// What a guide track says, as the name of a part: "Verse two", "Coro",
// "Pre-chorus", "Puente"... in English or Spanish. Every name comes out in
// English (that is what goes into Live). A count ("1, 2, 1 2 3 4") is a count in.
(function (root) {
  "use strict";
  var WORDS = [
    // longest first: "pre chorus" before "chorus"
    [/\b(pre ?chorus|pre ?coro|precoro)\b/, "Pre-Chorus"],
    [/\b(post ?chorus|post ?coro|postcoro)\b/, "Post-Chorus"],
    [/\b(turn ?around)\b/, "Turnaround"],
    [/\b(a ?cappella|acapella)\b/, "A Cappella"],
    [/\b(count ?in|count ?off|conteo|cuenta)\b/, "Count In"],
    [/\b(all in)\b/, "All In"],
    [/\b(intro|introduccion|introduction)\b/, "Intro"],
    [/\b(verse|verses|verso|versos|estrofa|verse's)\b/, "Verse"],
    [/\b(chorus|choruses|coro|coros|chorale|core)\b/, "Chorus"],
    [/\b(bridge|bridges|puente|puentes|pune|puent|fuente)\b/, "Bridge"],
    [/\b(interlude|interludio)\b/, "Interlude"],
    [/\b(instrumental)\b/, "Instrumental"],
    [/\b(refrain|refran|estribillo)\b/, "Refrain"],
    [/\b(tag|tags)\b/, "Tag"],
    [/\b(vamp|vamps)\b/, "Vamp"],
    [/\b(breakdown|break down)\b/, "Breakdown"],
    [/\b(build|builds)\b/, "Build"],
    [/\b(outro)\b/, "Outro"],
    [/\b(ending|end|final|cierre|finale)\b/, "Ending"],
    [/\b(solo)\b/, "Solo"],
    [/\b(hook)\b/, "Hook"],
    [/\b(exhortation|exhortacion)\b/, "Exhortation"],
    [/\b(spontaneous|espontaneo)\b/, "Spontaneous"]
  ];
  var NUM = { one: 1, won: 1, uno: 1, un: 1, una: 1, two: 2, to: 2, too: 2, dos: 2, three: 3, tree: 3, tres: 3, four: 4, for: 4, cuatro: 4, five: 5, cinco: 5, six: 6, seis: 6, first: 1, second: 2, third: 3, primer: 1, primero: 1, segundo: 2, tercer: 3, tercero: 3 };

  function norm(t) {
    return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")          // [BLANK_AUDIO], (music)
      .replace(/-/g, " ").replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
  }
  function numbers(words) {
    var out = [];
    words.forEach(function (w) {
      if (/^\d+$/.test(w)) { w.split("").length > 1 && +w > 9 ? w.split("").forEach(function (d) { out.push(+d); }) : out.push(+w); }
      else if (NUM[w] != null) out.push(NUM[w]);
    });
    return out;
  }
  function counting(n) {
    if (n.length < 3) return false;
    for (var i = 1; i < n.length; i++) if (n[i] !== n[i - 1] + 1 && !(n[i] === 1 && n[i - 1] >= 2)) return false;
    return true;
  }

  // { name, count } or null when it isn't a part's name
  function partName(text) {
    var t = norm(text);
    if (!t) return null;
    for (var i = 0; i < WORDS.length; i++) {
      var m = t.match(WORDS[i][0]);
      if (!m) continue;
      var name = WORDS[i][1];
      if (name === "Count In") return { name: name, count: true };
      var after = t.slice(m.index + m[0].length).split(" ").filter(Boolean);
      var n = numbers(after.slice(0, 4));
      // "Verse two" yes; "Verse, 1 2 3 4" is the name and a count
      if (n.length && !counting(n) && n[0] >= 1 && n[0] <= 6 && /^(verse|chorus|bridge|pre|interlude|tag|vamp|instrumental|refrain|post)/i.test(name)) name += " " + n[0];
      return { name: name, count: false };
    }
    var words = t.split(" ");
    var n2 = numbers(words);
    if (n2.length >= 2 && n2.length >= words.length * 0.6) return { name: "Count In", count: true };
    return null;
  }

  // the words whisper is told to expect
  var PROMPT = {
    en: "Count in. One, two, one, two, three, four. Intro. Verse one. Pre-chorus. Chorus. Verse two. Bridge. Interlude. Instrumental. Tag. Vamp. Turnaround. Outro. Ending.",
    es: "Conteo. Uno, dos, uno, dos, tres, cuatro. Intro. Verso uno. Pre coro. Coro. Verso dos. Puente. Interludio. Instrumental. Tag. Final."
  };

  var api = { partName: partName, PROMPT: PROMPT, norm: norm };
  root.SPCueWords = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
