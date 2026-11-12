import type { Binding, Connection, Operation } from '@repo/contracts';
import type { UseInfiniteQueryResult, UseMutationResult } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';
import {
  useBind,
  useBindings,
  useNeonProjects,
  useNeonReset,
  useNetlifySites,
  useOrgConnections,
  useResendDomains,
  useSupabaseConnect,
  useSupabaseProjects,
  useUnbind,
} from '../hooks/use-integrations';
import { MigrationsSection } from './migrations-section';

/** contracts/preview-env.md § 5 (§06): said under any binding that contributes values. */
export const DISCLOSURE =
  'Anyone who can edit this project can make its preview reveal these values.';

/** Shown after a reset: the preview restarts on its own once the new branch is ready. */
export const RESET_NOTICE = 'The preview restarts by itself to pick up the new database.';

const REASON_COPY: Readonly<Record<string, string>> = {
  disconnected: 'Connect this provider in organisation settings first.',
  'in-flight': 'A change is already on its way; try again when it finishes.',
  'missing-scope': 'The connection is missing a permission; reconnect it in settings.',
  'needs-reauth': 'The connection needs to be reconnected in organisation settings.',
  'not-ready': 'The database is not ready yet; try again once it is.',
  'provider-unavailable': 'The provider is unavailable; try again shortly.',
  removing: 'The connection is being removed.',
  'provider-refused': 'The provider refused the request.',
  'site-gone': 'The Netlify site no longer exists; choose another site.',
};

/** Reasons whose fix is on the organisation's connectors page. */
const SETTINGS_REASONS = new Set(['disconnected', 'missing-scope', 'needs-reauth']);

function SettingsLink({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <Link to={routes.connectorsSettings} className="underline underline-offset-2">
      {children}
    </Link>
  );
}

function errorCopy(error: unknown): React.ReactNode {
  const reason = ApiProblem.is(error) ? error.detail?.reason : undefined;

  if (typeof reason !== 'string' || !(reason in REASON_COPY)) return messageFor(error);

  return SETTINGS_REASONS.has(reason) ? (
    <span>
      <span>{REASON_COPY[reason]}</span> <SettingsLink>Open settings</SettingsLink>
    </span>
  ) : (
    REASON_COPY[reason]
  );
}

const RESOURCE_COPY: Readonly<Record<string, string>> = {
  failed: 'Failed',
  live: 'Ready',
  provisioning: 'Creating…',
  released: 'Released',
  releasing: 'Removing…',
};

interface IntegrationsPanelProps {
  readonly orgId: string;
  readonly projectId: string;
  /** The caller's project permissions; `project:files.write` may reset the preview database. */
  readonly permissions: readonly string[];
}

/** What unbinding does at the provider, said before it happens. */
const UNBIND_COPY = {
  neon: 'The preview branch is deleted at Neon, with its data.',
  netlify: 'Nothing is deleted at Netlify; releases stop publishing to the site.',
  resend: "The project's sending key is deleted at Resend. The domain stays.",
  supabase: 'Nothing is deleted at Supabase; the preview stops getting its keys.',
} as const;

/**
 * The project's integrations (spec 030 US3–US5): a Neon preview database, a Supabase project, the
 * Netlify site releases are published to, and the Resend domain the app sends mail from.
 * Binding needs `org:connectors.manage` — owners and admins, as the settings page reads it — so
 * the controls follow the caller's org role; the API enforces it either way. The values themselves
 * never reach the browser — only each resource's state.
 */
