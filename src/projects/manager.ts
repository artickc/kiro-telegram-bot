/**
 * Project manager — discovers candidate project directories under the
 * configured roots, de-duplicated by name, with search and create helpers.
 */
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("projects");

const IGNORE = new Set([
  "node_modules",
  ".git",
  ".history",
  "dist",
  "build",
  "out",
  ".cache",
  "target",
  ".venv",
  "__pycache__",
]);

export interface ProjectEntry {
  name: string;
  path: string;
}

export class ProjectManager {
  constructor(private readonly roots: string[]) {}

  /** List projects, de-duplicated by (case-insensitive) name. */
  list(limit = 100): ProjectEntry[] {
    const byName = new Map<string, ProjectEntry>();

    for (const root of this.roots) {
      let children: string[];
      try {
        children = readdirSync(root);
      } catch (e) {
        log.debug(`cannot read root ${root}:`, (e as Error).message);
        continue;
      }
      for (const child of children) {
        if (IGNORE.has(child) || child.startsWith(".")) continue;
        const full = join(root, child);
        try {
          if (!statSync(full).isDirectory()) continue;
        } catch {
          continue;
        }
        const key = child.toLowerCase();
        if (!byName.has(key)) byName.set(key, { name: child, path: full });
      }
    }

    const out = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return out.slice(0, limit);
  }

  /** Projects whose name contains the query (case-insensitive). */
  search(query: string, limit = 100): ProjectEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list(limit);
    return this.list(1000)
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, limit);
  }

  /** Create a new project folder under the first root and return it. */
  create(name: string): ProjectEntry {
    const clean = name.trim().replace(/[<>:"/\\|?*]/g, "_");
    if (!clean) throw new Error("Invalid project name.");
    const root = this.roots[0];
    if (!root) throw new Error("No project root configured (set PROJECT_ROOTS).");
    const full = join(root, clean);
    mkdirSync(full, { recursive: true });
    return { name: clean, path: full };
  }

  isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
}
