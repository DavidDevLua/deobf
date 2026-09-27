/* Where a job runs.

   browser: the WebAssembly Luau plus Pyodide, in a worker - nothing to set up,
            but the first run downloads ~16 MB and Python is slower than native.
   server:  web/server.py over HTTP - the same pipeline at full speed, for when
            a script is big enough that the browser drags.

   Both expose the same three calls (health, detect, run) so app.js does not
   care which one is picked. */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------- browser */

  function BrowserEngine() {
    this.name = "browser";
    this.worker = null;
    this.seq = 0;
    this.pending = {};
    this.onlog = null;
    this.onstatus = null;
  }

  BrowserEngine.prototype._start = function () {
    if (this.worker) return this.worker;
    var self_ = this;
    this.worker = new Worker("deobf-worker.js", { type: "module" });
    this.worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === "log") {
        if (self_.onlog) self_.onlog(m.line);
        return;
      }
      if (m.type === "status") {
        if (self_.onstatus) self_.onstatus(m.text);
        return;
      }
      if (m.type === "ready") {
        self_.booted = true;
        if (self_.onstatus) self_.onstatus("ready");
        return;
      }
      var job = self_.pending[m.id];
      if (!job) return;
      delete self_.pending[m.id];
      if (m.type === "error") job.reject(new Error(m.message));
      else if (m.type === "detected") job.resolve(m.result);
      else if (m.type === "done") job.resolve(m);
    };
    /* A worker that runs out of memory dies without an exception - the
       browser just tears it down. Everything waiting on it has to be failed
       here, or the page sits there looking busy forever. */
    function die(message) {
      var err = new Error(message);
      Object.keys(self_.pending).forEach(function (k) {
        self_.pending[k].reject(err);
        delete self_.pending[k];
      });
      self_.worker = null;
      self_.booted = false;
    }

    this.worker.onerror = function (e) {
      die(e.message ||
          "the deobfuscator stopped. A very large script can exhaust the memory a tab " +
          "is allowed; try Trace only, or run the server (see the engine settings).");
    };
    this.worker.onmessageerror = function () {
      die("the result was too large to hand back to the page");
    };
    return this.worker;
  };

  BrowserEngine.prototype._send = function (msg) {
    var self_ = this;
    this._start();
    msg.id = ++this.seq;
    return new Promise(function (resolve, reject) {
      self_.pending[msg.id] = { resolve: resolve, reject: reject };
      self_.worker.postMessage(msg);
    });
  };

  BrowserEngine.prototype.health = function () {
    this._start();
    /* nothing to reach: the engine is the page. The plugin list is fixed, and
       naming it here avoids booting Pyodide before the first real job. */
    return Promise.resolve({
      ok: true,
      luau: true,
      advanced: true,
      where: "browser",
      obfuscators: [
        { name: "luraph_v15", label: "Luraph v15" },
        { name: "ironbrew1", label: "ironbrew1" },
        { name: "generic", label: "unknown obfuscator (behaviour trace only)" }
      ]
    });
  };

  BrowserEngine.prototype.detect = function (source) {
    return this._send({ type: "detect", source: source });
  };

  BrowserEngine.prototype.run = function (source, name, options) {
    return this._send({ type: "run", source: source, name: name, options: options });
  };

  BrowserEngine.prototype.cancel = function () {
    /* a WebAssembly call cannot be interrupted from outside, so the only way
       to stop a running job is to throw the worker away */
    if (!this.worker) return Promise.resolve();
    this.worker.terminate();
    this.worker = null;
    this.booted = false;
    var err = new Error("cancelled");
    var self_ = this;
    Object.keys(this.pending).forEach(function (k) {
      self_.pending[k].reject(err);
      delete self_.pending[k];
    });
    return Promise.resolve();
  };

  /* -------------------------------------------------------------- server */

  function ServerEngine(base) {
    this.name = "server";
    this.base = base || "";
    this.jobId = null;
    this.onlog = null;
    this.onstatus = null;
  }

  ServerEngine.prototype._req = async function (path, init) {
    var res = await fetch(this.base + path, init);
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* plain text */ }
    if (!res.ok) {
      var msg = (data && (data.detail || data.message)) || text || ("HTTP " + res.status);
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data !== null ? data : text;
  };

  ServerEngine.prototype.health = function () {
    var self_ = this;
    return this._req("/api/health").then(function (h) {
      h.where = "server";
      return h;
    });
  };

  ServerEngine.prototype.detect = function (source) {
    return this._req("/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: source })
    });
  };

  ServerEngine.prototype.run = async function (source, name, options) {
    var self_ = this;
    var info = await this._req("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: source, name: name, options: options })
    });
    this.jobId = info.id;
    var seen = 0;
    var t0 = Date.now();
    /* poll rather than SSE: the engine interface is one promise per job, and
       the log lines arrive through the same onlog callback either way */
    for (;;) {
      var log = await this._req("/api/jobs/" + info.id + "/log?since=" + seen);
      log.lines.forEach(function (l) { if (self_.onlog) self_.onlog(l); });
      seen += log.lines.length;
      var state = await this._req("/api/jobs/" + info.id);
      if (self_.onstatus) self_.onstatus(state.stage);
      if (state.status === "done") {
        this.jobId = null;
        return { text: await this._req("/api/jobs/" + info.id + "/result"),
                 ms: Date.now() - t0, detected: state.detected };
      }
      if (state.status !== "queued" && state.status !== "running") {
        this.jobId = null;
        throw new Error(state.error || state.status);
      }
      await new Promise(function (r) { setTimeout(r, 700); });
    }
  };

  ServerEngine.prototype.cancel = function () {
    if (!this.jobId) return Promise.resolve();
    return this._req("/api/jobs/" + this.jobId, { method: "DELETE" }).catch(function () {});
  };

  global.Engines = { Browser: BrowserEngine, Server: ServerEngine };
})(window);
