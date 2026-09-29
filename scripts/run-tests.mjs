#!/usr/bin/env node
/**
 * Cross-platform unit-test runner: finds every `*.test.ts` under `src/` and runs
 * them with Node's built-in test runner (`node:test`) through the tsx loader.
 *
 * Discovery lives here instead of a shell glob in package.json because globs
 * behave differently per shell (cmd.exe passes them through literally, POSIX sh
 * has no `**`) and Node only expands `--test` globs itself from v21 onwards.
 *
 *   npm test                       # all tests
 *   npm test -- src/tasks          # only tests under a path (prefix match)
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Recursively collect `*.test.ts` files below `dir`. */
function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const filters = process.argv.slice(2).map((f) => f.replace(/[\\/]+/g, sep));
const files = findTests(join(root, "src"))
  .map((f) => relative(root, f))
  .filter((f) => filters.length === 0 || filters.some((p) => f.startsWith(p)))
  .sort();

if (files.length === 0) {
  console.error(`No *.test.ts files found under src/${filters.length ? ` matching ${filters.join(", ")}` : ""}.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  cwd: root,
});
process.exit(result.status ?? 1);
