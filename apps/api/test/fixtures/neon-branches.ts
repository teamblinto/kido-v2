import type { Answer, ProviderFixture } from './provider-fixtures';

/**
 * Neon's branch API in memory (spec 030 contracts/provider-adapters.md § 3), installed on a
 * `startNeonFixture()` server after each `reset()`. Stateful: a created branch is listed, found
 * by `search`, deleted, and its operations answer `finished` unless a spec scripts otherwise.
 */
export interface NeonBranchState {
  readonly branches: { id: string; name: string; parent_id: string | null; default: boolean }[];
  /** Operation id → the statuses it answers in turn; the last repeats. Default `['finished']`. */
  readonly operations: Map<string, string[]>;
  /** The status the next POST/DELETE answers instead of creating/deleting; one-shot. */
  next: { readonly method: 'DELETE' | 'POST'; readonly answer: Answer } | undefined;
  /** How the next created branch's operation answers. */
  createStatuses: string[];
  created: number;
}

export const NEON_PROJECT = 'proj-1';

export function installNeonBranches(fixture: ProviderFixture): NeonBranchState {
  const state: NeonBranchState = {
    branches: [{ default: true, id: 'br-main', name: 'main', parent_id: null }],
    createStatuses: ['finished'],
    created: 0,
    next: undefined,
    operations: new Map(),
  };

  const takeNext = (method: 'DELETE' | 'POST'): Answer | undefined => {
    if (state.next?.method !== method) return undefined;
    const { answer } = state.next;
    state.next = undefined;
    return answer;
  };

  fixture.route('GET', '/projects/:project/branches', (_params, request) => {
    const search = request.query.get('search') ?? '';

    return {
      body: { branches: state.branches.filter((branch) => branch.name.includes(search)) },
      status: 200,
    };
  });

  fixture.route('POST', '/projects/:project/branches', (_params, request) => {
    const scripted = takeNext('POST');
    if (scripted !== undefined) return scripted;

    const body = request.body as { branch: { name: string; parent_id: string } };
    state.created += 1;
    const id = `br-new-${String(state.created)}`;
    const operation = `op-create-${String(state.created)}`;

    state.branches.push({
      default: false,
      id,
      name: body.branch.name,
      parent_id: body.branch.parent_id,
    });
    state.operations.set(operation, [...state.createStatuses]);

    return {
      body: {
        branch: { id, name: body.branch.name, parent_id: body.branch.parent_id },
        endpoints: [{ id: `ep-${id}`, type: 'read_write' }],
        operations: [{ id: operation, status: 'running' }],
      },
      status: 201,
    };
  });

  fixture.route('DELETE', '/projects/:project/branches/:branch', ({ branch }) => {
    const scripted = takeNext('DELETE');
    if (scripted !== undefined) return scripted;

    const index = state.branches.findIndex((row) => row.id === branch);
    if (index < 0) return { body: { message: 'not found' }, status: 404 };

    const [removed] = state.branches.splice(index, 1);
    const operation = `op-delete-${branch!}`;
    state.operations.set(operation, ['finished']);

    return {
      body: { branch: removed, operations: [{ id: operation, status: 'running' }] },
      status: 200,
    };
  });

  fixture.route('GET', '/projects/:project/operations/:operation', ({ operation }) => {
    const statuses = state.operations.get(operation!) ?? ['finished'];
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;

    return { body: { operation: { id: operation, status } }, status: 200 };
  });

  fixture.route('GET', '/projects/:project/connection_uri', (_params, request) => ({
    body: {
      uri: `postgres://${request.query.get('role_name') ?? ''}:pw@${request.query.get('branch_id') ?? ''}-pooler.neon.test/${request.query.get('database_name') ?? ''}?sslmode=require`,
    },
    status: 200,
  }));

  fixture.route('GET', '/projects/:project/branches/:branch/databases', () => ({
    body: { databases: [{ name: 'neondb', owner_name: 'neondb_owner' }] },
    status: 200,
  }));

  fixture.route('GET', '/projects/:project/branches/:branch/roles', () => ({
    body: { roles: [{ name: 'neondb_owner' }] },
    status: 200,
  }));

  return state;
}
