import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';
import { highlight } from '../lib/highlight';
import { splitMarkdownBlocks } from '../lib/markdown-blocks';

const REMARK_PLUGINS = [remarkGfm];

const COMPONENTS: Components = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  code: ({ children, className }) => {
    const language = /language-([\w-]+)/.exec(className ?? '')?.[1];
    // A fenced block's children are its text, as one string.
    const source = typeof children === 'string' ? children.replace(/\n$/, '') : undefined;
    // highlight.js escapes the source itself, so its HTML carries nothing the text could inject.
    const html =
      language === undefined || source === undefined ? null : highlight(`code.${language}`, source);

    return html === null ? (
      <code className={className}>{children}</code>
    ) : (
      <code className={cn(className, 'hljs')} dangerouslySetInnerHTML={{ __html: html }} />
    );
  },
};

/** One block's Markdown. Memoised: a finished block keeps its text, so it never re-renders. */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { readonly text: string }) {
  return (
    // `skipHtml`: raw HTML in what the agent wrote is dropped, never rendered (spec 043).
    <ReactMarkdown components={COMPONENTS} remarkPlugins={REMARK_PLUGINS} skipHtml>
      {text}
    </ReactMarkdown>
  );
});

/**
 * The assistant's text as Markdown (GFM, no raw HTML, fenced code highlighted). While it streams
 * it is cut at blank lines so only the last block re-renders, and `data-streaming` lets a new
 * block fade in — in CSS, and only without reduced motion.
 */
export function ChatMarkdown({
  className,
  isStreaming = false,
  text,
}: {
  readonly className?: string;
  readonly isStreaming?: boolean;
  readonly text: string;
}): React.JSX.Element {
  const blocks = isStreaming ? splitMarkdownBlocks(text) : [text];

  return (
    <div
      className={cn('chat-markdown text-body-sm text-foreground min-w-0', className)}
      data-streaming={isStreaming ? '' : undefined}
    >
      {blocks.map((block, index) => (
        // Streamed blocks only ever change at the end, so their index is a stable key.
        <MarkdownBlock key={index} text={block} />
      ))}
    </div>
  );
}
