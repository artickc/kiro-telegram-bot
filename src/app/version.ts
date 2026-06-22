/**
 * Tiny semver helpers + CHANGELOG section extraction for the auto-updater.
 * Pure and dependency-free so they're easy to test.
 */

/** Parse the leading "X.Y.Z" of a version string (ignores pre-release tags). */
export function parseSemver(v: string): [number, number, number] {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** True when `latest` is strictly greater than `current` (by major/minor/patch). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

/** A version string is a plain semver we'd trust to pass to `npm install`. */
export function isSafeVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(v);
}

/** Extract the body of a CHANGELOG `## [version] …` section (markdown). */
export function extractChangelog(md: string, version: string): string {
  const head = new RegExp(`^##\\s*\\[${version.replace(/\./g, "\\.")}\\]`);
  const out: string[] = [];
  let capturing = false;
  for (const line of md.split("\n")) {
    if (capturing && /^##\s*\[/.test(line)) break;
    if (capturing) {
      out.push(line);
      continue;
    }
    if (head.test(line)) capturing = true;
  }
  return out.join("\n").trim();
}
