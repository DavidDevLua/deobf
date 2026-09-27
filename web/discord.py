"""
Reports finished jobs to a Discord webhook: one embed with how the run went,
plus the script that went in and the Luau that came out as attachments.

The webhook comes from DEOB_DISCORD_WEBHOOK, so it stays on the server - the
page has an equivalent reporter (web/static/discord-log.js) for runs that
happen in the browser, but there the URL is necessarily public. Nothing here
is required: with the variable unset, report() does nothing.

Reporting must never affect the job. It runs on a daemon thread and every
failure is swallowed after a log line.
"""
import json
import mimetypes  # noqa: F401  (imported for the stdlib's boundary-safe types)
import os
import sys
import threading
import urllib.error
import urllib.request
import uuid

WEBHOOK = os.environ.get("DEOB_DISCORD_WEBHOOK", "").strip()

GREEN = 0x4ADE80
RED = 0xF87171
GREY = 0x6B7385

# Discord takes 8 MB per request on an unboosted server
MAX_ATTACHMENT = int(os.environ.get("DEOB_DISCORD_MAX_ATTACHMENT", 3 * 1024 * 1024))
MAX_TOTAL = int(os.environ.get("DEOB_DISCORD_MAX_TOTAL", 6 * 1024 * 1024))
TIMEOUT = 30


def enabled():
    return bool(WEBHOOK)


def _bytes(n):
    if n < 1024:
        return "%d B" % n
    if n < 1024 * 1024:
        return "%.1f KB" % (n / 1024.0)
    return "%.2f MB" % (n / 1048576.0)


def _clip(s, limit):
    s = str(s) if s not in (None, "") else "—"
    return s if len(s) <= limit else s[:limit - 1] + "…"


def _field(name, value, inline=True):
    return {"name": name, "value": _clip(value, 1024), "inline": inline}


def _multipart(payload, files):
    """A multipart/form-data body: payload_json plus files[N]."""
    boundary = "----deobf" + uuid.uuid4().hex
    out = []
    sep = ("--" + boundary + "\r\n").encode()

    out.append(sep)
    out.append(b'Content-Disposition: form-data; name="payload_json"\r\n')
    out.append(b"Content-Type: application/json\r\n\r\n")
    out.append(json.dumps(payload).encode("utf-8") + b"\r\n")

    for i, (name, data) in enumerate(files):
        out.append(sep)
        out.append(('Content-Disposition: form-data; name="files[%d]"; filename="%s"\r\n'
                    % (i, name.replace('"', ""))).encode())
        out.append(b"Content-Type: application/octet-stream\r\n\r\n")
        out.append(data + b"\r\n")

    out.append(("--" + boundary + "--\r\n").encode())
    return b"".join(out), "multipart/form-data; boundary=" + boundary


def _build(job, source, result):
    ok = job.status == "done"
    fields = [
        _field("Obfuscator", job.detected or "—"),
        _field("Mode", "Trace only" if job.options.get("no_devirt") else "Devirtualize"),
        _field("Where", "server"),
        _field("Input", "%s\n%s · %s lines"
               % (_clip(job.name, 80), _bytes(len(source)), "{:,}".format(source.count("\n") + 1))),
    ]
    if ok and result is not None:
        fields.append(_field("Output", "%s · %s lines"
                             % (_bytes(len(result)), "{:,}".format(result.count("\n") + 1))))
    fields.append(_field("Took", "%.1fs" % job.elapsed))
    if not ok and job.error:
        fields.append(_field("Error", job.error, inline=False))

    embed = {
        "title": "Deobfuscated" if ok else ("Cancelled" if job.status == "cancelled" else "Failed"),
        "color": GREEN if ok else (GREY if job.status == "cancelled" else RED),
        "fields": fields,
        "footer": {"text": "deobf"},
    }

    files = []
    budget = MAX_TOTAL
    truncated = []
    base = (job.name or "script").rsplit(".", 1)[0][-60:] or "script"

    def attach(text, filename, encoding):
        nonlocal budget
        if not text:
            return
        room = min(MAX_ATTACHMENT, budget)
        if room <= 0:
            truncated.append(filename + " (left out, no room)")
            return
        data = text.encode(encoding, "replace")
        if len(data) > room:
            data = data[:room]
            truncated.append(filename)
        budget -= len(data)
        files.append((filename, data))

    attach(source, base + ".input.lua", "latin-1")
    if ok and result is not None:
        attach(result, base + ".deobf.luau", "utf-8")

    if truncated:
        embed["fields"].append(
            _field("Note", "truncated to fit Discord: " + ", ".join(truncated), inline=False))

    return {"username": "deobf", "embeds": [embed], "allowed_mentions": {"parse": []}}, files


def _post(job, source, result):
    try:
        payload, files = _build(job, source, result)
        body, content_type = _multipart(payload, files)
        req = urllib.request.Request(WEBHOOK, body, {"Content-Type": content_type},
                                     method="POST")
        with urllib.request.urlopen(req, timeout=TIMEOUT):
            pass
    except urllib.error.HTTPError as e:
        print("[!] discord: the webhook rejected the report (HTTP %s)" % e.code, file=sys.stderr)
    except Exception as e:                       # noqa: BLE001 - never fail a job over this
        print("[!] discord: could not reach the webhook (%s)" % e, file=sys.stderr)


def report(job, source, result):
    """Queue a report for a finished job. Returns at once."""
    if not WEBHOOK:
        return
    threading.Thread(target=_post, args=(job, source, result), daemon=True).start()
