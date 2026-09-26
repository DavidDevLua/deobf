// Luau for the browser, built to WebAssembly.
//
// This mirrors what the native CLI does in CLI/src/Repl.cpp, because the
// deobfuscator's trace depends on it: the same libraries, the same globals
// (loadstring is a CLI addition, not part of Luau, and protected scripts use
// it constantly), the same compile options (debugLevel 1 keeps the line
// numbers envlog.luau attributes statements with) and the same sandboxing.
// Luau's own CLI/src/Web.cpp is not enough - it has no loadstring.
//
// Output is captured through the writestring hook patched into lbaselib.cpp
// rather than through stdout: the harness writes NUL-prefixed control lines
// (\0ENVLOG-BEGIN, \0CHUNK, ...) that do not survive a trip through
// emscripten's text-oriented stdout handler.
#include "lua.h"
#include "lualib.h"
#include "luacode.h"
#include "Luau/Compiler.h"
#include "Luau/Ast.h"
#include "Luau/AstJsonEncoder.h"
#include "Luau/Parser.h"
#include "Luau/ParseOptions.h"
#include "Luau/Common.h"

#include <string>
#include <string.h>
#include <stdio.h>

// set by the VM patch in lbaselib.cpp (see build_wasm.py)
extern "C" void (*luau_writestring_hook)(const char* s, size_t l);

// AstJsonEncoder.cpp reads this flag, but the variable itself is defined in
// ConstraintGenerator.cpp - the whole type checker, which this build has no
// other reason to link. Defining it here keeps the dependency out; the value
// matches the native binaries, where setLuauFlagsDefault() only turns on
// flags whose name starts with "Luau" (this one starts with "Debug").
LUAU_FASTFLAGVARIABLE(DebugLuauIfLocalAnalysis)

// CLI/src/Flags.cpp setLuauFlagsDefault(), which every native Luau binary
// runs at startup: without it the VM and compiler behave like an older Luau
// and traces drift from the ones deob.py produces.
static void setLuauFlagsDefault()
{
    for (Luau::FValue<bool>* flag = Luau::FValue<bool>::list; flag; flag = flag->next)
        if (strncmp(flag->name, "Luau", 4) == 0)
            flag->value = true;
}

static std::string g_output;
static std::string g_error;

static void captureWrite(const char* s, size_t l)
{
    g_output.append(s, l);
}

// Analysis/src/ToString.cpp toString(Location, 0, true), copied rather than
// linked: that file is the type checker's printer and drags all of Analysis in
static std::string locationString(const Luau::Location& location)
{
    return "(" + std::to_string(location.begin.line) + ", " + std::to_string(location.begin.column) +
           ") - (" + std::to_string(location.end.line) + ", " + std::to_string(location.end.column) + ")";
}

static Luau::CompileOptions copts()
{
    Luau::CompileOptions result = {};
    result.optimizationLevel = 1;   // CLI defaults
    result.debugLevel = 1;
    result.coverageLevel = 0;
    return result;
}

// CLI/src/Repl.cpp
static int lua_loadstring(lua_State* L)
{
    size_t l = 0;
    const char* s = luaL_checklstring(L, 1, &l);
    const char* chunkname = luaL_optstring(L, 2, s);

    lua_setsafeenv(L, LUA_ENVIRONINDEX, false);

    std::string bytecode = Luau::compile(std::string(s, l), copts());
    if (luau_load(L, chunkname, bytecode.data(), bytecode.size(), 0) == 0)
        return 1;

    lua_pushnil(L);
    lua_insert(L, -2); // put before error message
    return 2;          // return nil plus error message
}

static int lua_collectgarbage(lua_State* L)
{
    const char* option = luaL_optstring(L, 1, "collect");

    if (strcmp(option, "collect") == 0)
    {
        lua_gc(L, LUA_GCCOLLECT, 0);
        return 0;
    }

    if (strcmp(option, "count") == 0)
    {
        int c = lua_gc(L, LUA_GCCOUNT, 0);
        lua_pushnumber(L, c);
        return 1;
    }

    luaL_error(L, "collectgarbage must be called with 'count' or 'collect'");
}

