import type { LucideIcon } from 'lucide-react';
import { useRef } from 'react';

import { cn } from '@/lib/utils';

export interface SegmentedItem<T extends string> {
  /** Count shown after the label, e.g. the number of changed files. */
  badge?: number;
  icon?: LucideIcon;
  id: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  /** Names the group for screen readers, e.g. "Stage". */
  ariaLabel: string;
  className?: string;
  /** The id of the region these segments switch, for `aria-controls`. */
  controls?: string;
  items: readonly SegmentedItem<T>[];
  onChange: (id: T) => void;
  /** Hides labels below `sm`, leaving the icons — used by the topbar. */
  responsive?: boolean;
  value: T;
}

/**
 * The pill-shaped switch the topbar and the git toolbar share. Arrow keys move
 * between segments and select as they go, which is the expected behaviour for
 * tabs whose panels are cheap to render.
 */
export function SegmentedControl<T extends string>({
  ariaLabel,
  className,
  controls,
  items,
  onChange,
  responsive = false,
  value,
}: SegmentedControlProps<T>): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;

    if (step === 0) {
      return;
    }

    const index = items.findIndex((item) => item.id === value);
    const next = items[(index + step + items.length) % items.length];

    if (!next) {
      return;
    }

    event.preventDefault();
    onChange(next.id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-segment="${next.id}"]`)?.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn('bg-muted flex items-center rounded-[9px] p-[3px]', className)}
    >
      {items.map((item) => {
        const isActive = item.id === value;

        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-segment={item.id}
            aria-selected={isActive}
            aria-controls={controls}
            tabIndex={isActive ? 0 : -1}
            onClick={() => {
              onChange(item.id);
            }}
            className={cn(
              'text-label-sm flex min-w-0 flex-1 items-center justify-center gap-[7px]',
              'rounded-[7px] border border-transparent px-3 py-1.5 font-medium transition-colors',
              isActive
                ? 'bg-raised border-line-subtle text-foreground'
                : 'text-subdued hover:text-foreground',
            )}
          >
            {item.icon ? <item.icon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
            <span className={cn('truncate', responsive && 'max-sm:sr-only')}>{item.label}</span>
            {item.badge === undefined ? null : (
              <span
                className={cn(
                  'bg-brand text-primary-foreground text-label-xs rounded-full px-1.5',
                  'py-px font-medium',
                )}
              >
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
