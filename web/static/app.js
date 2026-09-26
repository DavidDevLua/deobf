/* deobf front end.

   Talks to the FastAPI server in web/server.py. When this page is served by
   that server the API is same-origin; when it is served from GitHub Pages the
   backend URL is asked for once and kept in localStorage. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var KEY = "deobf.backend";
  var STAGES = ["detect", "trace", "lift", "polish", "done"];
  var PCT = { queued: 3, starting: 6, detect: 12, trace: 30, rerun: 45, lift: 65, polish: 88, done: 100 };

  var state = {
    base: null,          // API origin ("" = same origin)
    source: null,        // script text
    name: null,
    health: null,
    job: null,
    stream: null,
    poll: null,
    ticker: null,
    detectSeq: 0
  };

  /* ------------------------------------------------------------ utilities */

  function api(path) { return (state.base || "") + path; }

  function bytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  function show(el, on) { el.classList.toggle("hidden", !on); }

  function fail(el, message) {
    el.textContent = message || "";
    show(el, !!message);
  }

  async function request(path, init) {
    var res = await fetch(api(path), init);
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* plain text */ }
    if (!res.ok) {
      var msg = (data && (data.detail || data.message)) || text || ("HTTP " + res.status);
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data !== null ? data : text;
  }

  /* -------------------------------------------------------------- backend */

  function setStatus(cls, text) {
    var dot = $("status-dot");
    dot.className = cls;
    $("status-text").textContent = text;
  }

  async function probe(base) {
    var res = await fetch((base || "") + "/api/health", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  }

  async function connect() {
    var stored = localStorage.getItem(KEY);
    var tries = stored !== null ? [stored] : ["", location.origin];
    setStatus("busy", "checking…");
    for (var i = 0; i < tries.length; i++) {
      try {
        var health = await probe(tries[i]);
        state.base = tries[i];
        state.health = health;
        onHealth(health);
        return true;
      } catch (e) { /* try the next candidate */ }
    }
    state.base = null;
    setStatus("down", "no backend");
    show($("backend-panel"), true);
    $("backend-url").value = stored || "http://127.0.0.1:8000";
    return false;
  }

  function onHealth(health) {
    var q = health.queue || {};
    var busy = (q.running || 0) + (q.queued || 0);
    setStatus(health.luau ? "up" : "busy",
      health.luau ? (busy ? "ready · " + busy + " in flight" : "ready")
                  : "luau missing");
    if (!health.luau) {
      fail($("submit-error"),
        "The server is up but deobf/bin/luau is missing — run `python deobf/build_luau.py --portable` there.");
    }
    var sel = $("opt-obfuscator");
    sel.innerHTML = '<option value="">auto-detect</option>';
    (health.obfuscators || []).forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.name;
      o.textContent = p.label + " (" + p.name + ")";
      sel.appendChild(o);
    });
    show($("backend-panel"), false);
    updateRun();
  }

  /* ---------------------------------------------------------------- input */

  function setSource(text, name) {
    state.source = text;
    state.name = name;
    show($("detected"), false);
    updateRun();
    if (text) detect();
  }

  function clearInput() {
    state.source = null;
    state.name = null;
    $("file-input").value = "";
    show($("file-chip"), false);
    show($("drop"), true);
    show($("detected"), false);
    updateRun();
  }

  async function readFile(file) {
    var limit = (state.health && state.health.limits && state.health.limits.max_upload) || 12582912;
    if (file.size > limit) {
      fail($("submit-error"), "That file is " + bytes(file.size) + "; this instance accepts up to " + bytes(limit) + ".");
      return;
    }
    fail($("submit-error"), "");
    /* latin-1 so every byte survives the round trip, like deob.py reads it */
    var text = await new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsText(file, "ISO-8859-1");
    });
    $("file-name").textContent = file.name;
    $("file-size").textContent = bytes(file.size);
    show($("file-chip"), true);
    show($("drop"), false);
    setSource(text, file.name);
  }

  function detect() {
    if (!state.base && state.base !== "") return;
    var seq = ++state.detectSeq;
    var src = state.source;
    request("/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: src })
    }).then(function (d) {
      if (seq !== state.detectSeq) return;       // a newer input won
      $("detected-label").textContent = d.label;
      $("detected-conf").textContent = d.confidence === null ? "forced" : d.confidence.toFixed(2);
      show($("detected"), true);
    }).catch(function () { /* detection is a nicety; the run detects again */ });
  }

  /* -------------------------------------------------------------- options */

  function options() {
    var mode = document.querySelector(".seg-btn.active").dataset.mode;
    return {
      obfuscator: $("opt-obfuscator").value || null,
      timeout: parseInt($("opt-timeout").value, 10) || 90,
      budget: parseInt($("opt-budget").value, 10) || 30,
      executor: $("opt-executor").value || "Wave",
      no_devirt: mode === "trace",
      no_fold: $("opt-no-fold").checked,
      no_tidy: $("opt-no-tidy").checked,
      keep_preamble: $("opt-keep-preamble").checked,
      strings: $("opt-strings").checked,
      input_text: $("opt-input-text").value || null,
      cfg: $("opt-cfg").value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean)
    };
  }

  function updateRun() {
    var ready = !!state.source && (state.base || state.base === "") && !state.job;
    $("run").disabled = !ready;
  }

  /* ------------------------------------------------------------- the run */

  function stageClass(stage) {
    var at = STAGES.indexOf(stage);
    document.querySelectorAll(".stage").forEach(function (el) {
      var idx = STAGES.indexOf(el.dataset.stage);
      el.classList.toggle("done", at > idx || (stage === "done" && idx <= at));
      el.classList.toggle("now", at === idx && stage !== "done");
    });
  }

  function renderState(info) {
    var note;
    if (info.status === "queued") {
      note = info.queued_behind > 0 ? info.queued_behind + " job(s) ahead of this one…" : "queued…";
    } else if (info.status === "running") {
      note = (info.detected ? info.detected + " · " : "") + (info.stage === "rerun" ? "re-running (the script fought back)" : info.stage);
    } else if (info.status === "done") {
      note = "done" + (info.detected ? " · " + info.detected : "");
    } else {
      note = info.error || info.status;
    }
    $("progress-note").textContent = note;
    $("bar-fill").style.width = (PCT[info.stage] || 5) + "%";
    stageClass(info.stage);
  }

  function logLine(line) {
    var cls = line.startsWith("[*]") ? "l-info"
      : line.startsWith("[+]") ? "l-ok"
      : line.startsWith("[!]") ? "l-warn"
      : line.startsWith("$") ? "l-cmd" : "";
    var el = document.createElement("span");
    if (cls) el.className = cls;
    el.textContent = line + "\n";
    var log = $("log");
    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.appendChild(el);
    if (atBottom) log.scrollTop = log.scrollHeight;
    var n = log.childElementCount;
    $("log-count").textContent = n;
    $("log-count").classList.add("on");
  }

  function startTicker() {
    var t0 = Date.now();
    state.ticker = setInterval(function () {
      $("elapsed").textContent = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    }, 100);
  }

  function stopWatching() {
    if (state.stream) { state.stream.close(); state.stream = null; }
    if (state.poll) { clearInterval(state.poll); state.poll = null; }
    if (state.ticker) { clearInterval(state.ticker); state.ticker = null; }
  }

  async function run() {
    fail($("submit-error"), "");
    $("log").textContent = "";
    $("log-count").classList.remove("on");
    show($("code-wrap"), false);
    show($("empty"), false);
    show($("stats"), false);
    show($("progress"), true);
    $("copy").disabled = $("download").disabled = true;
    show($("cancel"), true);
    startTicker();

    var info;
    try {
      info = await request("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: state.source, name: state.name, options: options() })
      });
    } catch (e) {
      stopWatching();
      show($("progress"), false);
      show($("cancel"), false);
      show($("empty"), true);
      fail($("submit-error"), e.message);
      return;
    }
    state.job = info;
    updateRun();
    renderState(info);
    watch(info.id);
  }

  function watch(id) {
    var seen = 0;
    var es;
    try {
      es = new EventSource(api("/api/jobs/" + id + "/events"));
    } catch (e) {
      es = null;
    }
    if (es) {
      state.stream = es;
      es.addEventListener("log", function (ev) {
        var lines = JSON.parse(ev.data);
        lines.forEach(logLine);
        seen += lines.length;
      });
      es.addEventListener("state", function (ev) { renderState(JSON.parse(ev.data)); });
      es.addEventListener("end", function (ev) { finish(JSON.parse(ev.data)); });
      es.onerror = function () {
        /* the stream dropped (proxy, sleep, ...): fall back to polling */
        es.close();
        state.stream = null;
        if (state.job) pollLoop(id, seen);
      };
    } else {
      pollLoop(id, 0);
    }
  }

  function pollLoop(id, seen) {
    if (state.poll) clearInterval(state.poll);
    state.poll = setInterval(async function () {
      try {
        var log = await request("/api/jobs/" + id + "/log?since=" + seen);
        log.lines.forEach(logLine);
        seen += log.lines.length;
        var info = await request("/api/jobs/" + id);
        renderState(info);
        if (info.status !== "queued" && info.status !== "running") finish(info);
      } catch (e) {
        clearInterval(state.poll);
        state.poll = null;
        finish({ status: "failed", error: e.message, stage: "failed", elapsed: 0 });
      }
    }, 900);
  }

  async function finish(info) {
    stopWatching();
    show($("cancel"), false);
    state.job = null;
    updateRun();
    renderState(info);
    $("elapsed").textContent = (info.elapsed || 0).toFixed(1) + "s";

    if (info.status !== "done") {
      show($("empty"), true);
      $("empty").innerHTML = "<p>" + (info.status === "cancelled" ? "Cancelled." : "No output.") +
        '</p><p class="muted"></p>';
      $("empty").querySelector(".muted").textContent =
        info.error || "The pipeline finished without writing a result — the log tab has the detail.";
      selectOut("log");
      return;
    }

    var code = await request("/api/jobs/" + info.id + "/result");
    showResult(code, info);
  }

  function showResult(code, info) {
    var lines = code.split("\n");
    $("gutter").textContent = lines.map(function (_, i) { return i + 1; }).join("\n");
    $("code").firstElementChild.innerHTML = window.LuauHighlight(code);
    show($("code-wrap"), true);
    show($("empty"), false);
    selectOut("code");

    state.result = code;
    $("copy").disabled = $("download").disabled = false;
    $("stats").innerHTML = "";
    [["obfuscator", info.detected || "—"],
     ["in", bytes(info.input_bytes)],
     ["out", bytes(info.result_bytes) + " · " + lines.length + " lines"],
     ["took", (info.elapsed || 0).toFixed(1) + "s"]
    ].forEach(function (pair) {
      var s = document.createElement("span");
      s.innerHTML = pair[0] + " <b></b>";
      s.querySelector("b").textContent = pair[1];
      $("stats").appendChild(s);
    });
    show($("stats"), true);
  }

  /* ----------------------------------------------------------------- tabs */

  function selectOut(which) {
    document.querySelectorAll("[data-out]").forEach(function (b) {
      b.classList.toggle("active", b.dataset.out === which);
    });
    document.querySelectorAll("[data-out-body]").forEach(function (b) {
      show(b, b.dataset.outBody === which);
    });
  }

  /* ------------------------------------------------------------ listeners */

  function wire() {
    /* input tabs */
    document.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("[data-tab]").forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });
        document.querySelectorAll("[data-body]").forEach(function (b) {
          show(b, b.dataset.body === btn.dataset.tab);
        });
      });
    });
    document.querySelectorAll("[data-out]").forEach(function (btn) {
      btn.addEventListener("click", function () { selectOut(btn.dataset.out); });
    });

    /* mode */
    document.querySelectorAll(".seg-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll(".seg-btn").forEach(function (b) {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-checked", b === btn ? "true" : "false");
        });
      });
    });

    /* file input */
    var drop = $("drop");
    $("file-input").addEventListener("change", function (e) {
      if (e.target.files[0]) readFile(e.target.files[0]);
    });
    drop.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file-input").click(); }
    });
    ["dragenter", "dragover"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); });
    });
    drop.addEventListener("drop", function (e) {
      var f = e.dataTransfer.files[0];
      if (f) readFile(f);
    });
    $("file-clear").addEventListener("click", function (e) {
      e.preventDefault();
      clearInput();
    });

    /* paste */
    var timer;
    $("paste").addEventListener("input", function (e) {
      clearTimeout(timer);
      var text = e.target.value;
      timer = setTimeout(function () {
        if (text.trim()) setSource(text, "pasted.lua");
        else { state.source = null; show($("detected"), false); updateRun(); }
      }, 550);
    });

    /* run / cancel */
    $("run").addEventListener("click", run);
    $("cancel").addEventListener("click", async function () {
      if (!state.job) return;
      try { await request("/api/jobs/" + state.job.id, { method: "DELETE" }); } catch (e) { /* gone */ }
    });

    /* result actions */
    $("copy").addEventListener("click", async function () {
      try {
        await navigator.clipboard.writeText(state.result);
        $("copy").textContent = "Copied";
        setTimeout(function () { $("copy").textContent = "Copy"; }, 1400);
      } catch (e) {
        fail($("submit-error"), "Clipboard blocked — use Download instead.");
      }
    });
    $("download").addEventListener("click", function () {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([state.result], { type: "text/plain" }));
      a.download = (state.name || "script").replace(/\.(lua|luau|txt)$/i, "") + ".deobf.luau";
      a.click();
      URL.revokeObjectURL(a.href);
    });

    /* backend panel */
    $("backend-btn").addEventListener("click", function () {
      var panel = $("backend-panel");
      show(panel, panel.classList.contains("hidden"));
      if (!panel.classList.contains("hidden")) {
        $("backend-url").value = state.base || localStorage.getItem(KEY) || "http://127.0.0.1:8000";
      }
    });
    $("backend-close").addEventListener("click", function () { show($("backend-panel"), false); });
    $("backend-save").addEventListener("click", async function () {
      var url = $("backend-url").value.trim().replace(/\/+$/, "");
      fail($("backend-error"), "");
      setStatus("busy", "connecting…");
      try {
        var health = await probe(url);
        localStorage.setItem(KEY, url);
        state.base = url;
        state.health = health;
        onHealth(health);
        if (state.source) detect();
      } catch (e) {
        setStatus("down", "no backend");
        fail($("backend-error"),
          "Could not reach " + (url || "this origin") + " — " + e.message +
          ". Is the server running, and does it allow this page's origin (DEOB_CORS_ORIGINS)?");
      }
    });
  }

  wire();
  selectOut("code");
  connect();
})();
