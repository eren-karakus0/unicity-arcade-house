/**
 * Patches @unicity-astrid/sdk 0.1.0's runtime for a decorator-registry timing
 * bug (see patches/UPSTREAM.md). TC39 method-decorator initializers only run
 * on FIRST CONSTRUCTION of the class, but the bridge reads the registry maps
 * (installMethod / runMethod / tools / interceptors / commands) BEFORE any
 * instance exists — so every lookup sees them empty: install hooks no-op,
 * run loops "exit before signaling ready", tool dispatch finds nothing.
 *
 * Fix: warm the registry with one throwaway construction before the first
 * read, and make duplicate records idempotent (the warm-up construction plus
 * the real one would otherwise trip the duplicate guards).
 *
 * ALSO (kernels >= 0.9.1): drops the unused `astrid:process/host@1.0.0`
 * import from the synthesized world + the SDK bridge. The published SDK
 * 0.1.0 world imports process@1.0.0, but current kernels' lifecycle linker
 * only registers process@1.1.0 — so EVERY JS capsule fails to install with
 * "matching implementation was not found in the linker". This capsule never
 * spawns processes (the SDK itself documents process as optional:
 * "capsules importing astrid:process will fail to load" on some targets),
 * so we simply stop importing it. See patches/UPSTREAM.md.
 *
 * Runs automatically via npm postinstall. Idempotent.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sdkRuntime = join(here, "node_modules", "@unicity-astrid", "sdk", "dist", "runtime");

function patch(file, edits) {
  const path = join(sdkRuntime, file);
  if (!existsSync(path)) {
    console.error(`patch-sdk: ${path} not found — is @unicity-astrid/sdk installed?`);
    process.exit(1);
  }
  let src = readFileSync(path, "utf8");
  let changed = false;
  for (const [find, replace] of edits) {
    if (typeof find === "string" ? src.includes(replace) : replace && src.includes(replace)) continue;
    const next = typeof find === "string" ? src.split(find).join(replace) : src.replace(find, replace);
    if (next !== src) {
      src = next;
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(path, src);
    console.log(`patch-sdk: patched ${file}`);
  } else {
    console.log(`patch-sdk: ${file} already patched`);
  }
}

// 1) bridge.js — warm the registry before the first read.
patch("bridge.js", [
  [
    `export function createBridge() {
    let toolDescribeCache;
    function reg() {
        const r = getRegistration();`,
    `export function createBridge() {
    let toolDescribeCache;
    let warmed = false;
    function reg() {
        const r = getRegistration();
        // PATCH(sdk-0.1.0): method-decorator initializers only run on first
        // construction, so warm the registry before reading its maps —
        // otherwise install/run/tool lookups always see them empty.
        if (r !== undefined && !warmed) {
            warmed = true;
            try { new r.ctor(); } catch { /* constructor is state-free */ }
        }`,
  ],
]);

// 2) registry.js — duplicate records become no-ops (warm-up + real construction).
{
  const path = join(sdkRuntime, "registry.js");
  let src = readFileSync(path, "utf8");
  const before = src;
  src = src.replace(
    /if \((\w+)\.(tools|commands|interceptors)\.has\(([^)]+)\)\) \{\s*throw new Error\([^;]+;\s*\}/g,
    (_m, obj, map, key) => `if (${obj}.${map}.has(${key})) { return; }`,
  );
  src = src.replace(
    /if \((\w+)\.(installMethod|upgradeMethod|runMethod) !== undefined\) \{\s*throw new Error\([^;]+;\s*\}/g,
    (_m, obj, field) => `if (${obj}.${field} !== undefined) { return; }`,
  );
  if (src !== before) {
    writeFileSync(path, src);
    console.log("patch-sdk: patched registry.js");
  } else {
    console.log("patch-sdk: registry.js already patched");
  }
}

// 3) Drop the unused `astrid:process` host import (kernels >= 0.9.1 removed
//    the 1.0.0 implementation from the lifecycle linker; this capsule never
//    spawns processes).
//
// 3a) sdk/dist/process.js — replace the versioned import with throwing stubs
//     so the bundled entry no longer references the specifier at all.
{
  const path = join(here, "node_modules", "@unicity-astrid", "sdk", "dist", "process.js");
  let src = readFileSync(path, "utf8");
  const importLine =
    'import { spawn as hostSpawn, spawnBackground as hostSpawnBackground, } from "astrid:process/host@1.0.0";';
  const stub = `// PATCH(kernel>=0.9.1): astrid:process/host@1.0.0 is no longer linkable and
// this capsule never uses it — stub the bridge instead of importing it.
const hostSpawn = () => { throw new Error("astrid:process is not linked in this capsule build"); };
const hostSpawnBackground = hostSpawn;`;
  if (src.includes(importLine)) {
    writeFileSync(path, src.split(importLine).join(stub));
    console.log("patch-sdk: patched process.js (import -> stub)");
  } else if (src.includes("astrid:process is not linked")) {
    console.log("patch-sdk: process.js already patched");
  } else {
    console.error("patch-sdk: process.js import line not found — SDK layout changed, refusing to guess");
    process.exit(1);
  }
}

// 3b) build/src/index.mjs — drop the process import from the synthesized
//     world (the component's import list comes from the world, not the JS).
{
  const path = join(here, "node_modules", "@unicity-astrid", "build", "src", "index.mjs");
  let src = readFileSync(path, "utf8");
  const line = "\n    import astrid:process/host@1.0.0;";
  if (src.includes(line)) {
    writeFileSync(path, src.split(line).join(""));
    console.log("patch-sdk: patched build/src/index.mjs (world drops astrid:process)");
  } else {
    console.log("patch-sdk: build world already patched");
  }
}

console.log("patch-sdk: done");
