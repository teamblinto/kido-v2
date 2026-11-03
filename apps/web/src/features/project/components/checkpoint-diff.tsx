import type { CheckpointDiffFile } from '@repo/contracts';

import { messageFor } from '@/lib/api/problem';
import { cn } from '@/lib/utils';
import { type DiffLine, parseUnifiedDiff } from '../lib/unified-diff';

const statusWords: Record<CheckpointDiffFile['status'], string> = {
  A: 'Added',
  D: 'Deleted',
  M: 'Changed',
  R: 'Renamed',
};

const markers: Record<DiffLine['kind'], string> = { add: '+', context: ' ', remove: '-' };

export interface CheckpointDiffProps {
  readonly error?: Error | null;
  readonly files?: readonly CheckpointDiffFile[];
  readonly isPending?: boolean;
}

/**
 * What one checkpoint changed, file by file (FR-009).
 *
 * The patch is whatever the endpoint stored: a binary file has none and shows its size instead, a
 * truncated one says so as a trailing row rather than quietly ending mid-file. Added and removed
 * lines keep their `+`/`-` marker as well as their colour, so the distinction survives without it.
 */
export function CheckpointDiff({
  error = null,
  files,
  isPending = false,
}: CheckpointDiffProps): React.JSX.Element {
  if (isPending) return <p className="text-faint text-body-sm px-6 py-4">Loading the changes…</p>;

  if (error !== null)
    return <p className="text-faint text-body-sm px-6 py-4">{messageFor(error)}</p>;

  if (files === undefined || files.length === 0)
    return <p className="text-faint text-body-sm px-6 py-4">No files changed at this point.</p>;

  return (
    <div className="flex flex-col gap-4 px-6 py-4">
      {files.map((file) => (
        <section key={file.path} aria-label={file.path}>
          <h4 className="text-body-sm text-foreground flex flex-wrap items-baseline gap-2 font-medium">
            <span className="min-w-0 break-all">{file.path}</span>
            <span className="text-faint text-overline uppercase">{statusWords[file.status]}</span>
          </h4>

          {file.binary ? (
            <p className="text-faint text-body-sm mt-1">Binary file — {formatSize(file.bytes)}</p>
          ) : (
            <FilePatch patch={file.patch} truncated={file.truncated} />
          )}
        </section>
      ))}
    </div>
  );
}

function FilePatch({ patch, truncated }: { patch: string; truncated: boolean }) {
  const hunks = parseUnifiedDiff(patch);

  if (hunks.length === 0 && !truncated)
    return <p className="text-faint text-body-sm mt-1">No line changes to show.</p>;

  return (
    <div className="border-line-subtle text-mono-sm mt-1.5 overflow-x-auto rounded border font-mono">
      {hunks.map((hunk) => (
        <div key={`${String(hunk.oldStart)}-${String(hunk.newStart)}-${hunk.header}`}>
          <div className="text-faint bg-subtle px-2 py-1">{hunk.header}</div>
          {hunk.lines.map((line, index) => (
            <div
              // Diff lines have no identity of their own; their position in the hunk is it.
              key={index}
              data-kind={line.kind}
              className={cn(
                'flex whitespace-pre',
                line.kind === 'add' && 'bg-success-soft text-success',
                line.kind === 'remove' && 'bg-danger-soft text-danger',
              )}
            >
              <span className="text-faint w-10 shrink-0 select-none px-1 text-right">
                {line.oldLine ?? ''}
              </span>
              <span className="text-faint w-10 shrink-0 select-none px-1 text-right">
                {line.newLine ?? ''}
              </span>
              <span className="w-4 shrink-0 select-none text-center">{markers[line.kind]}</span>
              <span className="min-w-0 px-1">{line.content}</span>
            </div>
          ))}
        </div>
      ))}
      {truncated && (
        <div className="text-faint bg-subtle px-2 py-1">
          This patch was too large to show in full.
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