static void setupState(lua_State* L)
{
    luaL_openlibs(L);

    static const luaL_Reg funcs[] = {
        {"loadstring", lua_loadstring},
        {"collectgarbage", lua_collectgarbage},
        {NULL, NULL},
    };

    lua_pushvalue(L, LUA_GLOBALSINDEX);
    luaL_register(L, NULL, funcs);
    lua_pop(L, 1);

    // no luaopen_require: there is no file system here, and the harness the
    // browser runs is a single self-contained chunk

    luaL_sandbox(L);
}

extern "C" {

// Runs `source` as one chunk, the way `luau harness.luau` would.
// Returns 0 when the chunk finished, 1 when it raised: either way the output
// written so far is kept (a protected script that dies half way still leaves
// a usable trace). Read it with luauOutput/luauOutputSize.
int luauRun(const char* source, int sourceLen, const char* chunkname)
{
    setLuauFlagsDefault();
    g_output.clear();
    g_error.clear();
    luau_writestring_hook = captureWrite;

    lua_State* GL = luaL_newstate();
    if (!GL)
    {
        g_error = "out of memory creating the Luau state";
        luau_writestring_hook = nullptr;
        return 1;
    }

    setupState(GL);

    // a module runs in its own thread, isolated from the rest (runFile)
    lua_State* L = lua_newthread(GL);
    luaL_sandboxthread(L);

    std::string bytecode = Luau::compile(std::string(source, sourceLen), copts());

    int status = 0;
    if (luau_load(L, chunkname, bytecode.data(), bytecode.size(), 0) == 0)
    {
        status = lua_resume(L, NULL, 0);
    }
    else
    {
        status = LUA_ERRSYNTAX;
    }

    if (status != 0)
    {
        const char* msg = lua_tostring(L, -1);
        g_error = msg ? msg : "unknown error";
        if (status != LUA_ERRSYNTAX)
        {
            g_error += "\nstack backtrace:\n";
            g_error += lua_debugtrace(L);
        }
    }

    lua_close(GL);
    luau_writestring_hook = nullptr;
    return status == 0 ? 0 : 1;
}

// The luau-ast CLI: parse `source` and print its AST as JSON. Mirrors
// CLI/src/Ast.cpp, including sending parse errors to the error channel and
// reporting them as a non-zero status, because luauast.parse() runs the real
// binary with check=True and reads stdout alone.
int luauAst(const char* source, int sourceLen)
{
    setLuauFlagsDefault();
    g_output.clear();
    g_error.clear();

    Luau::Allocator allocator;
    Luau::AstNameTable names(allocator);

    Luau::ParseOptions options;
    options.captureComments = true;
    options.allowDeclarationSyntax = true;

    Luau::ParseResult parseResult =
        Luau::Parser::parse(source, (size_t)sourceLen, names, allocator, std::move(options));

    if (!parseResult.errors.empty())
    {
        g_error = "Parse errors were encountered:\n";
        for (const Luau::ParseError& error : parseResult.errors)
        {
            g_error += "  " + locationString(error.getLocation()) + " - " + error.getMessage() + "\n";
        }
        g_error += "\n";
    }

    g_output = Luau::toJson(parseResult.root, parseResult.commentLocations);
    return parseResult.errors.empty() ? 0 : 1;
}

const char* luauOutput()
{
    return g_output.data();
}

int luauOutputSize()
{
    return (int)g_output.size();
}

const char* luauError()
{
    return g_error.c_str();
}

// Frees the captured output between runs so a big trace is not held twice.
void luauReset()
{
    std::string().swap(g_output);
    std::string().swap(g_error);
}

} // extern "C"
