import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** The name each client lists the server under. */
const SERVER_NAME = 'baios';

interface Client {
  readonly id: string;
  readonly label: string;
  /** What to do, before the snippet. */
  readonly steps: string;
  /** What to paste, or `null` when the URL itself is all the client asks for. */
  readonly snippet: (url: string) => string | null;
  /** What to do after, if anything. */
  readonly after?: string;
}

const CLIENTS: readonly Client[] = [
  {
    after: 'Then run /mcp inside Claude Code and choose the server to sign in.',
    id: 'claude-code',
    label: 'Claude Code',
    snippet: (url) => `claude mcp add --transport http ${SERVER_NAME} ${url}`,
    steps: 'Run this in your terminal:',
  },
  {
    id: 'claude',
    label: 'Claude',
    snippet: () => null,
    steps:
      'In claude.ai or Claude Desktop, open Settings → Connectors → Add custom connector, and paste the server URL.',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    snippet: () => null,
    steps:
      'In ChatGPT, open Settings → Apps & Connectors → Advanced and turn on Developer mode. Then choose Create, paste the server URL and pick OAuth.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    snippet: (url) => JSON.stringify({ mcpServers: { [SERVER_NAME]: { url } } }, null, 2),
    steps: 'Add this to ~/.cursor/mcp.json:',
  },
  {
    id: 'vscode',
    label: 'VS Code',
    snippet: (url) =>
      JSON.stringify({ servers: { [SERVER_NAME]: { type: 'http', url } } }, null, 2),
    steps: 'Add this to .vscode/mcp.json in your workspace:',
  },
];

function CopyBlock({
  label,
  text,
}: {
  readonly label: string;
  readonly text: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-2 flex items-start gap-2">
      <pre className="bg-muted min-w-0 flex-1 overflow-x-auto rounded p-2 font-mono text-sm">
        <code>{text}</code>
      </pre>
      <Button
        size="sm"
        variant="outline"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/** The MCP server URL and how each AI tool connects to it (spec 046). */
export function McpConnectGuide(): React.JSX.Element {
  const url = `${window.location.origin}/api/v1/mcp`;

  return (
    <>
      <section className="mt-6">
        <h2 className="text-heading-sm font-semibold">Server URL</h2>
        <CopyBlock label="server URL" text={url} />
      </section>

      <section className="mt-8">
        <h2 className="text-heading-sm font-semibold">Connect your AI tool</h2>
        <p className="text-body-sm text-subdued mt-1">
          Signing in opens this site, where you pick the organization and approve access.
        </p>
        <Tabs defaultValue={CLIENTS[0]?.id} className="mt-4">
          <TabsList>
            {CLIENTS.map((client) => (
              <TabsTrigger key={client.id} value={client.id}>
                {client.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {CLIENTS.map((client) => {
            const snippet = client.snippet(url);

            return (
              <TabsContent key={client.id} value={client.id} className="mt-3">
                <p className="text-body-sm">{client.steps}</p>
                {snippet === null ? null : (
                  <CopyBlock label={`${client.label} setup`} text={snippet} />
                )}
                {client.after === undefined ? null : (
                  <p className="text-body-sm text-subdued mt-2">{client.after}</p>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      </section>
    </>
  );
}
