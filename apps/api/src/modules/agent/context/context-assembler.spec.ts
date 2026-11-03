import type { AgentRun, ContextSkip, ProjectContext, RunMessage } from '@repo/db';
import { describe, expect, it } from 'vitest';

import { ScriptedProvider } from '../../../../test/support/scripted-provider';
import type { TenantContext } from '../../../database/tenant-context';
import { DEFAULT_AGENT_TIMINGS } from '../agent.constants';
import type { ExecResult, SandboxPort, SandboxRef } from '../../sandbox/sandbox.port';
import type { ConversationMessage, LlmClient } from '../llm-provider.port';
import { SYSTEM_PROMPT, toMessages } from '../prompt';
import type { RunStore } from '../run-store';
import { type AttemptScope, ContextAssembler } from './context-assembler';
import { porcelainDigest } from './git-commands';

const RUN_ID = 'run_0f3c1a2b-run-specific';
const USER_ID = 'user_9d8e7f6a-run-specific';
const AT = new Date('2026-09-21T10:11:12.000Z');

function row(id: string, role: RunMessage['role'], content: string, toolCalls: unknown[] = []) {
  return {
    at: AT,
    content,
    createdAt: AT,
    id,
    orgId: 'org_1',
    role,
    runId: RUN_ID,
    toolCalls,
    updatedAt: AT,
  } satisfies RunMessage;
}

/** 30 000 chars ≈ 7 500 tokens per result: 10 turns ≈ 75 000, over the 60 000 threshold. */
const BIG = 'x'.repeat(30_000);

/** A prompt then `count` turns of one call each, as `summary.spec.ts` builds them. */
function turns(count: number): RunMessage[] {
  const rows = [row('u0', 'user', 'fix the bug')];
  for (let turn = 1; turn <= count; turn += 1) {
    rows.push(
      row(`a${String(turn)}`, 'assistant', `decision ${String(turn)}`, [
        { id: `c${String(turn)}`, input: { path: `f${String(turn)}.ts` }, name: 'fs_read' },
      ]),
      row(
        `t${String(turn)}`,
        'tool',
        JSON.stringify([{ content: BIG, isError: false, toolUseId: `c${String(turn)}` }]),
      ),
    );
  }
  return rows;
}

/** A scope carrying everything run-specific the layout must keep out of the cached blocks. */
function scope(
  messages: RunMessage[] = [row('msg_1', 'user', `${USER_ID} asks: fix the bug`)],
): AttemptScope {
  const ref: SandboxRef = { orgId: 'org_1', projectId: 'proj_1' };

  return {
    client: {} as LlmClient,
    credential: { apiKey: 'sk-ant-test', mode: 'PLATFORM', provider: 'anthropic' },
    dispatch: (fn) => fn(),
    emit: () => Promise.resolve(),
    fence: { epoch: 1, orgId: 'org_1', runId: RUN_ID },
    ref,
    run: {
      committed: { openStepId: null, pauses: 0, toolEnds: 0 },
      epoch: 1,
      id: RUN_ID,
      lastSeq: 1,
      messages,
      model: 'claude-test',
      orgId: 'org_1',
      projectId: 'proj_1',
      status: 'starting',
      userId: USER_ID,
    },
    tenantTx: () => ({}) as TenantContext['tx'],
  };
}

const HEAD = 'a'.repeat(40);
const LS_FILES = 'git ls-files --cached --others --exclude-standard';

/** A git whose tree is `files` (path → content); `status` prints one `?? path` per dirty path. */
class FakeWorld {
  readonly files = new Map<string, string>();
  dirty: string[] = [];
  /** Commands that exit 128 with git's words instead of answering. */
  failing = new Set<string>();
  readonly execs: string[] = [];
  row: ProjectContext | undefined;
  upserts = 0;
  /** The run's rows and its three summary columns, as `run_messages` / `agent_runs` hold them. */
  messages: RunMessage[] = [];
  summary: Pick<AgentRun, 'summary' | 'summaryThroughMessageId' | 'summaryTokens'> = {
    summary: null,
    summaryThroughMessageId: null,
    summaryTokens: 0,
  };
  readonly skips: ContextSkip[] = [];
  readonly provider = new ScriptedProvider();

  readonly port = {
    exec: (_ref: unknown, command: string): Promise<ExecResult> => {
      this.execs.push(command);
      if (this.failing.has(command)) {
        return Promise.resolve({
          exitCode: 128,
          output: 'fatal: nope',
          timedOut: false,
          truncated: false,
        });
      }
      const output =
        command === 'git rev-parse HEAD'
          ? `${HEAD}\n`
          : command === 'git status --porcelain'
            ? this.dirty.map((path) => `?? ${path}\n`).join('')
            : command === LS_FILES
              ? [...this.files.keys()].map((path) => `${path}\n`).join('')
              : undefined;
      if (output === undefined) throw new Error(`unscripted: ${command}`);
      return Promise.resolve({ exitCode: 0, output, timedOut: false, truncated: false });
    },
    read: (_ref: unknown, path: string): Promise<string> => {
      const content = this.files.get(path);
      return content === undefined
        ? Promise.reject(new Error(`unreadable: ${path}`))
        : Promise.resolve(content);
    },
  } as unknown as SandboxPort;

