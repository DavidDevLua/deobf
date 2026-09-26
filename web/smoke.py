"""
End-to-end check of a running server: submit every sample, wait for the
result, compare it with samples/output/. Used by CI and handy by hand.

    python web/server.py &
    python web/smoke.py [http://127.0.0.1:8000]
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(ROOT, "samples")
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
POLL_TIMEOUT = 1800


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return r.read().decode("utf-8")


def post(path, obj):
    req = urllib.request.Request(BASE + path, json.dumps(obj).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def wait(jid):
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        info = json.loads(get("/api/jobs/" + jid))
        if info["status"] not in ("queued", "running"):
            return info
        time.sleep(2)
    raise SystemExit("[!] job %s never finished" % jid)


def check(name):
    want_path = os.path.join(SAMPLES, "output", name)
    with open(os.path.join(SAMPLES, name), encoding="latin-1") as f:
        source = f.read()
    print("[*] %s (%d bytes)" % (name, len(source)))
    info = post("/api/jobs", {"source": source, "name": name})
    info = wait(info["id"])
    if info["status"] != "done":
        print("\n".join(json.loads(get("/api/jobs/%s/log" % info["id"]))["lines"]))
        print("[!] %s: %s" % (name, info.get("error") or info["status"]))
        return False
    got = get("/api/jobs/%s/result" % info["id"])
    with open(want_path, encoding="utf-8") as f:
        want = f.read()
    if got != want:
        print("[!] %s: the result differs from %s" % (name, want_path))
        return False
    print("[+] %s: %s in %.1fs, %d bytes out"
          % (name, info["detected"], info["elapsed"], info["result_bytes"]))
    return True


def main():
    health = json.loads(get("/api/health"))
    if not health.get("luau"):
        raise SystemExit("[!] the server has no Luau runtime: "
                         "run `python deobf/build_luau.py --portable`")
    print("[*] %s: %d plugin(s), %s" % (BASE, len(health["obfuscators"]), health["queue"]))

    names = sorted(n for n in os.listdir(os.path.join(SAMPLES, "output")) if n.endswith(".lua"))
    if not names:
        raise SystemExit("[!] no expected outputs in samples/output/")
    ok = all([check(n) for n in names])       # run them all, then report
    print("[+] all %d sample(s) matched" % len(names) if ok else "[!] smoke test failed")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
