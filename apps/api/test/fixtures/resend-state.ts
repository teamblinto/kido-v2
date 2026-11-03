import type { Answer, ProviderFixture } from './provider-fixtures';

/**
 * Resend's domains and API keys in memory (spec 030 contracts/provider-adapters.md § 5), installed
 * on a `startResendFixture()` server after each `reset()`. Stateful: `GET /domains` pages with
 * `limit` + `after`, a created key is listed and deleted, and a spec flips a domain's `status`.
 */
export interface ResendDomain {
  readonly id: string;
  readonly name: string;
  status: string;
}

export interface ResendKey {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  readonly permission: string;
  readonly domainId: string | undefined;
}

export interface ResendState {
  readonly domains: ResendDomain[];
  readonly keys: ResendKey[];
  /** The status the next POST /api-keys answers instead of creating; one-shot. */
  nextCreate: Answer | undefined;
  created: number;
}

export const RESEND_VERIFIED_DOMAIN = 'dom-verified';
export const RESEND_PENDING_DOMAIN = 'dom-pending';
/** The platform's own sending domain (`MAIL_FROM`'s default, `noreply@forge.dev`). */
export const RESEND_PLATFORM_DOMAIN = 'dom-platform';

export function installResendState(fixture: ProviderFixture): ResendState {
  const state: ResendState = {
    created: 0,
    domains: [
      { id: RESEND_VERIFIED_DOMAIN, name: 'mail.acme.test', status: 'verified' },
      { id: RESEND_PENDING_DOMAIN, name: 'news.acme.test', status: 'pending' },
      { id: RESEND_PLATFORM_DOMAIN, name: 'forge.dev', status: 'verified' },
    ],
    keys: [],
    nextCreate: undefined,
  };

  fixture.route('GET', '/domains', (_params, request) => {
    const limit = Number(request.query.get('limit') ?? '100');
    const after = request.query.get('after');
    const start = after === null ? 0 : state.domains.findIndex((row) => row.id === after) + 1;
    const slice = state.domains.slice(start, start + limit);

    return {
      body: {
        data: slice.map((row) => ({ ...row, region: 'us-east-1' })),
        has_more: start + limit < state.domains.length,
        object: 'list',
      },
      status: 200,
    };
  });

  fixture.route('GET', '/domains/:id', ({ id }) => {
    const domain = state.domains.find((row) => row.id === id);

    return domain === undefined
      ? { body: { message: 'Domain not found', name: 'not_found', statusCode: 404 }, status: 404 }
      : { body: { ...domain, object: 'domain', region: 'us-east-1' }, status: 200 };
  });

  fixture.route('POST', '/api-keys', (_params, request) => {
    if (state.nextCreate !== undefined) {
      const answer = state.nextCreate;
      state.nextCreate = undefined;
      return answer;
    }

    const body = request.body as { name: string; permission?: string; domain_id?: string };
    state.created += 1;
    const key: ResendKey = {
      domainId: body.domain_id,
      id: `key-${String(state.created)}`,
      name: body.name,
      permission: body.permission ?? 'full_access',
      token: `re_sending_${String(state.created)}_0123456789`,
    };
    state.keys.push(key);

    return { body: { id: key.id, token: key.token }, status: 201 };
  });

  fixture.route('GET', '/api-keys', () => ({
    body: {
      data: state.keys.map((row) => ({
        created_at: '2026-09-23T00:00:00.000Z',
        id: row.id,
        name: row.name,
      })),
    },
    status: 200,
  }));

  fixture.route('DELETE', '/api-keys/:id', ({ id }) => {
    const index = state.keys.findIndex((row) => row.id === id);
    if (index < 0) {
      return {
        body: { message: 'API key not found', name: 'not_found', statusCode: 404 },
        status: 404,
      };
    }

    state.keys.splice(index, 1);
    return { body: { deleted: true, id, object: 'api_key' }, status: 200 };
  });

  return state;
}