export function IntegrationsPanel({
  orgId,
  permissions,
  projectId,
}: IntegrationsPanelProps): React.JSX.Element {
  const connections = useOrgConnections(orgId);
  const bindings = useBindings(orgId, projectId);
  const orgs = useOrgs();
  const role = orgs.orgs.find((row) => row.id === orgId)?.role;
  const canManage = role === 'owner' || role === 'admin';

  if (connections.isLoading || bindings.isLoading || orgs.isLoading) {
    return (
      <div className="flex items-center gap-2.5 p-4" role="status" aria-live="polite">
        <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">Loading…</span>
      </div>
    );
  }

  if (connections.isError || bindings.isError) {
    return (
      <p className="text-body-sm text-danger p-4" role="alert">
        {messageFor(connections.error ?? bindings.error, 'Integrations could not be loaded.')}
      </p>
    );
  }

  const connectionOf = (provider: 'neon' | 'netlify' | 'resend' | 'supabase') =>
    connections.data?.connections.find((row) => row.provider === provider);
  const bindingOf = (provider: 'neon' | 'netlify' | 'resend' | 'supabase') =>
    bindings.data?.items.find((row) => row.provider === provider);

  return (
    <section className="flex flex-col gap-6 p-4" aria-labelledby="integrations-heading">
      <h2 id="integrations-heading" className="text-heading-sm font-semibold">
        Integrations
      </h2>
      {canManage ? null : (
        <p className="text-body-sm text-subdued">
          Only organisation owners and admins can bind or unbind these.
        </p>
      )}
      <NeonSection
        binding={bindingOf('neon')}
        canManage={canManage}
        canReset={permissions.includes('project:files.write')}
        connection={connectionOf('neon')}
        orgId={orgId}
        projectId={projectId}
      />
      <SupabaseSection
        binding={bindingOf('supabase')}
        canManage={canManage}
        connection={connectionOf('supabase')}
        orgId={orgId}
        projectId={projectId}
      />
      <NetlifySection
        binding={bindingOf('netlify')}
        canManage={canManage}
        connection={connectionOf('netlify')}
        orgId={orgId}
        projectId={projectId}
      />
      <ResendSection
        binding={bindingOf('resend')}
        canManage={canManage}
        connection={connectionOf('resend')}
        orgId={orgId}
        projectId={projectId}
      />
    </section>
  );
}

interface SectionProps {
  readonly binding: Binding | undefined;
  /** `org:connectors.manage`: bind, unbind and apply migrations. */
  readonly canManage: boolean;
  readonly connection: Connection | undefined;
  readonly orgId: string;
  readonly projectId: string;
}

/** The connection to list resources through: only for a manager, before binding, while it works. */
function pickerConnection({ binding, canManage, connection }: SectionProps): string | undefined {
  return binding === undefined && canManage && connection?.health !== 'needs_reauth'
    ? connection?.id
    : undefined;
}

/** Whether there is a database to migrate: bound, with its branch or keys live. */
function isLive(binding: Binding | undefined): boolean {
  return (
    binding?.state === 'bound' && binding.resources.some((resource) => resource.state === 'live')
  );
}

