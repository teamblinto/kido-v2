import { EmptyPane } from './empty-pane';

interface GitChangesProps {
  /** The files this run has changed, newest first. Distinct paths, read from `file.patch`. */
  paths: readonly string[];
}

/**
 * What has changed since the last save.
 *
 * The list is the run's own `file.patch` events and nothing else — no line counts, no
 * plain-English summary of what each file does, because the run reports neither and inventing
 * them is what FR-003 forbids. A run that has changed nothing shows that it has changed nothing.
 *
 * There is no save form here, and the reason is no longer that the surface cannot write: ADR 047
 * supersedes the read-only half of ADR 045, and 024 made the file view editable. A save is one
 * file, saved from the editor against the base it was read at — so this pane reports the run's
 * changes, the editor saves a person's own, and the History pane keeps the record (FR-012).
 */
export function GitChanges({ paths }: GitChangesProps): React.JSX.Element {
  if (paths.length === 0) {
    return (
      <EmptyPane
        title="Nothing has changed yet"
        body="Files this run edits will appear here as it works."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section className="min-w-0 flex-1 px-6 py-5">
        <h2 className="text-overline text-faint font-medium uppercase">Not saved yet</h2>
        <p className="text-heading-md text-foreground mt-1.5 font-semibold">
          {paths.length === 1 ? '1 file changed' : `${String(paths.length)} files changed`} since
          your last save
        </p>

        <ul className="mt-3.5 flex flex-col gap-2">
          {paths.map((path) => (
            <li
              key={path}
              className="bg-raised border-line-subtle flex items-center gap-4 rounded-[10px] border px-3.5 py-3.5"
            >
              <span aria-hidden="true" className="bg-info size-[7px] shrink-0 rounded-full" />
              <p className="text-mono-sm text-foreground min-w-0 flex-1 truncate font-mono">
                {path}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
