/* Wraps the WebAssembly Luau build (luau-wasm.mjs) in the two calls the
   deobfuscator needs: run a harness chunk, and parse a file to AST JSON -
   what the native `luau` and `luau-ast` binaries do.

   Everything here is bytes, not text. The harness writes NUL-prefixed control
   lines (\0ENVLOG-BEGIN, \0CHUNK, \0P2D ...) and protected scripts build
   strings that are not valid UTF-8, so source goes in as latin-1 and output
   comes back as a latin-1 string - exactly how deob.py reads and writes these
   files. */
import createLuau from "./luau-wasm.mjs";

var mod = null;        // the emscripten module, once instantiated
var loading = null;

function toLatin1Bytes(s) {
  var b = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

function fromLatin1Bytes(b) {
  /* built in chunks: String.fromCharCode.apply blows the argument limit on
     a multi-megabyte trace */
  var out = [];
  var step = 0x8000;
  for (var i = 0; i < b.length; i += step) {
    out.push(String.fromCharCode.apply(null, b.subarray(i, i + step)));
  }
  return out.join("");
}

var Luau = {
  /** Instantiate the runtime (idempotent; safe to await from several places). */
  load: function () {
    if (mod) return Promise.resolve(mod);
    if (loading) return loading;
    loading = createLuau().then(function (m) {
      mod = m;
      return m;
    });
    return loading;
  },

  get ready() { return !!mod; },

  /**
   * Run one chunk the way `luau <file>` would.
   * @param {string} source   latin-1 string (the assembled harness)
   * @param {string} chunkname
   * @returns {{ok: boolean, output: string, error: string}}
   *          `output` is whatever the chunk printed before it stopped, so a
   *          script that dies half way still yields a usable trace.
   */
  run: function (source, chunkname) {
    if (!mod) throw new Error("Luau runtime not loaded yet");
    var src = toLatin1Bytes(source);
    var name = chunkname || "@harness.luau";

    var srcPtr = mod._malloc(src.length + 1);
    mod.HEAPU8.set(src, srcPtr);
    mod.HEAPU8[srcPtr + src.length] = 0;

    var nameBytes = toLatin1Bytes(name);
    var namePtr = mod._malloc(nameBytes.length + 1);
    mod.HEAPU8.set(nameBytes, namePtr);
    mod.HEAPU8[namePtr + nameBytes.length] = 0;

    var status;
    try {
      status = mod._luauRun(srcPtr, src.length, namePtr);
    } finally {
      mod._free(srcPtr);
      mod._free(namePtr);
    }

    var outPtr = mod._luauOutput();
    var outLen = mod._luauOutputSize();
    var output = outLen > 0
      ? fromLatin1Bytes(mod.HEAPU8.subarray(outPtr, outPtr + outLen))
      : "";
    var error = mod.UTF8ToString(mod._luauError());
    mod._luauReset();

    return { ok: status === 0, output: output, error: error };
  },

  /**
   * What `luau-ast <file>` prints: the AST as JSON.
   * @returns {{code: number, output: string, error: string}}
   *          `code` is non-zero when the source had parse errors, which are
   *          in `error` - the same split the real binary uses.
   */
  ast: function (source) {
    if (!mod) throw new Error("Luau runtime not loaded yet");
    var src = toLatin1Bytes(source);
    var ptr = mod._malloc(src.length + 1);
    mod.HEAPU8.set(src, ptr);
    mod.HEAPU8[ptr + src.length] = 0;

    var code;
    try {
      code = mod._luauAst(ptr, src.length);
    } finally {
      mod._free(ptr);
    }

    var outPtr = mod._luauOutput();
    var outLen = mod._luauOutputSize();
    var output = outLen > 0
      ? fromLatin1Bytes(mod.HEAPU8.subarray(outPtr, outPtr + outLen))
      : "";
    var error = mod.UTF8ToString(mod._luauError());
    mod._luauReset();

    return { code: code, output: output, error: error };
  }
};

export default Luau;