/** A picker's loading, error and empty states, and the next page when there is one. */
function PickerStatus({
  empty,
  query,
}: {
  readonly empty: string;
  readonly query: UseInfiniteQueryResult<readonly unknown[], Error>;
}): React.JSX.Element | null {
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2" role="status">
        <Loader2 className="text-subdued size-4 animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">Loading…</span>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex items-center gap-2">
        <p className="text-body-sm text-danger" role="alert">
          {messageFor(query.error, 'The list could not be loaded.')}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void query.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (query.data?.length === 0) {
    return <p className="text-body-sm text-subdued">{empty}</p>;
  }

  return query.hasNextPage ? (
    <div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={query.isFetchingNextPage}
        onClick={() => {
          void query.fetchNextPage();
        }}
      >
        {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
      </Button>
    </div>
  ) : null;
}

/** Unbind, after saying what it does at the provider. */
function UnbindButton({
  consequence,
  name,
  unbind,
}: {
  readonly consequence: string;
  readonly name: string;
  readonly unbind: UseMutationResult<Operation, Error, void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={unbind.isPending}
        onClick={() => {
          setOpen(true);
        }}
      >
        Unbind
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Unbind {name}?</DialogTitle>
            <DialogDescription>{consequence}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={unbind.isPending}
              onClick={() => {
                unbind.mutate(undefined, {
                  onSettled: () => {
                    setOpen(false);
                  },
                });
              }}
            >
              {unbind.isPending ? 'Unbinding…' : `Unbind ${name}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ResourceState({ binding }: { readonly binding: Binding }): React.JSX.Element {
  const resource = binding.resources[0];
  const failed = binding.latestOperation?.state === 'failed';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge variant="outline">
          {resource === undefined
            ? failed
              ? 'Failed'
              : 'Waiting…'
            : (RESOURCE_COPY[resource.state] ?? resource.state)}
        </Badge>
        {resource === undefined ? null : (
          <span className="text-body-sm text-subdued">{resource.name}</span>
        )}
      </div>
      {failed && binding.latestOperation?.reason ? (
        <p className="text-body-sm text-danger" role="alert">
          {REASON_COPY[binding.latestOperation.reason] ?? 'The last change failed.'}
        </p>
      ) : null}
      {resource?.state === 'live' ? (
        <p className="text-body-sm text-subdued">{DISCLOSURE}</p>
      ) : null}
    </div>
  );
}

function NotConnected({ name }: { readonly name: string }): React.JSX.Element {
  return (
    <p className="text-body-sm text-subdued">
      No {name} connection. An organisation admin can connect {name} in{' '}
      <SettingsLink>settings</SettingsLink>.
    </p>
  );
}

/** Spec 030 US6 (SC-007): what a connection's health means for this project, until it recovers. */
function connectionHealthCopy(name: string, health: Connection['health']): React.ReactNode {
  switch (health) {
    case 'needs_reauth':
      return (
        <span>
          The {name} connection needs to be reconnected. An organisation admin can reconnect it in{' '}
          <SettingsLink>settings</SettingsLink>; until then nothing here changes.
        </span>
      );
    case 'unavailable':
      return `${name} is not answering right now. Changes wait until it recovers; try again shortly.`;
    default:
      return null;
  }
}

/** The per-provider needs-reauth / unavailable banner (spec 030 T090). */
export function ConnectionHealthBanner({
  connection,
  name,
}: {
  readonly connection: Connection | undefined;
  readonly name: string;
}): React.JSX.Element | null {
  const copy = connection === undefined ? null : connectionHealthCopy(name, connection.health);

  if (copy === null) return null;

  return <Alert variant="warning">{copy}</Alert>;
}

/** A bind form, locked while its connection needs reconnecting (nothing would go through). */
function BindForm({
  children,
  connection,
  onSubmit,
}: {
  readonly children: React.ReactNode;
  readonly connection: Connection;
  readonly onSubmit: React.FormEventHandler<HTMLFormElement>;
}): React.JSX.Element {
  return (
    <form onSubmit={onSubmit}>
      <fieldset
        className="flex min-w-0 flex-col gap-3"
        disabled={connection.health === 'needs_reauth'}
      >
        {children}
      </fieldset>
    </form>
  );
}

function NativeSelect({
  label,
  onChange,
  options,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly { readonly label: string; readonly value: string }[];
  readonly value: string;
}): React.JSX.Element {
  const id = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="border-line bg-canvas text-body-md h-[40px] rounded-lg border px-[11px]"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">Choose…</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function NeonSection(props: SectionProps & { readonly canReset: boolean }): React.JSX.Element {
  const { binding, canManage, canReset, connection, orgId, projectId } = props;
  const projects = useNeonProjects(orgId, pickerConnection(props));
  const bind = useBind(orgId, projectId, 'neon');
  const unbind = useUnbind(orgId, projectId, 'neon');
  const reset = useNeonReset(orgId, projectId);
  const [neonProject, setNeonProject] = useState('');
  const [parent, setParent] = useState('');
  const [database, setDatabase] = useState('');
  const [role, setRole] = useState('');

  const chosen = projects.data?.find((row) => row.id === neonProject);
  const error = bind.error ?? unbind.error ?? reset.error;

  return (
    <div className="flex flex-col gap-3" aria-labelledby="neon-heading">
      <h3 id="neon-heading" className="text-body-md font-semibold">
        Neon preview database
      </h3>
      {connection === undefined ? <NotConnected name="Neon" /> : null}
      <ConnectionHealthBanner connection={connection} name="Neon" />
      {binding !== undefined ? (
        <>
          <ResourceState binding={binding} />
          <div className="flex flex-wrap gap-2">
            {canReset ? (
              <Button
                size="sm"
                variant="outline"
                disabled={reset.isPending}
                onClick={() => {
                  reset.mutate();
                }}
              >
                Reset preview database
              </Button>
            ) : null}
            {canManage ? (
              <UnbindButton consequence={UNBIND_COPY.neon} name="Neon" unbind={unbind} />
            ) : null}
          </div>
          {reset.isSuccess ? (
            <p className="text-body-sm text-subdued" role="status">
              {RESET_NOTICE}
            </p>
          ) : null}
          {isLive(binding) ? (
            <MigrationsSection
              canManage={canManage}
              errorCopy={errorCopy}
              orgId={orgId}
              projectId={projectId}
              provider="neon"
            />
          ) : null}
        </>
      ) : null}
      {binding === undefined && connection !== undefined && canManage ? (
        <BindForm
          connection={connection}
          onSubmit={(event) => {
            event.preventDefault();
            bind.mutate({
              databaseName: database,
              parentBranchId: parent,
              projectId: neonProject,
              roleName: role,
            });
          }}
        >
          <NativeSelect
            label="Neon project"
            value={neonProject}
            onChange={(value) => {
              setNeonProject(value);
              const next = projects.data?.find((row) => row.id === value);
              setParent(next?.branches.find((branch) => branch.default)?.id ?? '');
              setDatabase(next?.databases[0] ?? '');
              setRole(next?.roles[0] ?? '');
            }}
            options={(projects.data ?? []).map((row) => ({
              label: row.name,
              value: row.id,
            }))}
          />
          <PickerStatus query={projects} empty="This Neon account has no projects yet." />
          {chosen === undefined ? null : (
            <>
              <NativeSelect
                label="Parent branch"
                value={parent}
                onChange={setParent}
                options={chosen.branches.map((row) => ({ label: row.name, value: row.id }))}
              />
              <NativeSelect
                label="Database"
                value={database}
                onChange={setDatabase}
                options={chosen.databases.map((name) => ({ label: name, value: name }))}
              />
              <NativeSelect
                label="Role"
                value={role}
                onChange={setRole}
                options={chosen.roles.map((name) => ({ label: name, value: name }))}
              />
            </>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={
              bind.isPending ||
              neonProject === '' ||
              parent === '' ||
              database === '' ||
              role === ''
            }
          >
            Create preview database
          </Button>
        </BindForm>
      ) : null}
      {error === null ? null : <Alert variant="danger">{errorCopy(error)}</Alert>}
    </div>
  );
}

function SupabaseSection(props: SectionProps): React.JSX.Element {
  const { binding, canManage, connection, orgId, projectId } = props;
  const projects = useSupabaseProjects(orgId, pickerConnection(props));
  const bind = useBind(orgId, projectId, 'supabase');
  const unbind = useUnbind(orgId, projectId, 'supabase');
  const connect = useSupabaseConnect(orgId, projectId);
  const [ref, setRef] = useState('');
  const error = bind.error ?? unbind.error ?? connect.error;
  const reconnect = connection?.health === 'needs_reauth';

  return (
    <div className="flex flex-col gap-3" aria-labelledby="supabase-heading">
      <h3 id="supabase-heading" className="text-body-md font-semibold">
        Supabase
      </h3>
      {connection === undefined ? <NotConnected name="Supabase" /> : null}
      <ConnectionHealthBanner connection={connection} name="Supabase" />
      {canManage && (connection === undefined || reconnect) ? (
        <div>
          <Button
            size="sm"
            disabled={connect.isPending}
            onClick={() => {
              connect.mutate();
            }}
          >
            {reconnect ? 'Reconnect Supabase' : 'Connect Supabase'}
          </Button>
        </div>
      ) : null}
      {binding !== undefined ? (
        <>
          <ResourceState binding={binding} />
          {canManage ? (
            <div>
              <UnbindButton consequence={UNBIND_COPY.supabase} name="Supabase" unbind={unbind} />
            </div>
          ) : null}
          {isLive(binding) ? (
            <MigrationsSection
              canManage={canManage}
              errorCopy={errorCopy}
              orgId={orgId}
              projectId={projectId}
              provider="supabase"
            />
          ) : null}
        </>
      ) : null}
      {binding === undefined && connection !== undefined && canManage ? (
        <BindForm
          connection={connection}
          onSubmit={(event) => {
            event.preventDefault();
            bind.mutate({ projectRef: ref });
          }}
        >
          <NativeSelect
            label="Supabase project"
            value={ref}
            onChange={setRef}
            options={(projects.data ?? []).map((row) => ({
              label: `${row.name} (${row.region})`,
              value: row.ref,
            }))}
          />
          <PickerStatus query={projects} empty="This Supabase account has no projects yet." />
          <Button type="submit" size="sm" disabled={bind.isPending || ref === ''}>
            Use this project
          </Button>
        </BindForm>
      ) : null}
      {error === null ? null : <Alert variant="danger">{errorCopy(error)}</Alert>}
    </div>
  );
}

/** Spec 030 US4: bind to an existing Netlify site, or create one now; publishing is on the Site panel. */
function NetlifySection(props: SectionProps): React.JSX.Element {
  const { binding, canManage, connection, orgId, projectId } = props;
  const sites = useNetlifySites(orgId, pickerConnection(props));
  const bind = useBind(orgId, projectId, 'netlify');
  const unbind = useUnbind(orgId, projectId, 'netlify');
  const [siteId, setSiteId] = useState('');
  const [newName, setNewName] = useState('');
  const nameId = useId();
  const error = bind.error ?? unbind.error;
  const site = binding?.provider === 'netlify' ? binding.config : undefined;
  const nameValid = /^[a-z0-9-]{1,63}$/u.test(newName);

  return (
    <div className="flex flex-col gap-3" aria-labelledby="netlify-heading">
      <h3 id="netlify-heading" className="text-body-md font-semibold">
        Netlify
      </h3>
      {connection === undefined ? <NotConnected name="Netlify" /> : null}
      <ConnectionHealthBanner connection={connection} name="Netlify" />
      {binding !== undefined && site !== undefined ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {binding.state === 'bound' ? 'Connected' : 'Disconnected'}
            </Badge>
            <a
              href={site.siteUrl}
              target="_blank"
              rel="noreferrer"
              className="text-body-sm underline-offset-2 hover:underline"
            >
              {site.siteName}
            </a>
          </div>
          {binding.state === 'disconnected' ? (
            <p className="text-body-sm text-danger" role="alert">
              {REASON_COPY['site-gone']}
            </p>
          ) : null}
          {canManage ? (
            <div>
              <UnbindButton consequence={UNBIND_COPY.netlify} name="Netlify" unbind={unbind} />
            </div>
          ) : null}
        </>
      ) : null}
      {binding === undefined && connection !== undefined && canManage ? (
        <>
          <BindForm
            connection={connection}
            onSubmit={(event) => {
              event.preventDefault();
              bind.mutate({ siteId });
            }}
          >
            <NativeSelect
              label="Netlify site"
              value={siteId}
              onChange={setSiteId}
              options={(sites.data ?? []).map((row) => ({
                label: row.name,
                value: row.id,
              }))}
            />
            <PickerStatus query={sites} empty="This Netlify account has no sites yet." />
            <Button type="submit" size="sm" disabled={bind.isPending || siteId === ''}>
              Use this site
            </Button>
          </BindForm>
          <BindForm
            connection={connection}
            onSubmit={(event) => {
              event.preventDefault();
              bind.mutate({ createSite: { name: newName } });
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={nameId}>New site name</Label>
              <Input
                id={nameId}
                value={newName}
                placeholder="my-site"
                onChange={(event) => {
                  setNewName(event.target.value);
                }}
              />
            </div>
            <Button type="submit" size="sm" disabled={bind.isPending || !nameValid}>
              Create site
            </Button>
          </BindForm>
        </>
      ) : null}
      {error === null ? null : <Alert variant="danger">{errorCopy(error)}</Alert>}
    </div>
  );
}

/** Resend's domain words, in the panel's. Anything else is shown as Resend says it. */
const DOMAIN_STATUS_COPY: Readonly<Record<string, string>> = {
  failed: 'Verification failed',
  not_started: 'Not verified',
  pending: 'Verifying…',
  temporary_failure: 'Verification retrying',
  verified: 'Verified',
};

/** Shown while the domain is not verified: no key exists yet, and none reaches the preview. */
export const RESEND_WAITING =
  'The sending key is created once Resend verifies this domain; until then the preview cannot send mail.';

/**
 * Spec 030 US5 (FR-019, FR-020): bind a verified sending domain; the domain's verification state
 * and the domain-restricted sending key's state. The key itself never reaches the browser.
 */
function ResendSection(props: SectionProps): React.JSX.Element {
  const { binding, canManage, connection, orgId, projectId } = props;
  const domains = useResendDomains(orgId, pickerConnection(props));
  const bind = useBind(orgId, projectId, 'resend');
  const unbind = useUnbind(orgId, projectId, 'resend');
  const [domainId, setDomainId] = useState('');
  const error = bind.error ?? unbind.error;
  const resend = binding?.provider === 'resend' ? binding : undefined;
  const keyed = resend?.resources.some((row) => row.state === 'live') === true;
  const status = keyed ? 'verified' : resend?.domainStatus;

  return (
    <div className="flex flex-col gap-3" aria-labelledby="resend-heading">
      <h3 id="resend-heading" className="text-body-md font-semibold">
        Resend
      </h3>
      {connection === undefined ? <NotConnected name="Resend" /> : null}
      <ConnectionHealthBanner connection={connection} name="Resend" />
      {resend !== undefined ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body-sm">{resend.config.domainName}</span>
            {status === null || status === undefined ? null : (
              <Badge variant="outline">{DOMAIN_STATUS_COPY[status] ?? status}</Badge>
            )}
          </div>
          {status !== undefined && status !== null && status !== 'verified' ? (
            <p className="text-body-sm text-subdued" role="status">
              {RESEND_WAITING}
            </p>
          ) : (
            <ResourceState binding={resend} />
          )}
          {canManage ? (
            <div>
              <UnbindButton consequence={UNBIND_COPY.resend} name="Resend" unbind={unbind} />
            </div>
          ) : null}
        </>
      ) : null}
      {binding === undefined && connection !== undefined && canManage ? (
        <BindForm
          connection={connection}
          onSubmit={(event) => {
            event.preventDefault();
            bind.mutate({ domainId });
          }}
        >
          <NativeSelect
            label="Sending domain"
            value={domainId}
            onChange={setDomainId}
            options={(domains.data ?? []).map((row) => ({
              label: `${row.name} (${DOMAIN_STATUS_COPY[row.status] ?? row.status})`,
              value: row.id,
            }))}
          />
          <PickerStatus query={domains} empty="This Resend account has no domains yet." />
          <Button type="submit" size="sm" disabled={bind.isPending || domainId === ''}>
            Use this domain
          </Button>
        </BindForm>
      ) : null}
      {error === null ? null : <Alert variant="danger">{errorCopy(error)}</Alert>}
    </div>
  );
}
