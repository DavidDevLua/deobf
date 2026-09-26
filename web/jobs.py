"""
Job store and runner for the web front end.

One upload = one `deob.py` subprocess in a temp folder (the pipeline keeps
global state, so it must not be imported into this long-lived process; see
CLAUDE.md "Usage"). Jobs run on a small thread pool, their merged
stdout/stderr is kept line by line so the browser can stream it, and the
result text is held in memory until the TTL expires.
"""
import itertools
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEOB = os.path.join(ROOT, "deobf", "deob.py")


def _env_int(name, default):
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


# Limits (all overridable by environment variable, see web/README.md)
MAX_UPLOAD = _env_int("DEOB_MAX_UPLOAD", 12 * 1024 * 1024)
MAX_CONCURRENCY = _env_int("DEOB_CONCURRENCY", 2)
MAX_QUEUE = _env_int("DEOB_MAX_QUEUE", 16)
JOB_TIMEOUT = _env_int("DEOB_JOB_TIMEOUT", 900)
RESULT_TTL = _env_int("DEOB_RESULT_TTL", 3600)
MAX_LOG_LINES = _env_int("DEOB_MAX_LOG_LINES", 4000)
ALLOW_ADVANCED = (os.environ.get("DEOB_ALLOW_ADVANCED", "1").lower()
                  not in ("0", "false", "no"))

# Stage names for the progress bar, matched against the pipeline's own
# `[*] ...` lines in order (last match wins).
STAGES = [
    ("detect", re.compile(r"^\[\*\] obfuscator:")),
    ("trace", re.compile(r"^\[\*\] (tracing|replaying|\d+ Path2D)")),
    ("rerun", re.compile(r"^\[\*\] (script loadstring'd|anti-tamper|the script never finished)")),
    ("lift", re.compile(r"^\[\*\] devirtualiz")),
    ("lift", re.compile(r"^\[\*\] (constant|devirt round|  )")),
    ("polish", re.compile(r"^\[\*\] (patched|\d+ flattened)")),
    ("done", re.compile(r"^\[\+\] result:")),
]

_STATUS_RE = re.compile(r"^\[\*\] obfuscator: (.+?)(?: \(detected, ([0-9.]+)\))?$")


class JobError(Exception):
    """A request that cannot be accepted (too big, queue full, ...)."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


class Job:
    _ids = itertools.count(1)

    def __init__(self, name, source, options):
        self.id = uuid.uuid4().hex[:16]
        self.number = next(Job._ids)
        self.name = name
        self.source = source
        self.options = options
        self.status = "queued"          # queued | running | done | failed | cancelled
        self.stage = "queued"
        self.detected = None            # human label of the obfuscator that ran
        self.confidence = None
        self.error = None
        self.log = []
        self.result = None              # deobfuscated text
        self.created = time.time()
        self.started = None
        self.finished = None
        self.exit_code = None
        self._proc = None
        self._cancel = False
        self._scrub = None          # temp folder to keep out of the streamed log
        self._lock = threading.Lock()

    # -- reporting ---------------------------------------------------------

    @property
    def elapsed(self):
        end = self.finished or time.time()
        return round(end - (self.started or self.created), 2)

    def info(self):
        out = {
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "stage": self.stage,
            "detected": self.detected,
            "confidence": self.confidence,
            "elapsed": self.elapsed,
            "input_bytes": len(self.source),
            "log_lines": len(self.log),
            "queued_behind": max(0, RUNNER.position(self)),
        }
        if self.error:
            out["error"] = self.error
        if self.result is not None:
            out["result_bytes"] = len(self.result)
            out["result_lines"] = self.result.count("\n") + 1
        return out

    def append(self, line):
        if self._scrub:
            line = line.replace(os.path.join(self._scrub, "result"), "output")
            line = line.replace(self._scrub + os.sep, "").replace(self._scrub, "")
        with self._lock:
            if len(self.log) < MAX_LOG_LINES:
                self.log.append(line)
            elif len(self.log) == MAX_LOG_LINES:
                self.log.append("[!] log truncated")

    def tail(self, since):
        with self._lock:
            return self.log[since:]

    # -- running -----------------------------------------------------------

    def cancel(self):
        self._cancel = True
        proc = self._proc
        if proc and proc.poll() is None:
            _kill(proc)
        if self.status in ("queued", "running"):
            self.status = "cancelled"
            self.stage = "cancelled"
            self.finished = time.time()

    def run(self):
        if self._cancel:
            return
        self.status = "running"
        self.stage = "starting"
        self.started = time.time()
        workdir = tempfile.mkdtemp(prefix="deobweb_")
        try:
            self._run_in(workdir)
        except Exception as e:                       # noqa: BLE001 - reported to the browser
            self.status = "failed"
            self.error = "%s: %s" % (type(e).__name__, e)
            self.append("[!] " + self.error)
        finally:
            self.finished = time.time()
            if self.status == "running":
                self.status = "done" if self.result is not None else "failed"
            if self.status in ("done", "failed") and self.stage != "done":
                self.stage = self.stage if self.status == "failed" else "done"
            shutil.rmtree(workdir, ignore_errors=True)

    def _run_in(self, workdir):
        self._scrub = workdir
        in_path = os.path.join(workdir, safe_name(self.name))
        out_path = os.path.join(workdir, "result", os.path.basename(in_path))
        with open(in_path, "w", encoding="latin-1", newline="") as f:
            f.write(self.source)
        argv = build_argv(in_path, out_path, self.options)
        # echo the options, not the temp paths the browser has no business seeing
        shown = ["deob.py", self.name] + argv[argv.index("--timeout"):]
        self.append("$ " + " ".join(shown))
        env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
        self._proc = subprocess.Popen(
            argv, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, env=env, start_new_session=True,
            bufsize=1, universal_newlines=True, errors="replace")
        deadline = time.time() + JOB_TIMEOUT
        timed_out = False
        for raw in self._proc.stdout:
            line = raw.rstrip("\r\n")
            if line:
                self.append(line)
                self._note(line)
            if time.time() > deadline:
                timed_out = True
                self.append("[!] job timeout after %ds: stopping" % JOB_TIMEOUT)
                _kill(self._proc)
                break
        self.exit_code = self._proc.wait()
        if self._cancel:
            self.status = "cancelled"
            self.error = "cancelled"
            return
        if timed_out:
            self.status = "failed"
            self.error = "timed out after %ds" % JOB_TIMEOUT
            return
        if os.path.exists(out_path):
            with open(out_path, encoding="utf-8", errors="replace") as f:
                self.result = f.read()
            self.status = "done"
            self.stage = "done"
        else:
            self.status = "failed"
            self.error = self._guess_error()

    def _note(self, line):
        m = _STATUS_RE.match(line)
        if m:
            self.detected = m.group(1)
            self.confidence = float(m.group(2)) if m.group(2) else None
        for stage, rx in STAGES:
            if rx.match(line):
                self.stage = stage
                break

    def _guess_error(self):
        for line in reversed(self.log):
            if line.startswith("[!]"):
                return line[4:].strip()
        return "the pipeline produced no output (exit %s)" % self.exit_code


def _kill(proc):
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:                                # noqa: BLE001 - already gone
        try:
            proc.kill()
        except Exception:                            # noqa: BLE001
            pass


def safe_name(name):
    """A file name safe to write into a temp folder, keeping the extension."""
    name = os.path.basename(name or "script.lua").replace("\x00", "")
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).lstrip(".") or "script.lua"
    if not re.search(r"\.(lua|luau|txt)$", name, re.I):
        name += ".lua"
    return name[-80:]


def build_argv(in_path, out_path, opt):
    """The deob.py command line for one job's options (already validated)."""
    argv = [sys.executable, DEOB, in_path, "-o", out_path,
            "--timeout", str(opt["timeout"]), "--budget", str(opt["budget"]),
            "--executor", opt["executor"]]
    if opt.get("obfuscator"):
        argv += ["--obfuscator", opt["obfuscator"]]
    if opt.get("no_devirt"):
        argv.append("--no-devirt")
    if opt.get("no_fold"):
        argv.append("--no-fold")
    if opt.get("no_tidy"):
        argv.append("--no-tidy")
    if opt.get("keep_preamble"):
        argv.append("--keep-preamble")
    if opt.get("strings"):
        argv.append("--strings")
    if opt.get("input_text"):
        argv += ["--input-text", opt["input_text"]]
    for kv in opt.get("cfg", []):
        argv += ["--cfg", kv]
    return argv


