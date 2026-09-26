/* Minimal Luau highlighter: one pass over the text, HTML-escaping as it goes.
   No dependencies, so this file works unchanged from GitHub Pages. */
(function (global) {
  "use strict";

  var KEYWORDS = new Set([
    "and", "break", "continue", "do", "else", "elseif", "end", "export", "for",
    "function", "if", "in", "local", "not", "or", "repeat", "return", "then",
    "type", "typeof", "until", "while"
  ]);
  var CONSTANTS = new Set(["true", "false", "nil", "self", "..."]);
  var BUILTINS = new Set([
    "assert", "bit32", "buffer", "coroutine", "debug", "error", "getfenv",
    "getmetatable", "ipairs", "math", "newproxy", "next", "os", "pairs",
    "pcall", "print", "rawequal", "rawget", "rawlen", "rawset", "require",
    "select", "setfenv", "setmetatable", "string", "table", "tonumber",
    "tostring", "type", "unpack", "utf8", "vector", "xpcall",
    /* Roblox + executor globals the output tends to mention */
    "game", "workspace", "script", "Instance", "Vector2", "Vector3", "CFrame",
    "Color3", "UDim", "UDim2", "BrickColor", "Enum", "Ray", "Region3", "TweenInfo",
    "NumberRange", "NumberSequence", "ColorSequence", "Rect", "Font", "task",
    "wait", "spawn", "delay", "tick", "time", "typeof", "shared", "loadstring",
    "getgenv", "getrenv", "getrawmetatable", "hookfunction", "hookmetamethod",
    "identifyexecutor", "isfile", "readfile", "writefile", "request",
    "setclipboard", "syn", "firetouchinterest", "fireclickdetector"
  ]);

  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  function esc(s) { return s.replace(/[&<>]/g, function (c) { return ESC[c]; }); }
  function span(cls, text) { return '<span class="tok-' + cls + '">' + esc(text) + "</span>"; }

  /* A long bracket at i ([[, [=[, ...): its closing sequence, or null. */
  function longBracket(src, i) {
    if (src[i] !== "[") return null;
    var j = i + 1, level = 0;
    while (src[j] === "=") { level++; j++; }
    if (src[j] !== "[") return null;
    return { start: j + 1, close: "]" + "=".repeat(level) + "]" };
  }

  function highlight(src) {
    var out = [], i = 0, n = src.length;

    while (i < n) {
      var c = src[i];

      /* comments */
      if (c === "-" && src[i + 1] === "-") {
        var lb = longBracket(src, i + 2);
        if (lb) {
          var close = src.indexOf(lb.close, lb.start);
          var end = close === -1 ? n : close + lb.close.length;
          out.push(span("com", src.slice(i, end)));
          i = end;
          continue;
        }
        var nl = src.indexOf("\n", i);
        if (nl === -1) nl = n;
        out.push(span("com", src.slice(i, nl)));
        i = nl;
        continue;
      }

      /* long strings */
      var slb = longBracket(src, i);
      if (slb) {
        var sclose = src.indexOf(slb.close, slb.start);
        var send = sclose === -1 ? n : sclose + slb.close.length;
        out.push(span("str", src.slice(i, send)));
        i = send;
        continue;
      }

      /* quoted strings (including Luau's `interpolation`) */
      if (c === '"' || c === "'" || c === "`") {
        var j = i + 1;
        while (j < n) {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === c || src[j] === "\n") break;
          j++;
        }
        var qend = src[j] === c ? j + 1 : j;
        out.push(span("str", src.slice(i, qend)));
        i = qend;
        continue;
      }

      /* numbers (decimal, hex, binary, exponents, 1_000) */
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
        var m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+]?[0-9]+)?)/
          .exec(src.slice(i));
        var num = m ? m[0] : c;
        out.push(span("num", num));
        i += num.length;
        continue;
      }

      /* names */
      if (/[A-Za-z_]/.test(c)) {
        var w = /^[A-Za-z0-9_]+/.exec(src.slice(i))[0];
        i += w.length;
        /* followed by an argument list, a table or a string: a call */
        var isCall = /^\s*[({"'`]/.test(src.slice(i));
        if (KEYWORDS.has(w)) out.push(span("kw", w));
        else if (CONSTANTS.has(w)) out.push(span("cst", w));
        else if (BUILTINS.has(w)) out.push(span("bin", w));
        else if (isCall) out.push(span("fn", w));
        else out.push(esc(w));
        continue;
      }

      /* operators and punctuation */
      if (/[+\-*/%^#=~<>(){}\[\];:,.&|?]/.test(c)) {
        var op = /^(?:\.\.\.|\.\.=|==|~=|<=|>=|\.\.|::|\+=|-=|\*=|\/=|%=|\^=|\/\/|->|[+\-*/%^#=<>(){}\[\];:,.&|?~])/
          .exec(src.slice(i));
        var o = op ? op[0] : c;
        out.push(span("op", o));
        i += o.length;
        continue;
      }

      out.push(esc(c));
      i++;
    }
    return out.join("");
  }

  global.LuauHighlight = highlight;
})(window);
