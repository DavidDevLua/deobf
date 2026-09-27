/* The plugin detectors, in JavaScript.

   Same checks as detect() in deobf/obfuscators/* - cheap ones, over the first
   few hundred bytes. They live here so naming the obfuscator costs nothing:
   otherwise merely pasting a script has to start Pyodide and the Luau runtime,
   about 16 MB, which on a phone is most of what the tab is allowed.

   This only labels the input. The run detects again in Python, and that is the
   one that decides which plugin executes. */
(function (global) {
  "use strict";

  var LURAPH_HEADER = /This file was protected using Luraph Obfuscator v(\d+)(?:\.(\d+))?/;
  var LURAPH_SLOT = /\[\d+\]=(bit32|buffer|string|table|math)\.\w+/;
  var IRONBREW_HEADER = /--\s*this file was generated using ironbrew1\b/i;
  var IRONBREW_SHAPE = /^return\s*\(\s*function\s*\((?:[a-z]{1,2},){20,}\.\.\.\)\s*local [a-z]{1,3}(?:=\{-?\d+,|(?:,[a-z]{1,3}){10,})/;

  var MIN_CONFIDENCE = 0.5;     // obfuscators/__init__.py

  function luraph(source) {
    var m = LURAPH_HEADER.exec(source.slice(0, 500));
    if (m) return m[1] === "15" ? 1.0 : 0.3;
    var head = source.replace(/^\s+/, "").slice(0, 2000);
    if (head.indexOf("return setmetatable({") === 0 &&
        (LURAPH_SLOT.test(head) || source.slice(0, 200000).indexOf("LPH") !== -1)) {
      return 0.8;
    }
    return 0.0;
  }

  function ironbrew(source) {
    if (IRONBREW_HEADER.test(source.slice(0, 300))) return 1.0;
    if (IRONBREW_SHAPE.test(source.replace(/^\s+/, "").slice(0, 600))) return 0.8;
    return 0.0;
  }

  var PLUGINS = [
    { name: "luraph_v15", label: "Luraph v15", detect: luraph },
    { name: "ironbrew1", label: "ironbrew1", detect: ironbrew },
    { name: "generic", label: "unknown obfuscator (behaviour trace only)",
      detect: function () { return 0.01; } }
  ];

  function detect(source) {
    var best = { confidence: -1 };
    PLUGINS.forEach(function (p) {
      var c = p.detect(source);
      if (c > best.confidence) best = { obfuscator: p.name, label: p.label, confidence: c };
    });
    if (best.confidence < MIN_CONFIDENCE) {
      var generic = PLUGINS[PLUGINS.length - 1];
      return { obfuscator: generic.name, label: generic.label,
               confidence: best.obfuscator === generic.name ? best.confidence : 0.0 };
    }
    return best;
  }

  detect.plugins = PLUGINS.map(function (p) { return { name: p.name, label: p.label }; });
  global.DeobfDetect = detect;
})(window);
