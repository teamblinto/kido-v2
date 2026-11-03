import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

/** A command to run in a terminal, with a button that copies it. */
export function CopyCommand({
  className,
  command,
}: {
  readonly className?: string;
  readonly command: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  return (
    <span
      className={cn(
        'bg-muted inline-flex max-w-full items-center gap-1.5 rounded-md py-1 pr-1 pl-2',
        className,
      )}
    >
      <code className="text-mono-sm min-w-0 font-mono break-all">{command}</code>
      <button
        type="button"
        aria-label={copied ? `Copied: ${command}` : `Copy command: ${command}`}
        className="text-subdued hover:text-foreground hover:bg-subtle shrink-0 rounded p-1"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
          });
        }}
      >
        {copied ? (
          <CheckIcon className="size-3.5" aria-hidden="true" />
        ) : (
          <CopyIcon className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </span>
  );
}
