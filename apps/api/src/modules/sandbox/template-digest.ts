import { createHash } from 'node:crypto';

/**
 * A template definition's identity (spec 015, research R3): SHA-256 over the manifest as
 * canonical JSON, then every file in sorted POSIX-path order as `path NUL size NUL content`, with
 * CRLF folded to LF so a Windows checkout digests the same tree. Pure: the catalogue calls it once
 * at load and the version row stores the result.
 */
export function templateDigest(
  manifest: Readonly<Record<string, string>>,
  files: readonly { readonly content: Buffer; readonly path: string }[],
): string {
  // The manifest is flat strings, so sorting the top-level keys is the whole canonicalisation.
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
  const hash = createHash('sha256').update(canonical);

  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    // latin1 round-trips every byte, so binary files survive the CRLF fold untouched elsewhere.
    const content = Buffer.from(file.content.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');

    hash.update(`${file.path}\0${content.length}\0`).update(content);
  }

  return hash.digest('hex');
}

/** The provider snapshot name: `forge-tpl-<id>-<12 hex>`, within Daytona's `[a-z0-9._-]`. */
export function snapshotName(id: string, digest: string): string {
  return `forge-tpl-${id}-${digest.slice(0, 12)}`;
}