  readonly store = {
    appendContextSkip: (_tx: unknown, _fence: unknown, skip: ContextSkip) => {
      this.skips.push(skip);
      return Promise.resolve();
    },
    getProjectContext: () => Promise.resolve(this.row),
    listMessages: () => Promise.resolve([...this.messages]),
    readRun: () => Promise.resolve(this.summary as AgentRun),
    setSummary: (
      _tx: unknown,
      _fence: unknown,
      update: { summary: string; throughMessageId: string; tokens: number },
    ) => {
      this.summary = {
        summary: update.summary,
        summaryThroughMessageId: update.throughMessageId,
        summaryTokens: update.tokens,
      };
      return Promise.resolve();
    },
    upsertProjectContext: (_tx: unknown, row: ProjectContext) => {
      this.upserts += 1;
      this.row = { ...row, createdAt: AT, updatedAt: AT };
      return Promise.resolve();
    },
  } as unknown as RunStore;

  assembler(): ContextAssembler {
    return new ContextAssembler(this.port, this.store, this.provider, {
      ...DEFAULT_AGENT_TIMINGS,
      summaryMs: 1000,
    });
  }

  lsFilesCalls(): number {
    return this.execs.filter((command) => command === LS_FILES).length;
  }
}

async function mapOf(assembler: ContextAssembler, s: AttemptScope): Promise<string> {
  return (await assembler.request(s, [])).context.map;
}

describe('ContextAssembler map (T017)', () => {
  it('serves the stored map without an ls-files call when the tree state matches', async () => {
    const world = new FakeWorld();
    const s = scope();
    world.row = {
      createdAt: AT,
      dirtyDigest: porcelainDigest(''),
      headSha: HEAD,
      orgId: 'org_1',
      projectId: 'proj_1',
      repoMap: 'stored.ts  · exports: stored',
      updatedAt: AT,
    };
    const assembler = world.assembler();

    await assembler.prepare(s);

    expect(world.lsFilesCalls()).toBe(0);
    expect(world.upserts).toBe(0);
    expect(await mapOf(assembler, s)).toBe('stored.ts  · exports: stored');
  });

  it('rebuilds the map after a round that changed the tree and not after a read-only round', async () => {
    const world = new FakeWorld();
    const s = scope();
    world.files.set('a.ts', 'export const a = 1;');
    const assembler = world.assembler();
    await assembler.prepare(s);
    expect(await mapOf(assembler, s)).toBe('a.ts  · exports: a');
    expect(world.upserts).toBe(1);

    // A read-only round: no git call, no store write.
    const execsBefore = world.execs.length;
    await assembler.afterTools(s, ['fs_read']);
    expect(world.execs.length).toBe(execsBefore);
    expect(world.upserts).toBe(1);

    // An fs_edit round that added a file: rebuilt and stored, keyed by the new digest.
    world.files.set('b.ts', 'export function b() {}');
    world.dirty = ['b.ts'];
    await assembler.afterTools(s, ['fs_edit']);
    expect(world.lsFilesCalls()).toBe(2);
    expect(world.upserts).toBe(2);
    expect(await mapOf(assembler, s)).toBe('a.ts  · exports: a\nb.ts  · exports: b');
    expect(world.row?.dirtyDigest).toBe(porcelainDigest('?? b.ts\n'));

    // An fs_edit round that changed nothing: status ran, nothing rebuilt.
    await assembler.afterTools(s, ['fs_edit']);
    expect(world.lsFilesCalls()).toBe(2);
    expect(world.upserts).toBe(2);
  });

  it('rebuilds after an exec-only change (SC-007)', async () => {
    const world = new FakeWorld();
    const s = scope();
    world.files.set('a.ts', 'export const a = 1;');
    const assembler = world.assembler();
    await assembler.prepare(s);

    world.files.set('generated.js', 'module.exports = {}');
    world.dirty = ['generated.js'];
    await assembler.afterTools(s, ['exec']);

    expect(await mapOf(assembler, s)).toBe('a.ts  · exports: a\ngenerated.js');
  });

  it('lists an unparseable source file by path with no exports', async () => {
    const world = new FakeWorld();
    const s = scope();
    world.files.set('ok.ts', 'export const ok = 1;');
    world.files.set('src/broken.ts', 'export const ok = 1;');
    // The read of this path fails; the file stays on the map, export-less.
    const read = world.port.read.bind(world.port);
    (world.port as { read: SandboxPort['read'] }).read = (ref, path) =>
      path === 'src/broken.ts' ? Promise.reject(new Error('binary')) : read(ref, path);
    const assembler = world.assembler();

    await assembler.prepare(s);

    expect(await mapOf(assembler, s)).toBe('ok.ts  · exports: ok\nsrc/\n  broken.ts');
  });

  it('a resumed attempt reads the tree as it is now', async () => {
    const world = new FakeWorld();
    const s = scope();
    world.files.set('a.ts', 'export const a = 1;');
    await world.assembler().prepare(s);
    expect(world.row?.repoMap).toBe('a.ts  · exports: a');

    // The dead attempt's exec left a file behind; the next attempt's prepare sees it.
    world.files.set('made-by-exec.ts', 'export const made = 1;');
    world.dirty = ['made-by-exec.ts'];
    const resumed = world.assembler();
    await resumed.prepare(s);

    expect(world.lsFilesCalls()).toBe(2);
    expect(await mapOf(resumed, s)).toBe('a.ts  · exports: a\nmade-by-exec.ts  · exports: made');
  });

  it('a failing git command serves the last map and fails no run', async () => {
    const world = new FakeWorld();
    const s = scope();
    world.row = {
      createdAt: AT,
      dirtyDigest: porcelainDigest(''),
      headSha: HEAD,
      orgId: 'org_1',
      projectId: 'proj_1',
      repoMap: 'last.ts  · exports: last',
      updatedAt: AT,
    };
    world.failing.add('git rev-parse HEAD');
    const assembler = world.assembler();

    await expect(assembler.prepare(s)).resolves.toBeUndefined();
    expect(await mapOf(assembler, s)).toBe('last.ts  · exports: last');
    expect(world.upserts).toBe(0);

    // With nothing stored either, the empty notice — still no throw.
    world.row = undefined;
    const bare = world.assembler();
    await expect(bare.prepare(s)).resolves.toBeUndefined();
    expect(await mapOf(bare, s)).toBe('(no files in the workspace)');

    // A status failure after a tool round is as harmless.
    world.failing.add('git status --porcelain');
    await expect(assembler.afterTools(s, ['exec'])).resolves.toBeUndefined();
    expect(await mapOf(assembler, s)).toBe('last.ts  · exports: last');
  });
});

