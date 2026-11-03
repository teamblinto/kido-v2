import type { FileEntry } from '@repo/contracts';
import { useState } from 'react';

import { messageFor } from '@/lib/api/problem';
import { cn } from '@/lib/utils';

/** One directory's answer, however the caller gets it (`useDirectory` in `hooks/use-files.ts`). */
export interface DirectoryState {
  readonly entries?: readonly FileEntry[];
  /** Truthy when the listing refused. The tree only says so; the pane above it explains. */
  readonly error?: unknown;
  readonly isPending: boolean;
}

export interface FileTreeProps {
  /** A file was chosen. Directories and links never call this. */
  readonly onOpen: (path: string) => void;
  /** The file currently shown beside the tree, so the row can say it is the open one. */
  readonly openPath?: string | null;
  /**
   * The listing hook, injected rather than imported: every expanded directory renders a node that
   * calls this with its own path, which is what makes the tree lazy — one query per directory,
   * asked only once it is open. `''` is the root.
   */
  readonly useDirectory: (dir: string) => DirectoryState;
}

/**
 * The project's files, one directory at a time.
 *
 * Nothing is listed until it is expanded, and nothing is invented: an empty directory says it is
 * empty by name rather than showing a plausible `src/index.ts` that does not exist (SC-009). A
 * `link` is listed because the sandbox lists it, and cannot be opened because the API will not
 * follow it.
 */
export function FileTree({
  onOpen,
  openPath = null,
  useDirectory,
}: FileTreeProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);

  return (
    <ul
      role="tree"
      aria-label="Project files"
      className="text-body-sm min-h-0 flex-1 overflow-y-auto py-2"
      onKeyDown={(event) => {
        handleTreeKey(event, { expanded, onOpen, setExpanded });
      }}
    >
      <DirectoryNodes
        depth={0}
        dir=""
        expanded={expanded}
        focused={focused}
        onFocus={setFocused}
        onOpen={onOpen}
        openPath={openPath}
        setExpanded={setExpanded}
        useDirectory={useDirectory}
      />
    </ul>
  );
}

interface NodesProps extends FileTreeProps {
  readonly depth: number;
  readonly dir: string;
  readonly expanded: ReadonlySet<string>;
  readonly focused: string | null;
  readonly onFocus: (path: string) => void;
  readonly setExpanded: (next: ReadonlySet<string>) => void;
}

/** One directory's rows. Mounted only while its directory is expanded, so the query is too. */
function DirectoryNodes(props: NodesProps): React.JSX.Element {
  const { depth, dir, expanded, focused, onFocus, onOpen, openPath, setExpanded, useDirectory } =
    props;
  const { entries, error, isPending } = useDirectory(dir);
  const indent = { paddingLeft: `${String(12 + depth * 14)}px` };

  if (isPending) {
    return (
      <li role="none" className="text-faint px-3 py-1.5" style={indent}>
        Loading…
      </li>
    );
  }

  if (error !== undefined && error !== null) {
    return (
      <li role="none" className="text-faint px-3 py-1.5" style={indent}>
        {messageFor(error, 'This folder could not be listed.')}
      </li>
    );
  }

  const rows = [...(entries ?? [])].sort(byDirectoriesThenName);

  if (rows.length === 0) {
    return (
      <li role="none" className="text-faint px-3 py-1.5" style={indent}>
        {dir === '' ? 'This project has no files.' : `${dir} is empty.`}
      </li>
    );
  }

  return (
    <>
      {rows.map((entry, index) => {
        const path = join(dir, entry.name);
        const isDirectory = entry.kind === 'directory';
        const isOpen = expanded.has(path);

        return (
          <li
            key={path}
            role="treeitem"
            aria-expanded={isDirectory ? isOpen : undefined}
            aria-selected={path === openPath}
            aria-disabled={entry.kind === 'link' ? true : undefined}
            data-path={path}
            data-kind={entry.kind}
            tabIndex={
              focused === null
                ? depth === 0 && index === 0
                  ? 0
                  : -1
                : Number(focused === path) - 1
            }
            title={isDirectory ? entry.name : `${entry.name} — ${formatSize(entry.size)}`}
            aria-labelledby={`file-tree-${path}`}
            onFocus={(event) => {
              if (event.target === event.currentTarget) onFocus(path);
            }}
            onClick={(event) => {
              event.stopPropagation();
              activate(entry.kind, path, { expanded, onOpen, setExpanded });
            }}
            className={cn('cursor-default outline-none', entry.kind === 'link' && 'text-faint')}
          >
            <span
              id={`file-tree-${path}`}
              style={indent}
              className={cn(
                'focus-visible:bg-subtle hover:bg-subtle flex items-center gap-2 px-3 py-1.5',
                path === openPath && 'bg-subtle text-foreground font-medium',
              )}
            >
              <span aria-hidden="true" className="text-faint w-3 shrink-0">
                {isDirectory ? (isOpen ? '▾' : '▸') : ''}
              </span>
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {entry.kind === 'link' && <span className="text-faint text-overline">link</span>}
            </span>
            {isDirectory && isOpen && (
              <ul role="group">
                <DirectoryNodes {...props} depth={depth + 1} dir={path} />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

interface Actions {
  readonly expanded: ReadonlySet<string>;
  readonly onOpen: (path: string) => void;
  readonly setExpanded: (next: ReadonlySet<string>) => void;
}

function activate(
  kind: FileEntry['kind'],
  path: string,
  { expanded, onOpen, setExpanded }: Actions,
) {
  if (kind === 'directory') {
    const next = new Set(expanded);
    if (!next.delete(path)) next.add(path);
    setExpanded(next);
    return;
  }

  if (kind === 'file') onOpen(path);
}

/**
 * Arrows and Enter over the rows.
 *
 * Movement reads the rendered rows rather than a second, flattened copy of the tree: the DOM
 * already holds every visible row in order, and two models of the same list is how they drift.
 */
function handleTreeKey(event: React.KeyboardEvent<HTMLUListElement>, actions: Actions) {
  const row = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (row === null) return;

  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const index = rows.indexOf(row);
  const path = row.dataset.path ?? '';
  const kind = (row.dataset.kind ?? 'file') as FileEntry['kind'];
  const isOpen = row.getAttribute('aria-expanded') === 'true';

  const focus = (next: HTMLElement | undefined) => {
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  };

  switch (event.key) {
    case 'ArrowDown':
      focus(rows[index + 1]);
      return;
    case 'ArrowUp':
      focus(rows[index - 1]);
      return;
    case 'ArrowRight':
      event.preventDefault();
      if (kind === 'directory' && !isOpen) activate(kind, path, actions);
      else focus(rows[index + 1]);
      return;
    case 'ArrowLeft':
      event.preventDefault();
      if (kind === 'directory' && isOpen) activate(kind, path, actions);
      else focus(parentRow(rows, index, path));
      return;
    case 'Enter':
    case ' ':
      event.preventDefault();
      activate(kind, path, actions);
      return;
    default:
  }
}

/** The row for the directory this one lives in, found by path rather than by nesting. */
function parentRow(rows: HTMLElement[], index: number, path: string): HTMLElement | undefined {
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (parent === '') return undefined;
  return rows
    .slice(0, index)
    .reverse()
    .find((row) => row.dataset.path === parent);
}

function join(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** Directories first, then files and links, each alphabetically. */
function byDirectoriesThenName(a: FileEntry, b: FileEntry): number {
  const rank = Number(a.kind !== 'directory') - Number(b.kind !== 'directory');
  return rank === 0 ? a.name.localeCompare(b.name) : rank;
}

/** Bytes as the row's hover title says them. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
