import { ORG_NAME_MAX_LENGTH, createOrgRequestSchema, orgSlugSchema } from '@repo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangleIcon, ArrowRightIcon, Loader2Icon, ZapIcon } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Wordmark } from '@/components/wordmark';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { createOrg } from '../api';
import { ORGS_QUERY_KEY } from '../hooks/use-orgs';

/**
 * Derive a slug from the name, as a starting point the user can overrule.
 *
 * The API deliberately does not do this: `org.ts` argues that deriving it server-side means
 * *"silently picking a different slug when one is taken, which is a value the caller then has to be
 * told about and may not want"*. Suggesting one in the form has neither problem — the user sees it
 * before it is sent, and a collision comes back as a `409` they resolve themselves.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/**
 * What a just-registered account sees instead of an empty dashboard.
 *
 * ADR 007 settled that signup creates a user and nothing else — *"creating an organisation is an
 * explicit, authenticated action"* — so this screen is that action. `GET /orgs` answers an account
 * in none with `200` and an empty array rather than a `404` for exactly this reason.
 */
export function CreateOrgScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});

  const effectiveSlug = slugEdited ? slug : slugify(name);

  const create = useMutation({
    mutationFn: createOrg,
    onError: (error) => {
      setFieldErrors(error instanceof ApiProblem ? error.fieldErrors() : {});
    },
    onSuccess: async () => {
      // Refetched rather than pushed into the cache: `useOrgs` picks the active organisation from
      // the list, and the list is the thing that changed. Seeding one entry by hand would work
      // until the day the server returns something the client did not predict.
      await queryClient.invalidateQueries({ queryKey: ORGS_QUERY_KEY });
    },
  });

  const taken = ApiProblem.is(create.error, 'conflict');

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const parsed = createOrgRequestSchema.safeParse({ name: name.trim(), slug: effectiveSlug });

    if (!parsed.success) {
      setFieldErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [String(issue.path.at(-1) ?? ''), issue.message]),
        ),
      );

      return;
    }

    setFieldErrors({});
    create.mutate(parsed.data);
  }

  const slugError =
    fieldErrors.slug ??
    (taken ? 'That handle is already taken. Try another.' : undefined) ??
    (effectiveSlug.length > 0 && !orgSlugSchema.safeParse(effectiveSlug).success
      ? 'Use lowercase letters, digits and single hyphens.'
      : undefined);

  return (
    <main className="bg-canvas flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="w-full max-w-[420px]">
        <Wordmark />

        <span
          className="bg-brand mt-[38px] flex size-[52px] items-center justify-center rounded-[14px]"
          aria-hidden="true"
        >
          <ZapIcon className="size-6 text-white" />
        </span>

        <h1 className="text-heading-xl text-foreground mt-6 font-semibold">
          Create your organisation
        </h1>
        <p className="text-body-md text-subdued mt-2">
          Everything you build lives in an organisation. You can invite people to it later.
        </p>

        {create.isError && !taken && Object.keys(fieldErrors).length === 0 ? (
          <Alert variant="danger" className="mt-6">
            <AlertTriangleIcon />
            <AlertTitle>
              {messageFor(create.error, 'We could not create that organisation')}
            </AlertTitle>
            <AlertDescription>Nothing was created. Try again.</AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={handleSubmit} className="mt-[26px] flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="org-name">Organisation name</Label>
            <Input
              id="org-name"
              name="org-name"
              autoFocus
              maxLength={ORG_NAME_MAX_LENGTH}
              placeholder="Blinto"
              value={name}
              aria-invalid={fieldErrors.name !== undefined}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            {fieldErrors.name === undefined ? null : (
              <p className="text-caption text-danger" role="alert">
                {fieldErrors.name}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="org-slug">Handle</Label>
            <Input
              id="org-slug"
              name="org-slug"
              placeholder="blinto"
              value={effectiveSlug}
              aria-invalid={slugError !== undefined}
              aria-describedby="org-slug-hint"
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(event.target.value);
              }}
            />
            {slugError === undefined ? (
              <p id="org-slug-hint" className="text-caption text-faint">
                Lowercase letters, digits and hyphens. It has to be unique, and you can&apos;t
                change it later.
              </p>
            ) : (
              <p id="org-slug-hint" className="text-caption text-danger" role="alert">
                {slugError}
              </p>
            )}
          </div>

          <Button
            type="submit"
            className="mt-2 w-full"
            disabled={create.isPending || name.trim().length === 0}
          >
            {create.isPending ? (
              <>
                <Loader2Icon className="animate-spin" aria-hidden="true" />
                Creating
              </>
            ) : (
              <>
                Create organisation
                <ArrowRightIcon aria-hidden="true" />
              </>
            )}
          </Button>
        </form>
      </div>
    </main>
  );
}