describe('ContextAssembler', () => {
  it('lays out system → tools → map → excerpts → conversation and puts nothing run-specific before the excerpts', async () => {
    const conversation: ConversationMessage[] = [
      { content: `${USER_ID} asks at ${AT.toISOString()}: fix the bug`, role: 'user' },
    ];

    const request = await new FakeWorld().assembler().request(scope(), conversation);

    // The two cached blocks, byte-for-byte what the prompt file exports and no map yet (T017).
    expect(request.system).toBe(SYSTEM_PROMPT);
    expect(request.context.excerpts).toBe('');
    // Nothing run-specific before the conversation: no run id, user id or timestamp.
    for (const block of [request.system, request.context.map]) {
      expect(block).not.toContain(RUN_ID);
      expect(block).not.toContain(USER_ID);
      expect(block).not.toContain(AT.toISOString());
      expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
    // The conversation is the run's own, untouched, and the shape is exactly the three parts.
    expect(request).toEqual({
      context: { excerpts: '', map: '' },
      messages: conversation,
      system: SYSTEM_PROMPT,
    });
  });
});

describe('ContextAssembler summary (T021)', () => {
  it('persists the summary before the call so a resumed attempt reads it', async () => {
    const world = new FakeWorld();
    world.provider.script({ text: 'decisions 1-4' });
    world.messages = turns(10);
    const first = scope(world.messages);
    const assembler = world.assembler();
    await assembler.prepare(first);

    const sent = await assembler.request(first, toMessages(world.messages));

    // The row holds the summary and its marker when `request` answers — before the model call.
    expect(world.summary).toEqual({
      summary: 'decisions 1-4',
      summaryThroughMessageId: 't4',
      summaryTokens: expect.any(Number) as number,
    });
    expect(sent.messages).toEqual([
      { content: 'Summary of the conversation so far:\ndecisions 1-4', role: 'user' },
      ...toMessages(world.messages.slice(9)),
    ]);
    expect(world.skips).toEqual([]);
    expect(world.provider.calls).toHaveLength(1);

    // A resumed attempt: a fresh scope and assembler read the stored summary and send it as is,
    // with the same tail and no summary call.
    const resumed = world.assembler();
    const second = scope(world.messages);
    await resumed.prepare(second);
    const again = await resumed.request(second, toMessages(world.messages));
    expect(again.messages).toEqual(sent.messages);
    expect(world.provider.calls).toHaveLength(1);
  });
});
