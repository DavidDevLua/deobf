/* The deobfuscator, off the main thread.

   Everything runs here: the WebAssembly Luau that executes the protected
   script, and Pyodide running the same Python pipeline the CLI runs. The page
   only sends jobs and renders what comes back - a trace can take minutes and
   would otherwise freeze the tab.

   A module worker, not a classic one: Pyodide no longer supports classic
   workers, so nothing here can use importScripts.

   Messages in:  {type:"boot"} | {type:"detect", id, source}
                 | {type:"run", id, source, name, options}
   Messages out: {type:"status"|"log"|"ready"|"detected"|"done"|"error", ...} */
import LuauRuntime from "./luau-runtime.mjs";
import { loadPyodide } from "./pyodide/pyodide.mjs";

let pyodide = null;
let bootstrap = null;
let booting = null;

function post(msg) { self.postMessage(msg); }

/* --- what bootstrap.py calls (see its _call_luau / _call_luau_ast) -------- */

self.deobfLuauRun = function (source, chunkname) {
  const r = LuauRuntime.run(source, chunkname);
  return { ok: r.ok, output: r.output, error: r.error };
};

self.deobfLuauAst = function (source) {
  const r = LuauRuntime.ast(source);
  return { code: r.code, output: r.output, error: r.error };
};

/* --- boot ---------------------------------------------------------------- */

function boot() {
  if (booting) return booting;
  booting = (async function () {
    post({ type: "status", text: "starting the Luau runtime" });
    await LuauRuntime.load();

    post({ type: "status", text: "starting Python (the slow part, once)" });
    /* the lifter recurses deeply on nested scripts; natively it gets a 256 MB
       thread stack (backend.run_big_stack), which here has to come from the
       interpreter itself */
    pyodide = await loadPyodide({ indexURL: "./pyodide/", stackSize: 64 * 1024 * 1024 });

    /* the pipeline reports progress on stderr */
    pyodide.setStderr({ batched: (line) => post({ type: "log", line }) });
    pyodide.setStdout({ batched: (line) => post({ type: "log", line }) });

    post({ type: "status", text: "unpacking the pipeline" });
    const zip = new Uint8Array(await (await fetch("deobf-pipeline.zip")).arrayBuffer());
    pyodide.FS.writeFile("/deobf-pipeline.zip", zip);

    await pyodide.runPythonAsync([
      "import sys, zipfile",
      "with zipfile.ZipFile('/deobf-pipeline.zip') as z: z.extractall('/')",
      "sys.path.insert(0, '/deobf')",
      "import browser_bootstrap",
      "browser_bootstrap.install()"
    ].join("\n"));

    bootstrap = pyodide.pyimport("browser_bootstrap");
    post({ type: "ready" });
    return bootstrap;
  })();
  return booting;
}

/* --- jobs ---------------------------------------------------------------- */

async function detect(source) {
  const b = await boot();
  const res = b.detect(source);
  const out = res.toJs ? Object.fromEntries(res.toJs()) : res;
  if (res.destroy) res.destroy();
  return out;
}

async function run(source, name, options) {
  const b = await boot();
  const t0 = performance.now();
  const opts = pyodide.toPy(options || {});
  try {
    const text = b.deobfuscate(source, name, opts);
    return { text, ms: performance.now() - t0 };
  } finally {
    if (opts.destroy) opts.destroy();
  }
}

self.onmessage = async function (e) {
  const msg = e.data || {};
  try {
    if (msg.type === "boot") {
      await boot();
    } else if (msg.type === "detect") {
      post({ type: "detected", id: msg.id, result: await detect(msg.source) });
    } else if (msg.type === "run") {
      const r = await run(msg.source, msg.name, msg.options);
      post({ type: "done", id: msg.id, text: r.text, ms: r.ms });
    }
  } catch (err) {
    post({ type: "error", id: msg.id, message: (err && err.message) || String(err) });
  }
};
