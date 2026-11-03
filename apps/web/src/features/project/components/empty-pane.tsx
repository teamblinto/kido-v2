import { cn } from '@/lib/utils';

interface EmptyPaneProps {
  /** One sentence for what would be here, and when. */
  body: string;
  className?: string;
  title: string;
}

/**
 * What a pane shows when it has nothing to show.
 *
 * One component rather than one empty state per pane, because the thing being said is the same
 * every time and it has to be unmistakable: this is empty because nothing has happened yet, or
 * because the feature is not built, and never because something failed to load quietly (FR-003,
 * FR-028).
 */
export function EmptyPane({ body, className, title }: EmptyPaneProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 py-10 text-center',
        className,
      )}
    >
      <p className="text-label-md text-subdued font-medium">{title}</p>
      <p className="text-body-sm text-faint max-w-[380px]">{body}</p>
    </div>
  );
}
