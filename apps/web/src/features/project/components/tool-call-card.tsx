import { CheckIcon, FileTextIcon, PackageIcon, TerminalIcon, XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ToolKind, ToolStatus } from '../types';

const toolIcons = {
  edit: FileTextIcon,
  exec: TerminalIcon,
  package: PackageIcon,
} as const satisfies Record<ToolKind, unknown>;

interface ToolCallCardProps {
  detail: string;
  status: ToolStatus;
  title: string;
  tool: ToolKind;
}

/**
 * One thing BAIOS did, as it happened: the command on top, what came of it
 * underneath, and a glyph for how it ended. The card outlines itself in the
 * brand colour while it is still running so the eye lands on the live one.
 */
export function ToolCallCard({
  detail,
  status,
  title,
  tool,
}: ToolCallCardProps): React.JSX.Element {
  const Icon = toolIcons[tool];

  return (
    <div
      className={cn(
        'bg-raised flex items-center gap-[9px] rounded-[10px] border px-[11px] py-[9px]',
        status === 'running' ? 'border-brand-border' : 'border-line-subtle',
      )}
    >
      <Icon className="text-subdued size-3.5 shrink-0" aria-hidden="true" />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-mono-sm text-foreground truncate font-mono">{title}</p>
        <p className="text-caption text-faint truncate">{detail}</p>
      </div>

      <ToolStatusGlyph status={status} />
    </div>
  );
}

function ToolStatusGlyph({ status }: { status: ToolStatus }): React.JSX.Element {
  if (status === 'running') {
    return (
      <span
        role="status"
        aria-label="Running"
        className="bg-brand animate-breathe size-2 shrink-0 rounded-full"
      />
    );
  }

  if (status === 'failed') {
    return (
      <>
        <XIcon className="text-danger size-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">Failed</span>
      </>
    );
  }

  return (
    <>
      <CheckIcon className="text-success size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">Done</span>
    </>
  );
}
