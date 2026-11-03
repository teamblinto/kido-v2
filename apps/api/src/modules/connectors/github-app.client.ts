import { createPrivateKey, type KeyObject } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';
import type { z } from 'zod';

import { type Plaintext, plaintext, revealPlaintext } from '../../common/crypto/branded';
import type { Environment } from '../../config/environment';
import { GithubApiError, githubFetch } from './github-fetch';
import {
  accessTokenSchema,
  branchSchema,
  contentsSchema,
  installationSchema,
  repositoryPageSchema,
  repositorySchema,
  treeSchema,
} from './github.schemas';

export { GithubApiError, type GithubErrorCategory } from './github-fetch';

/**
 * The client behind a token (plan III, ports and adapters) so a suite can point the same class at
 * the fixture server through `GITHUB_API_URL` — one adapter, not two.
 */
export const GITHUB_APP_CLIENT = Symbol('forge.connectors.githubAppClient');

const API_VERSION = '2022-11-28';
/** GitHub's maximum page; the list cursor counts pages of this size. */
export const REPOSITORIES_PER_PAGE = 100;

export interface GithubAccount {
  readonly id: number;
  readonly login: string;
  readonly type: 'Organization' | 'User';
}

export interface GithubInstallation {
  readonly account: GithubAccount;
  readonly id: number;
}

export interface GithubRepository {
  readonly defaultBranch: string;
  readonly fullName: string;
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  readonly private: boolean;
  /** Spec 026 R6: KiB, as GitHub reports it; 0 when the payload omitted it. */
  readonly sizeKib: number;
}

/** One entry directly at a tree's root (spec 026 R3). */
export interface GithubTreeEntry {
  readonly path: string;
  readonly type: string;
}

export interface GithubTree {
  readonly entries: readonly GithubTreeEntry[];
  /** GitHub cut the listing: the root this describes is not the whole root. */
  readonly truncated: boolean;
}

export interface GithubRepositoryPage {
  readonly repositories: readonly GithubRepository[];
  readonly totalCount: number;
}

export interface GithubBranch {
  readonly name: string;
  readonly sha: string;
}

export interface MintTokenRequest {
  /** R3: the one linked repository for a push or pull; absent for the org-wide cached token. */
  readonly repositoryIds?: readonly number[];
  readonly permissions: Readonly<Record<string, string>>;
}

export interface MintedToken {
  readonly expiresAt: Date;
  readonly token: Plaintext;
}

function toRepository(raw: z.infer<typeof repositorySchema>): GithubRepository {
  return {
    defaultBranch: raw.default_branch,
    fullName: raw.full_name,
    id: raw.id,
    name: raw.name,
    owner: raw.owner.login,
    private: raw.private,
    sizeKib: raw.size ?? 0,
  };
}

/**
 * The GitHub App, as the connector sees it: App-JWT calls about an installation, and
 * installation-token calls about repositories. The App key never leaves this class; a minted
 * token leaves only as a {@link Plaintext}.
 *
 * Failure asymmetry (plan III): every method **fails closed** — no token, no answer, never a retry
 * with a wider request — except {@link deleteInstallation}, which is best effort: a 404 is success.
 */
@Injectable()
export class GithubAppClient {
  private readonly apiUrl: string;
  private readonly appId: number | undefined;
  private readonly key: KeyObject | undefined;
  private readonly logger = new Logger(GithubAppClient.name);

  constructor(config: ConfigService<Environment, true>) {
    this.apiUrl = config.get('GITHUB_API_URL', { infer: true }).replace(/\/+$/, '');
    this.appId = config.get('GITHUB_APP_ID', { infer: true });

    const pem = config.get('GITHUB_APP_PRIVATE_KEY', { infer: true });

    this.key = pem === undefined ? undefined : createPrivateKey(pem);
  }

  /** `environment.ts` validates the four `GITHUB_APP_*` both-or-neither; the two used here stand for all. */
  isConfigured(): boolean {
    return this.appId !== undefined && this.key !== undefined;
  }

  async installation(id: number): Promise<GithubInstallation> {
    return this.call(`/app/installations/${String(id)}`, await this.appJwt(), installationSchema);
  }

  async mintToken(installationId: number, request: MintTokenRequest): Promise<MintedToken> {
    const minted = await this.call(
      `/app/installations/${String(installationId)}/access_tokens`,
      await this.appJwt(),
      accessTokenSchema,
      {
        body: JSON.stringify({
          permissions: request.permissions,
          ...(request.repositoryIds === undefined ? {} : { repository_ids: request.repositoryIds }),
        }),
        method: 'POST',
      },
    );

    return { expiresAt: new Date(minted.expires_at), token: plaintext(minted.token) };
  }

