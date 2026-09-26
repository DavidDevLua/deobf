"""
Packs deobf/ into web/static/deobf-pipeline.zip, the copy of the pipeline the
browser unpacks into Pyodide's virtual file system.

Everything the runtime needs and nothing else: the Python modules, the Luau
runtime files (envlog.luau, roblox_api.luau, ...) and plugin data. No bin/
(the WebAssembly build replaces those binaries), no research/ (developer
scripts), no caches.

    python web/browser/pack.py
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(ROOT, "deobf")
OUT = os.path.join(ROOT, "web", "static", "deobf-pipeline.zip")

SKIP_DIRS = {"__pycache__", "bin", "research"}
KEEP_EXT = {".py", ".luau", ".txt", ".json"}


def main():
    if not os.path.isdir(SRC):
        sys.exit("[!] no deobf/ next to web/")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    n = 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for base, dirs, files in os.walk(SRC):
            dirs[:] = [d for d in sorted(dirs) if d not in SKIP_DIRS]
            for name in sorted(files):
                if os.path.splitext(name)[1] not in KEEP_EXT:
                    continue
                path = os.path.join(base, name)
                # "deobf/..." so the browser can extract it at the root
                arc = os.path.join("deobf", os.path.relpath(path, SRC)).replace(os.sep, "/")
                z.write(path, arc)
                n += 1
        z.write(os.path.join(HERE, "bootstrap.py"), "deobf/browser_bootstrap.py")
        n += 1
    print("[+] wrote %s (%d files, %.2f MB)" % (OUT, n, os.path.getsize(OUT) / 1e6), file=sys.stderr)


if __name__ == "__main__":
    main()