class Runner:
    """Thread pool with a bounded queue and a TTL sweep over finished jobs."""

    def __init__(self):
        self.jobs = {}
        self.order = []                 # job ids, oldest first
        self.pending = []               # queued job ids, in submission order
        self.pool = ThreadPoolExecutor(max_workers=MAX_CONCURRENCY,
                                       thread_name_prefix="deob")
        self.lock = threading.Lock()

    def submit(self, job):
        with self.lock:
            self._sweep()
            if len(self.pending) >= MAX_QUEUE:
                raise JobError("the queue is full (%d waiting); try again in a minute"
                               % len(self.pending), 503)
            self.jobs[job.id] = job
            self.order.append(job.id)
            self.pending.append(job.id)
        self.pool.submit(self._work, job)
        return job

    def _work(self, job):
        with self.lock:
            if job.id in self.pending:
                self.pending.remove(job.id)
        job.run()

    def get(self, jid):
        with self.lock:
            return self.jobs.get(jid)

    def position(self, job):
        with self.lock:
            return self.pending.index(job.id) if job.id in self.pending else -1

    def stats(self):
        with self.lock:
            running = sum(1 for j in self.jobs.values() if j.status == "running")
            return {"running": running, "queued": len(self.pending),
                    "capacity": MAX_CONCURRENCY, "queue_limit": MAX_QUEUE}

    def _sweep(self):
        """Drop jobs whose results have expired (called under the lock)."""
        cutoff = time.time() - RESULT_TTL
        keep = []
        for jid in self.order:
            job = self.jobs.get(jid)
            if job and job.finished and job.finished < cutoff:
                del self.jobs[jid]
            elif job:
                keep.append(jid)
        self.order = keep


RUNNER = Runner()


def detect(source, name="script.lua"):
    """`deob.py --detect` on `source`: (name, confidence, label)."""
    tmp = tempfile.mkdtemp(prefix="deobdet_")
    try:
        path = os.path.join(tmp, safe_name(name))
        with open(path, "w", encoding="latin-1", newline="") as f:
            f.write(source)
        out = subprocess.run([sys.executable, DEOB, path, "--detect"], cwd=ROOT,
                             capture_output=True, text=True, timeout=60)
        if out.returncode != 0:
            raise JobError((out.stderr or "detection failed").strip()[-300:], 500)
        parts = out.stdout.strip().split("\t")
        if len(parts) != 3:
            raise JobError("unexpected detector output: " + out.stdout.strip()[:200], 500)
        conf = None if parts[1] == "forced" else float(parts[1])
        return {"obfuscator": parts[0], "confidence": conf, "label": parts[2]}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