  /** R13: best effort — GitHub already forgetting the installation is the outcome we wanted. */
  async deleteInstallation(id: number): Promise<void> {
    try {
      await this.call(`/app/installations/${String(id)}`, await this.appJwt(), undefined, {
        method: 'DELETE',
      });
    } catch (error) {
      if (error instanceof GithubApiError && error.category === 'not-found') {
        return;
      }

      throw error;
    }
  }

  async listRepositories(token: Plaintext, page: number): Promise<GithubRepositoryPage> {
    const raw = await this.call(
      `/installation/repositories?per_page=${String(REPOSITORIES_PER_PAGE)}&page=${String(page)}`,
      bearerOf(token),
      repositoryPageSchema,
    );

    return { repositories: raw.repositories.map(toRepository), totalCount: raw.total_count };
  }

  async createOrgRepository(
    token: Plaintext,
    org: string,
    name: string,
    isPrivate: boolean,
  ): Promise<GithubRepository> {
    return toRepository(
      await this.call(`/orgs/${encodeURIComponent(org)}/repos`, bearerOf(token), repositorySchema, {
        body: JSON.stringify({ name, private: isPrivate }),
        method: 'POST',
      }),
    );
  }

  async repository(token: Plaintext, id: number): Promise<GithubRepository> {
    return toRepository(
      await this.call(`/repositories/${String(id)}`, bearerOf(token), repositorySchema),
    );
  }

  async branch(
    token: Plaintext,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<GithubBranch> {
    const raw = await this.call(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`,
      bearerOf(token),
      branchSchema,
    );

    return { name: raw.name, sha: raw.commit.sha };
  }

  /**
   * The root of a tree, non-recursive (spec 026 R3): one call, no truncation on any repository
   * whose root is a root rather than a directory listing of the world. A recursive tree would be
   * truncated on a large repository, and a silently truncated tree silently changes the answer.
   */
  async tree(token: Plaintext, repoId: number, sha: string): Promise<GithubTree> {
    const raw = await this.call(
      `/repositories/${String(repoId)}/git/trees/${encodeURIComponent(sha)}`,
      bearerOf(token),
      treeSchema,
    );

    return {
      entries: raw.tree.map((entry) => ({ path: entry.path, type: entry.type })),
      truncated: raw.truncated ?? false,
    };
  }

  /**
   * One file's text at the default branch (spec 026 R3 reads the root `package.json`). A file
   * GitHub serves in an encoding this does not know is `undefined` rather than a throw: the
   * inspection loses the dependency signals, not the whole answer.
   */
  async contents(token: Plaintext, repoId: number, path: string): Promise<string | undefined> {
    const raw = await this.call(
      `/repositories/${String(repoId)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
      bearerOf(token),
      contentsSchema,
    );

    return raw.encoding === 'base64'
      ? Buffer.from(raw.content, 'base64').toString('utf8')
      : raw.encoding === 'utf-8' || raw.encoding === 'none'
        ? raw.content
        : undefined;
  }

  /** The App JWT GitHub specifies: `iss` = app id, `iat` 60 s back for clock skew, `exp` +10 min, RS256, no `kid`. */
  private async appJwt(): Promise<string> {
    if (this.appId === undefined || this.key === undefined) {
      throw new GithubApiError('not-configured');
    }

    const now = Math.floor(Date.now() / 1000);

    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(String(this.appId))
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 600)
      .sign(this.key);
  }

  private async call<T>(
    path: string,
    bearer: string,
    shape: z.ZodType<T> | undefined,
    init: RequestInit = {},
  ): Promise<T> {
    if (!this.isConfigured()) {
      throw new GithubApiError('not-configured');
    }

    const body = await githubFetch(
      `${this.apiUrl}${path}`,
      {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          // Never logged: `redaction.ts` lists `req.headers.authorization`, and the transport
          // scrubber censors `Bearer …` and `ghs_…` wherever they appear in a rendered line.
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': API_VERSION,
        },
      },
      { logger: this.logger },
    );

    if (shape === undefined) {
      return undefined as T;
    }

    const parsed = shape.safeParse(body);

    if (!parsed.success) {
      this.logger.warn(`GitHub answered ${path} with an unexpected shape`);

      throw new GithubApiError('unavailable');
    }

    return parsed.data;
  }
}

function bearerOf(token: Plaintext): string {
  return revealPlaintext(token).toString('utf8');
}
