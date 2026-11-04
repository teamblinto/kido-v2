import { SYNC_FAILURE_REASONS, type SyncFailureReason } from '@repo/contracts';
import { z } from 'zod';

import { ApiProblem, messageFor } from '@/lib/api/problem';
import { projectPath } from '@/lib/routes';

/** Contracts § 3's vocabulary as copy. Local on purpose: no slug, no `MESSAGES` entry (R12). */
export const REASON_COPY: Record<SyncFailureReason, string> = {
  'account-mismatch':
    'That GitHub account is not the one connected here. Sign in as the connected account and try again.',
  'branch-not-found': 'That branch no longer exists on the repository.',
  'branch-protected': 'That branch is protected on GitHub, so it refused the push.',
  'bundle-too-large': 'The repository is too large to send.',
  'create-unsupported': 'This connection cannot create repositories. Choose an existing one.',
  diverged: 'GitHub and the project have each changed. Merge on GitHub, then pull.',
  'empty-repo': 'That repository has no commits to import.',
  'git-failed': 'Git failed. Try again.',
  'import-checkout-failed': 'The repository could not be checked out. Try the import again.',
  'name-taken': 'A repository with that name already exists.',
  'needs-reauth': 'GitHub needs reconnecting. Ask an owner to verify the connector.',
  'not-linked': 'The project is not linked to a repository.',
  'nothing-to-push': 'Nothing to push: the project has no checkpoint yet.',
  'operation-in-flight': 'A sync is already in progress.',
  'provider-unavailable': 'GitHub is unavailable right now. Try again later.',
  'push-rejected': 'GitHub refused the push, usually a large file or a secret in the code.',
  'remote-ahead': 'The repository is ahead of the project. Pull first.',
  'repo-gone': 'The repository is gone from GitHub, or can no longer be reached. Unlink it.',
  'repo-too-large': 'That repository is too large to import.',
  'run-active': 'A run is active. Wait for it to finish.',
  'timed-out': 'The sync timed out.',
  'workflow-permission':
    "This push changes GitHub workflow files, which needs the GitHub App's Workflows permission.",
};

function isReason(value: unknown): value is SyncFailureReason {
  return typeof value === 'string' && (SYNC_FAILURE_REASONS as readonly string[]).includes(value);
}

/** A refusal's `reason` extension (contracts § 4) beats the generic slug copy. */
export function errorCopy(error: unknown, fallback?: string): string {
  const reason = ApiProblem.is(error) ? error.detail?.reason : undefined;

  return isReason(reason) ? REASON_COPY[reason] : messageFor(error, fallback);
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

export const repoUrl = (fullName: string): string => `https://github.com/${fullName}`;

export const commitUrl = (fullName: string, sha: string): string =>
  `${repoUrl(fullName)}/commit/${sha}`;

/** A branch may hold `/`, which GitHub's compare path keeps; anything else in it is escaped. */
const branchPath = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/');

export const compareUrl = (fullName: string, base: string, head: string): string =>
  `${repoUrl(fullName)}/compare/${branchPath(base)}...${branchPath(head)}`;

/** GitHub's repository-name alphabet, from whatever the person called the project. */
export function repositorySlug(projectName: string): string {
  return projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .slice(0, 100);
}

/** Where the install flow comes back to, read by `github-callback-page`. */
export const GITHUB_RETURN_KEY = 'github-return-to';
/** What the personal-account create remembers across GitHub, read by `github-authorized-page`. */
export const GITHUB_AUTHORIZE_KEY = 'github-authorize';

/** The project with the GitHub panel open, so a trip to GitHub ends where it started. */
export function githubPanelPath(projectId: string): string {
  return `${projectPath(projectId)}?panel=github`;
}

/**
 * A stored return path, only if it stays on this origin. Parsing is what catches `/\evil.com` and
 * `/<tab>/evil.com`, which pass a prefix check and which a browser reads as `//evil.com`.
 */
export function safeReturnPath(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!value.startsWith('/') || value.startsWith('//')) return undefined;

  const { origin } = window.location;

  return new URL(value, origin).origin === origin ? value : undefined;
}

const authorizeSchema = z.object({ projectId: z.uuid(), returnTo: z.string() });

/** The remembered create, or undefined when the storage is gone or is not what was written. */
export function readAuthorize(): { projectId: string; returnTo: string } | undefined {
  try {
    const parsed = authorizeSchema.safeParse(
      JSON.parse(window.sessionStorage.getItem(GITHUB_AUTHORIZE_KEY) ?? 'null'),
    );

    if (!parsed.success) return undefined;

    const { projectId, returnTo } = parsed.data;

    return { projectId, returnTo: safeReturnPath(returnTo) ?? githubPanelPath(projectId) };
  } catch {
    return undefined;
  }
}
