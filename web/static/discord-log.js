/* Reports every run to a Discord webhook: one embed with what was run and how
   it went, plus the script that went in and the Luau that came out as
   attachments.

   Fire and forget. A webhook that is rate limited, revoked, blocked by an
   extension or simply down must never affect the run the person asked for, so
   everything here is wrapped and failures are swallowed after a console note.

   Discord's limits, which shape the code below:
     embed title 256, field value 1024, 25 fields, 6000 chars over the embed;
     8 MB for the whole request on an unboosted server (see config.js). */
(function (global) {
  "use strict";

  var GREEN = 0x4ade80;
  var RED = 0xf87171;
  var GREY = 0x6b7385;

  function cfg() {
    return global.DeobfConfig || {};
  }

  function bytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  function countLines(s) {
    var n = 1;
    for (var i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
  }

  function clip(s, max) {
    s = String(s === undefined || s === null || s === "" ? "—" : s);
    return s.length <= max ? s : s.slice(0, max - 1) + "…";
  }

  function field(name, value, inline) {
    return { name: name, value: clip(value, 1024), inline: inline !== false };
  }

  /* The obfuscated input is latin-1 - one char per byte, as deob.py reads it -
     so it has to go out as those bytes. A plain Blob would UTF-8 encode it and
     every byte above 127 would come back wrong. */
  function latin1Blob(text, type) {
    var b = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;
    return new Blob([b], { type: type || "text/plain" });
  }

  function utf8Blob(text, type) {
    return new Blob([text], { type: (type || "text/plain") + ";charset=utf-8" });
  }

  function browserName() {
    var ua = navigator.userAgent;
    var m = /(Firefox|Edg|OPR|Chrome|Version)\/([\d.]+)/.exec(ua);
    var name = m ? ({ Edg: "Edge", OPR: "Opera", Version: "Safari" }[m[1]] || m[1]) : "browser";
    var os = /iPhone|iPad|iPod/.test(ua) ? "iOS"
      : /Android/.test(ua) ? "Android"
      : /Mac OS X/.test(ua) ? "macOS"
      : /Windows/.test(ua) ? "Windows"
      : /Linux/.test(ua) ? "Linux" : "";
    return (name + (m ? " " + m[2].split(".")[0] : "") + (os ? " · " + os : "")).trim();
  }

  /**
   * @param {object} run
   *   {status, name, source, result, detected, mode, engine, elapsed, error}
   */
  function report(run) {
    var url = cfg().discordWebhook;
    if (!url) return Promise.resolve(false);

    try {
      return send(url, run);
    } catch (e) {
      if (global.console) console.warn("deobf: could not report the run:", e);
      return Promise.resolve(false);
    }
  }

  function send(url, run) {
    var ok = run.status === "done";
    var source = run.source || "";
    var result = run.result || "";

    var fields = [
      field("Obfuscator", run.detected || "—"),
      field("Mode", run.mode === "trace" ? "Trace only" : "Devirtualize"),
      field("Where", run.engine === "server" ? "server" : "in the browser"),
      field("Input", clip(run.name || "script.lua", 80) + "\n" +
                     bytes(source.length) + " · " + countLines(source).toLocaleString() + " lines")
    ];

    if (ok) {
      fields.push(field("Output", bytes(result.length) + " · " +
                                  countLines(result).toLocaleString() + " lines"));
    }
    fields.push(field("Took", (run.elapsed || 0).toFixed(1) + "s"));
    fields.push(field("Browser", browserName()));
    if (!ok && run.error) {
      fields.push(field("Error", run.error, false));
    }

    var embed = {
      title: ok ? "Deobfuscated" : (run.status === "cancelled" ? "Cancelled" : "Failed"),
      color: ok ? GREEN : (run.status === "cancelled" ? GREY : RED),
      fields: fields,
      footer: { text: "deobf" },
      timestamp: new Date().toISOString()
    };

    var form = new FormData();
    var files = [];
    var budget = cfg().maxTotalAttachmentBytes || 6 * 1024 * 1024;
    var each = cfg().maxAttachmentBytes || 3 * 1024 * 1024;
    var truncated = [];

    function attach(text, filename, latin1) {
      if (!text) return;
      var room = Math.min(each, budget);
      if (room <= 0) { truncated.push(filename + " (left out, no room)"); return; }
      var body = text;
      if (body.length > room) {
        body = body.slice(0, room);
        truncated.push(filename);
      }
      budget -= body.length;
      files.push({ name: filename, blob: latin1 ? latin1Blob(body) : utf8Blob(body) });
    }

    var base = (run.name || "script").replace(/\.(lua|luau|txt)$/i, "").slice(-60) || "script";
    if (cfg().attachInput !== false) attach(source, base + ".input.lua", true);
    if (ok && cfg().attachOutput !== false) attach(result, base + ".deobf.luau", false);

    if (truncated.length) {
      embed.fields.push(field("Note", "truncated to fit Discord: " + truncated.join(", "), false));
    }

    form.append("payload_json", JSON.stringify({
      username: "deobf",
      embeds: [embed],
      allowed_mentions: { parse: [] }
    }));
    files.forEach(function (f, i) {
      form.append("files[" + i + "]", f.blob, f.name);
    });

    return fetch(url, { method: "POST", body: form })
      .then(function (res) {
        if (!res.ok && global.console) {
          console.warn("deobf: the webhook rejected the report (HTTP " + res.status + ")");
        }
        return res.ok;
      })
      .catch(function (e) {
        /* blocked by an extension, offline, revoked webhook - none of it is
           the person's problem */
        if (global.console) console.warn("deobf: could not reach the webhook:", e);
        return false;
      });
  }

  global.DeobfLog = { report: report, enabled: function () { return !!cfg().discordWebhook; } };
})(window);
