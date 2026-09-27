/* Minimal Luau highlighter, in two shapes:

     highlight(src)                 the whole string at once (small output)
     prepare(src) / renderRange()   line by line, for the virtual scroller

   The second exists because a big trace is millions of tokens: rendering all
   of it produces more DOM nodes than a browser can scroll, so the result pane
   only ever draws the lines on screen. Long comments and long strings span
   lines, so prepare() makes one pass over the text recording the state each
   line starts in, and renderRange() resumes from it - highlighting a window in
   isolation would misread a line that sits inside a --[[ block.

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

  /* State carried across a line break, as one integer:
       0            normal
       1 + 2*level  inside a long string  opened with [=*[ of that level
       2 + 2*level  inside a long comment opened with --[=*[ of that level */
  function openState(level, isComment) { return 1 + 2 * level + (isComment ? 1 : 0); }
  function stateLevel(s) { return (s - 1) >> 1; }
  function stateIsComment(s) { return ((s - 1) & 1) === 1; }

  /* A long bracket at i ([[, [=[, ...): its level, or -1. */
  function longBracketLevel(src, i, end) {
    if (src.charCodeAt(i) !== 91 /* [ */) return -1;
    var j = i + 1, level = 0;
    while (j < end && src.charCodeAt(j) === 61 /* = */) { level++; j++; }
    if (j < end && src.charCodeAt(j) === 91 /* [ */) return level;
    return -1;
  }

  function closeSeq(level) { return "]" + "=".repeat(level) + "]"; }

  /* Highlights src[start,end) starting in `state`; pushes HTML into `out`.
     Returns the state the next line starts in. */
  function run(src, start, end, state, out) {
    var i = start;

    if (state !== 0) {
      var lvl = stateLevel(state);
      var cls = stateIsComment(state) ? "com" : "str";
      var close = closeSeq(lvl);
      var at = src.indexOf(close, i);
      if (at === -1 || at >= end) {
        if (end > i) out.push(span(cls, src.slice(i, end)));
        return state;                       // still open on the next line
      }
      out.push(span(cls, src.slice(i, at + close.length)));
      i = at + close.length;
      state = 0;
    }

    while (i < end) {
      var c = src[i];

      /* comments */
      if (c === "-" && src[i + 1] === "-" && i + 1 < end) {
        var clvl = longBracketLevel(src, i + 2, end);
        if (clvl >= 0) {
          var cclose = closeSeq(clvl);
          var cat = src.indexOf(cclose, i + 3 + clvl);
          if (cat === -1 || cat >= end) {
            out.push(span("com", src.slice(i, end)));
            return openState(clvl, true);
          }
          out.push(span("com", src.slice(i, cat + cclose.length)));
          i = cat + cclose.length;
          continue;
        }
        out.push(span("com", src.slice(i, end)));   // to end of line
        return 0;
      }

      /* long strings */
      var slvl = longBracketLevel(src, i, end);
      if (slvl >= 0) {
        var sclose = closeSeq(slvl);
        var sat = src.indexOf(sclose, i + 1 + slvl);
        if (sat === -1 || sat >= end) {
          out.push(span("str", src.slice(i, end)));
          return openState(slvl, false);
        }
        out.push(span("str", src.slice(i, sat + sclose.length)));
        i = sat + sclose.length;
        continue;
      }

      /* quoted strings (including Luau's `interpolation`); these end at the
         line break, like the Lua lexer */
      if (c === '"' || c === "'" || c === "`") {
        var j = i + 1;
        while (j < end) {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === c) break;
          j++;
        }
        var qend = (j < end && src[j] === c) ? j + 1 : Math.min(j, end);
        out.push(span("str", src.slice(i, qend)));
        i = qend;
        continue;
      }

      /* numbers (decimal, hex, binary, exponents, 1_000) */
      if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
        var m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+]?[0-9]+)?)/
          .exec(src.slice(i, end));
        var num = m ? m[0] : c;
        out.push(span("num", num));
        i += num.length;
        continue;
      }

      /* names */
      if (/[A-Za-z_]/.test(c)) {
        var w = /^[A-Za-z0-9_]+/.exec(src.slice(i, end))[0];
        i += w.length;
        var isCall = /^[ \t]*[({"'`]/.test(src.slice(i, Math.min(end, i + 8)));
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
          .exec(src.slice(i, end));
        var o = op ? op[0] : c;
        out.push(span("op", o));
        i += o.length;
        continue;
      }

      out.push(esc(c));
      i++;
    }
    return state;
  }

  function highlight(src) {
    var out = [];
    var state = 0;
    var start = 0;
    for (;;) {
      var nl = src.indexOf("\n", start);
      var end = nl === -1 ? src.length : nl;
      state = run(src, start, end, state, out);
      if (nl === -1) break;
      out.push("\n");
      start = nl + 1;
    }
    return out.join("");
  }

  /* One pass over the text: where each line starts, and the state it starts
     in. Two typed arrays, so even a million lines stays small.

     This deliberately does not reuse run(): it needs the state transitions
     only, and building - then discarding - the HTML for every line of a 48 MB
     trace took seventeen seconds. Here nothing is allocated per token. */
  function prepare(src) {
    var n = src.length;
    var count = 1;
    for (var k = 0; k < n; k++) if (src.charCodeAt(k) === 10) count++;

    var starts = new Int32Array(count + 1);
    var states = new Int32Array(count + 1);
    var line = 0, state = 0, i = 0;
    starts[0] = 0;
    states[0] = 0;

    /* walk to `to`, recording every line break with the current state */
    function skipTo(to) {
      while (i < to) {
        if (src.charCodeAt(i) === 10) {
          line++;
          starts[line] = i + 1;
          states[line] = state;
        }
        i++;
      }
    }

    while (i < n) {
      var c = src.charCodeAt(i);

      if (state !== 0) {                       // inside a long bracket
        var close = closeSeq(stateLevel(state));
        var at = src.indexOf(close, i);
        if (at === -1) { skipTo(n); break; }
        skipTo(at + close.length);
        state = 0;
        continue;
      }

      if (c === 10) {                          // newline
        line++;
        starts[line] = i + 1;
        states[line] = 0;
        i++;
        continue;
      }

      if (c === 45 /* - */ && src.charCodeAt(i + 1) === 45) {
        var clvl = longBracketLevel(src, i + 2, n);
        if (clvl >= 0) {                       // --[[ ... ]]
          state = openState(clvl, true);
          i += 3 + clvl;
          continue;
        }
        var nl = src.indexOf("\n", i);         // to end of line; the \n itself
        skipTo(nl === -1 ? n : nl);            // is recorded by the loop above
        continue;
      }

      if (c === 91 /* [ */) {
        var slvl = longBracketLevel(src, i, n);
        if (slvl >= 0) {                       // [[ ... ]]
          state = openState(slvl, false);
          i += 2 + slvl;
          continue;
        }
      }

      if (c === 34 || c === 39 || c === 96) {  // " ' ` - never span a line
        var j = i + 1;
        while (j < n) {
          var q = src.charCodeAt(j);
          if (q === 92 /* \\ */) { j += 2; continue; }
          if (q === c || q === 10) break;
          j++;
        }
        i = (j < n && src.charCodeAt(j) === c) ? j + 1 : j;
        continue;
      }

      i++;
    }

    starts[count] = n;
    return { lines: count, starts: starts, states: states };
  }

  /* HTML for lines [from, to) - the only part the scroller puts in the DOM. */
  function renderRange(src, prep, from, to) {
    from = Math.max(0, from);
    to = Math.min(prep.lines, to);
    var out = [];
    for (var i = from; i < to; i++) {
      var start = prep.starts[i];
      var end = i + 1 < prep.starts.length ? prep.starts[i + 1] : src.length;
      if (end > start && src.charCodeAt(end - 1) === 10) end--;
      run(src, start, end, prep.states[i], out);
      if (i + 1 < to) out.push("\n");
    }
    return out.join("");
  }

  global.LuauHighlight = highlight;
  highlight.prepare = prepare;
  highlight.renderRange = renderRange;
})(window);
