"""
Builds web/static/luau-wasm.js: the Luau runtime the browser deobfuscator runs
protected scripts in.

Two patches on top of Luau, both needed for the trace to match the native
pipeline's:
  * the vector metatable is left writable (same patch as deobf/build_luau.py,
    imported from there) so envlog.luau can install Roblox's Vector3 members;
  * writestring in lbaselib.cpp goes through a hook, so print output is
    captured as bytes - the harness emits NUL-prefixed control lines that do
    not survive emscripten's stdout handling.

    python web/wasm/build_wasm.py [--tag 0.739] [--src DIR] [--debug]

Needs emscripten (emcc) and git.
"""
import argparse
import multiprocessing
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, "web", "static")
sys.path.insert(0, os.path.join(ROOT, "deobf"))

import build_luau  # noqa: E402  - reuse its repo, tag and vector patch

WRITE_HOOK_OLD = """static void writestring(const char* s, size_t l)
{
    fwrite(s, 1, l, stdout);
}"""
WRITE_HOOK_NEW = """// deobf: the browser build captures output as bytes (see web/wasm/luau_web.cpp)
extern "C" void (*luau_writestring_hook)(const char* s, size_t l) = nullptr;

static void writestring(const char* s, size_t l)
{
    if (luau_writestring_hook)
        luau_writestring_hook(s, l);
    else
        fwrite(s, 1, l, stdout);
}"""


def run(cmd, cwd=None):
    print("[*] " + " ".join(cmd[:6]) + (" ..." if len(cmd) > 6 else ""), file=sys.stderr)
    # check=False + explicit exit: a failed em++ line is thousands of
    # characters, and CalledProcessError prints all of it over the real error
    if subprocess.run(cmd, cwd=cwd).returncode != 0:
        sys.exit("[!] %s failed (see the error above)" % cmd[0])


def patch_writestring(src):
    path = os.path.join(src, "VM", "src", "lbaselib.cpp")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if "luau_writestring_hook" in text:
        return
    if text.count(WRITE_HOOK_OLD) != 1:
        sys.exit("[!] lbaselib.cpp changed upstream: patch writestring() by hand")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text.replace(WRITE_HOOK_OLD, WRITE_HOOK_NEW))


def includes(src):
    out = []
    for part in ("VM", "Compiler", "Ast", "Bytecode", "Analysis", "Common"):
        out += ["-I" + os.path.join(src, part, "include")]
    return out + ["-I" + os.path.join(src, "VM", "src")]


def sources(src):
    """Every .cpp of the VM, compiler, AST and bytecode builder.

    Not the CLI (no file system here) and not Analysis (type checking is
    irrelevant to running a script).
    """
    out = []
    for part in ("VM", "Compiler", "Ast", "Bytecode", "Common"):
        d = os.path.join(src, part, "src")
        out += [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith(".cpp")]
    # the only Analysis file needed: luau-ast's JSON printer (no type checking)
    out.append(os.path.join(src, "Analysis", "src", "AstJsonEncoder.cpp"))
    return out


def compile_one(job):
    """One .cpp -> .o. Top level so multiprocessing can pickle it."""
    cpp, obj, flags = job
    r = subprocess.run(["em++", "-c", cpp, "-o", obj] + flags,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return cpp, r.returncode, r.stdout.decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("--tag", default=build_luau.TAG, help="Luau release tag (default %(default)s)")
    ap.add_argument("--src", help="existing checkout to use (default: fresh clone in a temp folder)")
    ap.add_argument("--debug", action="store_true", help="assertions on, no minification")
    args = ap.parse_args()

    if not shutil.which("emcc"):
        sys.exit("[!] emcc not found: install emscripten (apt install emscripten, or emsdk)")

    tmp = None
    src = args.src
    if not src:
        tmp = tempfile.mkdtemp(prefix="luau-wasm-")
        src = os.path.join(tmp, "luau")
        run(["git", "clone", "-q", "--depth", "1", "--branch", args.tag, build_luau.REPO, src])

    build_luau.patch(src)        # vector metatable left writable
    patch_writestring(src)

    os.makedirs(OUT, exist_ok=True)
    # an ES module: Pyodide needs a module worker, where importScripts
    # does not exist, so everything the worker pulls in has to be importable
    target = os.path.join(OUT, "luau-wasm.mjs")

    # one em++ call per file, in parallel: passing all ~60 at once compiles them
    # one after another and takes about ten minutes
    objdir = tempfile.mkdtemp(prefix="luau-wasm-obj-")
    # -fexceptions: emcc defaults to -fignore-exceptions, under which Luau's
    # internal throws (ParseError, CompileError) abort the module instead of
    # being caught - a number gets thrown out to JS and the run dies
    cflags = ["-std=c++17", "-fexceptions",
              "-O3" if not args.debug else "-O0"] + includes(src)
    jobs = []
    for i, cpp in enumerate([os.path.join(HERE, "luau_web.cpp")] + sources(src)):
        obj = os.path.join(objdir, "%02d_%s.o" % (i, os.path.basename(cpp)[:-4]))
        jobs.append((cpp, obj, cflags))

    print("[*] compiling %d files on %d cores" % (len(jobs), multiprocessing.cpu_count()),
          file=sys.stderr)
    with multiprocessing.Pool(multiprocessing.cpu_count()) as pool:
        for cpp, code, log in pool.imap_unordered(compile_one, jobs):
            if code != 0:
                print(log, file=sys.stderr)
                sys.exit("[!] failed to compile " + cpp)

    cmd = ["em++", "-fexceptions", "-O3" if not args.debug else "-O0"] + [j[1] for j in jobs]
    cmd += [
        "-s", "WASM=1",
        "-s", "MODULARIZE=1",
        "-s", "EXPORT_ES6=1",
        "-s", "EXPORT_NAME=createLuau",
        "-s", "ENVIRONMENT=web,worker",
        "-s", "ALLOW_MEMORY_GROWTH=1",
        # A phone's tab gets a small fraction of a desktop's memory, and a
        # large maximum makes Safari reserve accordingly. 1 GB is far more
        # than running one harness needs - the biggest thing in here is the
        # captured trace - and it keeps the reservation modest.
        "-s", "MAXIMUM_MEMORY=1GB",
        "-s", "INITIAL_MEMORY=32MB",
        # protected scripts nest deeply; the parser and the VM both recurse.
        # TOTAL_STACK is the old spelling; emscripten renamed it STACK_SIZE in
        # 3.1.27 and still accepts this one. It is carved out of the initial
        # memory, so INITIAL_MEMORY has to stay comfortably above it.
        "-s", "TOTAL_STACK=16MB",
        "-s", "EXPORTED_FUNCTIONS=" +
              "['_luauRun','_luauAst','_luauOutput','_luauOutputSize','_luauError','_luauReset',"
              "'_malloc','_free']",
        "-s", "EXPORTED_RUNTIME_METHODS=['ccall','cwrap','HEAPU8','stringToUTF8','lengthBytesUTF8','UTF8ToString']",
        # one file: GitHub Pages serves it from any path without MIME surprises
        "-s", "SINGLE_FILE=1",
        "-o", target,
    ]
    if args.debug:
        cmd += ["-s", "ASSERTIONS=1"]
    run(cmd)
    print("[+] wrote %s (%.1f MB)" % (target, os.path.getsize(target) / 1e6), file=sys.stderr)

    shutil.rmtree(objdir, ignore_errors=True)
    if tmp:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
