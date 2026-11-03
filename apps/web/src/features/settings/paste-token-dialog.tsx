import { connectionSchema, type PasteTokenProvider } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangleIcon, Loader2Icon } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiRequest } from '@/lib/api/client';
import { ApiProblem, messageFor } from '@/lib/api/problem';

/** Where to make the credential, and the permissions it needs (spec 030 research R6). */
const PASTE_TOKEN_COPY: Readonly<
  Record<
    PasteTokenProvider,
    { readonly name: string; readonly instructions: string; readonly permissions: string[] }
  >
> = {
  cloudflare: {
    instructions:
      'Create an API token in Cloudflare → My Profile → API Tokens, limited to the zones you will use.',
    name: 'Cloudflare',
    permissions: ['Zone · Zone · Read', 'Zone · DNS · Read', 'Zone · DNS · Edit'],
  },
  neon: {
    instructions:
      'Create an API key in the Neon console. A project-scoped key is recommended: it can reach only the one project you bind.',
    name: 'Neon',
    permissions: ['Read projects', 'Create and delete branches'],
  },
  netlify: {
    instructions:
      'Create a personal access token in Netlify → User settings → Applications → Personal access tokens.',
    name: 'Netlify',
    permissions: ['Access to the team that owns the sites'],
  },
  resend: {
    instructions:
      'Create an API key in Resend → API Keys with full access; a sending-only key is refused.',
    name: 'Resend',
    permissions: ['Full access'],
  },
};

/** The `missing` extension of a `422` connect refusal (contracts/bindings.md § 1). */
function missingOf(error: unknown): string[] {
  if (!ApiProblem.is(error)) return [];
  const missing = (error.detail as Record<string, unknown> | undefined)?.missing;

  return Array.isArray(missing) ? missing.filter((item) => typeof item === 'string') : [];
}

interface PasteTokenDialogProps {
  readonly orgId: string;
  readonly provider: PasteTokenProvider | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConnected: () => void;
}

/**
 * Connect (or reconnect) Netlify, Neon, Resend or Cloudflare with a pasted credential. It is
 * verified by the API before anything is stored, and never shown again — only its fingerprint.
 */
export function PasteTokenDialog({
  onConnected,
  onOpenChange,
  orgId,
  provider,
}: PasteTokenDialogProps): React.JSX.Element {
  return (
    <Dialog open={provider !== undefined} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        {provider === undefined ? null : (
          <>
            <DialogHeader>
              <DialogTitle>Connect {PASTE_TOKEN_COPY[provider].name}</DialogTitle>
              <DialogDescription>{PASTE_TOKEN_COPY[provider].instructions}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <PasteTokenForm
                key={provider}
                orgId={orgId}
                provider={provider}
                onCancel={() => onOpenChange(false)}
                onConnected={() => {
                  onOpenChange(false);
                  onConnected();
                }}
              />
            </DialogBody>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PasteTokenForm({
  onCancel,
  onConnected,
  orgId,
  provider,
}: {
  readonly orgId: string;
  readonly provider: PasteTokenProvider;
  readonly onCancel: () => void;
  readonly onConnected: () => void;
}): React.JSX.Element {
  const [token, setToken] = useState('');
  const copy = PASTE_TOKEN_COPY[provider];
  const connect = useMutation({
    mutationFn: (value: string) =>
      apiRequest('POST', `/orgs/${encodeURIComponent(orgId)}/connectors/${provider}/token`, {
        body: { token: value },
        schema: connectionSchema,
      }),
    onSuccess: () => {
      setToken('');
      onConnected();
    },
  });
  const missing = missingOf(connect.error);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (token.trim() !== '') connect.mutate(token.trim());
      }}
    >
      <div>
        <p className="text-label-sm font-medium">Required permissions</p>
        <ul className="text-body-sm text-subdued mt-1 list-disc pl-5">
          {copy.permissions.map((permission) => (
            <li key={permission}>{permission}</li>
          ))}
        </ul>
      </div>

      {connect.error !== null ? (
        <Alert variant="danger">
          <AlertTriangleIcon />
          <AlertTitle>{messageFor(connect.error, 'That token was not accepted')}</AlertTitle>
          {missing.length > 0 ? (
            <AlertDescription>Missing: {missing.join(', ')}</AlertDescription>
          ) : null}
        </Alert>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor={`paste-token-${provider}`}>{copy.name} token</Label>
        <Input
          id={`paste-token-${provider}`}
          type="password"
          autoComplete="off"
          autoFocus
          maxLength={512}
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
          }}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={connect.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={connect.isPending || token.trim() === ''}>
          {connect.isPending ? (
            <>
              <Loader2Icon className="animate-spin" aria-hidden="true" />
              Verifying
            </>
          ) : (
            'Connect'
          )}
        </Button>
      </div>
    </form>
  );
}
