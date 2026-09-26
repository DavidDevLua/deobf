# deobf

**Protected Roblox Luau in, readable Luau out — in your browser.**

deobf is a *dynamic* deobfuscator. It does not pattern-match the protection
away: it runs the protected script in a real Luau VM against a fake
Roblox/executor environment, watches what it does, and rebuilds source from
that. For the obfuscators it knows it goes further and lifts the VM bytecode
back to real Luau — with control flow, locals, closures, and the branches that
never ran.

This repository is the pipeline plus a web front end for it.

| Obfuscator | Detection | Output |
|---|---|---|
| Luraph v15 | automatic | devirtualized Luau (falls back to a trace) |
| IronBrew 1 | automatic | devirtualized Luau (falls back to a trace) |
| anything else | fallback | behaviour trace, rendered as Luau |

---

## Run the website

The page is static, but the pipeline behind it is not: it spawns a real Luau
VM per job, so it needs a machine to run on. Both come out of this repo.

### Docker (one command)

```bash
git clone https://github.com/riftwarewtf/deobf
cd deobf
docker compose up --build        # http://localhost:8000
```

The first build takes a few minutes — it compiles a patched Luau from source
(see [Why a patched Luau](#why-a-patched-luau)). After that it starts instantly.

### Without Docker

```bash
git clone https://github.com/riftwarewtf/deobf
cd deobf
python deobf/build_luau.py --portable    # once: needs git, cmake, a C++ compiler
pip install -r web/requirements.txt
python web/server.py                     # http://127.0.0.1:8000
```

Open the address, drop in a `.lua`/`.luau` file, hit **Deobfuscate**. The
obfuscator is detected as soon as the script is loaded; the log tab streams
what the pipeline is doing while it works.

### The page on GitHub Pages

`web/static/` is plain HTML/CSS/JS with no build step, so the same interface
can be served from GitHub Pages — it asks once for the URL of your server and
remembers it. `.github/workflows/pages.yml` publishes it on every push to
`main`; enable it under **Settings → Pages → Source: GitHub Actions**.

That split is deliberate: Pages can host the interface, never the pipeline.
Only the interface is public; the scripts you feed it go to the backend you
control.

---

## Use it from the command line

The web front end is a wrapper around the CLI, which is still the fastest path
for one-off work:

```bash
python deobf/deob.py script.lua               # -> script's folder/output/script.lua
python deobf/deob.py script.lua --detect      # NAME<tab>confidence<tab>label
python deobf/deob.py script.lua --no-devirt   # fast: behaviour trace only
python deobf/deob.py script.lua --debug       # keep every intermediate file
python deobf/deob.py --help                   # everything else
```

Scripts that read their settings from `_G`/`getgenv()` stop early on their own
("you didn't set a webhook"). Drive them further with runtime options, on the
command line or in the page's **Advanced** box:

```bash
--cfg "prelude=rawset(G,'webhook','x') setprop(game,'PlaceId',123)"
--cfg falsy=isPremium,hasGamepass
```

## HTTP API

Everything the page does is available directly. Full reference in
[`web/README.md`](web/README.md).

```bash
curl -F file=@script.lua http://localhost:8000/api/detect

JOB=$(curl -sF file=@script.lua http://localhost:8000/api/jobs | jq -r .id)
curl -N  http://localhost:8000/api/jobs/$JOB/events     # live progress (SSE)
curl -sO http://localhost:8000/api/jobs/$JOB/download   # the result
```

---

## How it works

1. **Detect** — each plugin scores the source (header comments, signature
   strings, VM shape). The best score above 0.5 wins; below that the generic
   trace runs.
2. **Trace** — the script runs in the real Luau VM. Every Roblox object is a
   proxy, so every property set, method call and event connection is recorded
   and rendered back as Luau. Nothing touches the network or Roblox.
3. **Lift** (known VM obfuscators) — the VM's bytecode and captured closures
   are walked into an IR, then structured back into real Luau: control flow,
   loops, locals, closures, and branches the trace never took.
4. **Polish** — repeated statement runs fold back into helper functions and
   loops, locals get names inferred from how they are used (the originals are
   not in the bytecode), and the text is spaced like normal Luau.

`CLAUDE.md` documents the architecture; `LURAPH.md` and `IRONBREW1.md` cover
the two VM front ends.

### Why a patched Luau

In Roblox, `Vector3` *is* the native vector type and the engine hangs the
Vector3 members off its metatable. Stock Luau freezes that metatable, so
`v.Magnitude` and `v:Dot(w)` fail and scripts that use them die mid-trace.
`deobf/build_luau.py` builds Luau 0.739 with that one freeze removed. This is
why the binaries are built rather than downloaded, and why they are not
committed.

## Layout

```
deobf/            the pipeline (pure Python, standard library only)
  deob.py         CLI entry point
  harness.py      builds and runs the Luau harnesses
  envlog.luau     the fake Roblox/executor environment
  obfuscators/    one plugin per obfuscator
  bin/            luau, luau-ast (built, git-ignored)
web/
  server.py       FastAPI app: upload, progress, result
  jobs.py         job queue; one deob.py subprocess per job
  smoke.py        end-to-end check against samples/
  static/         the page (no build step, Pages-ready)
samples/          test scripts + their expected output
```

## Notes

- **It executes the script you give it.** That is the whole method — there is
  no static mode. The Luau VM it runs in has no `io` library and no network,
  the Roblox side is a fake, and the container runs as a non-root user, but
  treat the backend as something that runs untrusted code and keep it
  isolated. Only feed it scripts you are allowed to inspect.
- A trace only contains the branches that actually ran. Devirtualized output
  includes untaken branches; trace output notes conditions in comments.
- Local names are inferred from use. The original names are not in the
  bytecode and cannot be recovered.
- Large Luraph scripts take minutes, and the pipeline re-runs the script when
  it trips an anti-tamper trap. The log tab shows each round.
