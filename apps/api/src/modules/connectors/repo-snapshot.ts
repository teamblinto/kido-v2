import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { RepoSnapshot } from './stack-detector';

/** Never walked: dependencies, VCS metadata and build output say nothing about how a repo runs. */
const SKIP = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'target',
  'vendor',
  'venv',
]);

/** Deep enough for `apps/web/src/main.ts`; a monorepo's manifests are never deeper in practice. */
const MAX_DEPTH = 4;
/** A walk that meets this many files stops, so a huge repository cannot stall an import. */
const MAX_FILES = 20_000;
/** A file over this is not read: a manifest or an entry point is never this large. */
const MAX_READ_BYTES = 512 * 1024;

/**
 * Spec 047: a snapshot of the import's clone on the worker, for `detectRunConfig`. Paths are walked
 * once, eagerly; contents are read lazily, only for the files the detector asks for. Symlinks are
 * neither followed nor read, so a link out of the clone cannot point the detector anywhere.
 */
export function snapshotDirectory(root: string): RepoSnapshot {
  const files: string[] = [];

  const walk = (dir: string, rel: string, depth: number): void => {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && depth < MAX_DEPTH)
          walk(join(dir, entry.name), path, depth + 1);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  walk(root, '', 1);

  const known = new Set(files);
  return {
    files,
    read(path) {
      if (!known.has(path)) return undefined;
      try {
        const full = join(root, path);
        if (statSync(full).size > MAX_READ_BYTES) return undefined;
        return readFileSync(full, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

/** The same shape over an in-memory map: the detector's specs, and nothing else. */
export function snapshotOf(contents: Readonly<Record<string, string>>): RepoSnapshot {
  return { files: Object.keys(contents), read: (path) => contents[path] };
}
