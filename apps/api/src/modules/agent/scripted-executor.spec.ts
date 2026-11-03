import { describe, expect, it } from 'vitest';

import type { EmittedEvent, ExecutionContext, RunOutcome, RunSnapshot } from './run-executor.port';
import { DEFAULT_SCRIPT, parseScript, ScriptedExecutor, type Step } from './scripted-executor';

const RUN = 'a2b6c3f1-0000-4000-8000-000000000001';

function snapshot(prompt: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    committed: { openStepId: null, pauses: 0, toolEnds: 0 },
    epoch: 1,
    userId: 'a2b6c3f1-0000-4000-8000-0000000000a1',
    id: RUN,
    lastSeq: 1,
    messages: [
      {
        at: new Date(0),
        content: prompt,
        createdAt: new Date(0),
        id: 'm1',
        orgId: 'org',
        role: 'user',
        runId: RUN,
        toolCalls: [],
        updatedAt: new Date(0),
      },
    ],
    model: 'fake',
    orgId: 'org',
    projectId: 'project',
    status: 'starting',
    ...overrides,
  };
}

/** A context that records what was emitted and answers `cancelled()` from a script of its own. */
function context(
  run: RunSnapshot,
  options: { cancelledAfter?: number; controller?: AbortController } = {},
) {
  const emitted: EmittedEvent[] = [];
  const controller = options.controller ?? new AbortController();
  let polls = 0;
  const value: ExecutionContext = {
    cancelled: () => {
      polls += 1;

      return Promise.resolve(
        options.cancelledAfter !== undefined && polls > options.cancelledAfter,
      );
    },
    dispatch: (fn) => fn(),
    flush: () => Promise.resolve(),
    emit: (event) => {
      emitted.push(event);

      return Promise.resolve();
    },
    persist: () => Promise.resolve(),
    run,
    signal: controller.signal,
  };

  return { context: value, controller, emitted, polls: () => polls };
}

function script(steps: Step[]): string {
  return JSON.stringify({ script: steps });
}

describe('parseScript', () => {
  it('parses every step kind of the grammar', () => {
    const steps: Step[] = [
      { kind: 'tool' },
      { kind: 'tool', ok: false },
      { kind: 'patch', path: 'src/x.ts' },
      { kind: 'token', text: 'hi' },
      { input: 3, kind: 'usage', output: 4 },
      { kind: 'sleep', ms: 10 },
      { kind: 'stall' },
      { kind: 'await-input' },
      { kind: 'pause', reason: 'quota' },
      { failureClass: 'executor', kind: 'fail', reason: 'boom' },
      { kind: 'succeed' },
    ];

    expect(parseScript(script(steps))).toEqual(steps);
  });

  it.each([
    ['plain prose', 'build me a todo app'],
    ['JSON without a script', JSON.stringify({ prompt: 'x' })],
    ['a script that is not an array', JSON.stringify({ script: 'tool' })],
    ['an unknown step kind', script([{ kind: 'explode' } as unknown as Step])],
    ['a sleep with no ms', JSON.stringify({ script: [{ kind: 'sleep' }] })],
    ['a fail with no class', JSON.stringify({ script: [{ kind: 'fail' }] })],
  ])('falls back to the default script on %s', (_label, prompt) => {
    expect(parseScript(prompt)).toBe(DEFAULT_SCRIPT);
  });
});

describe('ScriptedExecutor', () => {
  const executor = new ScriptedExecutor();

  it('runs the default script: three tool pairs, a patch, a usage, then succeeded', async () => {
    const { context: ctx, emitted } = context(snapshot('build me a todo app'));

    await expect(executor.execute(ctx)).resolves.toEqual({ kind: 'succeeded' });

    expect(emitted.map((event) => event.type)).toEqual([
      'tool.start',
      'tool.delta',
      'tool.end',
      'tool.start',
      'tool.delta',
      'tool.end',
      'tool.start',
      'tool.delta',
      'tool.end',
      'file.patch',
      'usage',
    ]);
    expect(emitted[0]!.data).toMatchObject({ stepId: `${RUN}/0`, tool: 'scripted' });
    expect(emitted[2]!.data).toEqual({ ok: true, output: { step: 0 }, stepId: `${RUN}/0` });
    expect(emitted[3]!.data).toMatchObject({ stepId: `${RUN}/1` });
  });

  it('emits a failed tool.end for ok:false, with an error and no output', async () => {
    const { context: ctx, emitted } = context(snapshot(script([{ kind: 'tool', ok: false }])));

    await executor.execute(ctx);

    expect(emitted[2]).toEqual({
      data: { error: 'scripted failure at step 0', ok: false, stepId: `${RUN}/0` },
      type: 'tool.end',
    });
  });

  it.each<[Step, RunOutcome]>([
    [{ kind: 'await-input' }, { kind: 'awaiting_input' }],
    [
      { kind: 'pause', reason: 'quota' },
      { kind: 'paused', reason: 'quota' },
    ],
    [
      { failureClass: 'executor', kind: 'fail', reason: 'boom' },
      { failureClass: 'executor', kind: 'failed', reason: 'boom' },
    ],
    [
      { failureClass: 'internal', kind: 'fail' },
      { failureClass: 'internal', kind: 'failed', reason: 'scripted failure at step 0' },
    ],
    [{ kind: 'succeed' }, { kind: 'succeeded' }],
  ])('returns the outcome of %o and stops there', async (step, outcome) => {
    const { context: ctx, emitted } = context(snapshot(script([step, { kind: 'tool' }])));

    await expect(executor.execute(ctx)).resolves.toEqual(outcome);

    expect(emitted).toEqual([]);
  });

  it('honours usage and patch parameters', async () => {
    const { context: ctx, emitted } = context(
      snapshot(
        script([
          { kind: 'patch', path: 'README.md' },
          { input: 7, kind: 'usage', output: 9 },
        ]),
      ),
    );

    await executor.execute(ctx);

    expect(emitted[0]).toMatchObject({ data: { path: 'README.md' }, type: 'file.patch' });
    expect(emitted[1]).toMatchObject({
      data: { costMicros: 7 * 3 + 9 * 15, inputTokens: 7, outputTokens: 9 },
      type: 'usage',
    });
  });

  it('emits one token per token step, defaulting the text', async () => {
    const { context: ctx, emitted } = context(
      snapshot(script([{ kind: 'token', text: 'hi' }, { kind: 'token' }])),
    );

    await executor.execute(ctx);

    expect(emitted).toEqual([
      { data: { text: 'hi' }, type: 'token' },
      { data: { text: 'tok' }, type: 'token' },
    ]);
  });

  it('checks cancelled() between steps and returns stopped', async () => {
    const steps: Step[] = [{ kind: 'tool' }, { kind: 'tool' }, { kind: 'tool' }];
    const {
      context: ctx,
      emitted,
      polls,
    } = context(snapshot(script(steps)), {
      cancelledAfter: 1,
    });

    await expect(executor.execute(ctx)).resolves.toEqual({ kind: 'stopped' });

    // Polled before step 0 (false) and before step 1 (true): one tool ran, one poll per boundary.
    expect(emitted.filter((event) => event.type === 'tool.end')).toHaveLength(1);
    expect(polls()).toBe(2);
  });

  describe('resume (US2, contracts/executor-port.md § Resume rule)', () => {
    const six: Step[] = Array.from({ length: 6 }, () => ({ kind: 'tool' }));

    it('skips as many tool steps as tool.end rows are committed', async () => {
      const { context: ctx, emitted } = context(
        snapshot(script(six), {
          committed: { openStepId: null, pauses: 0, toolEnds: 4 },
          status: 'running',
        }),
      );

      await expect(executor.execute(ctx)).resolves.toEqual({ kind: 'succeeded' });

      expect(emitted.map((event) => event.type)).toEqual([
        'tool.start',
        'tool.delta',
        'tool.end',
        'tool.start',
        'tool.delta',
        'tool.end',
      ]);
      expect(emitted[0]!.data).toMatchObject({ stepId: `${RUN}/4` });
      expect(emitted[3]!.data).toMatchObject({ stepId: `${RUN}/5` });
    });

    it('marks the step it redoes with a usage event naming the open step (FR-019)', async () => {
      const { context: ctx, emitted } = context(
        snapshot(script(six), {
          committed: { openStepId: `${RUN}/2`, pauses: 0, toolEnds: 2 },
          status: 'running',
        }),
      );

      await executor.execute(ctx);

      expect(emitted[0]).toEqual({
        data: { costMicros: 0, duplicateOf: `${RUN}/2`, inputTokens: 0, outputTokens: 0 },
        type: 'usage',
      });
      expect(emitted[1]).toMatchObject({ data: { stepId: `${RUN}/2` }, type: 'tool.start' });
      expect(emitted.filter((event) => event.type === 'tool.end')).toHaveLength(4);
    });

    it('skips the steps before the last committed tool, whatever their kind', async () => {
      const { context: ctx, emitted } = context(
        snapshot(
          script([{ kind: 'patch' }, { kind: 'tool' }, { kind: 'usage' }, { kind: 'tool' }]),
          {
            committed: { openStepId: null, pauses: 0, toolEnds: 1 },
            status: 'running',
          },
        ),
      );

      await executor.execute(ctx);

      expect(emitted.map((event) => event.type)).toEqual([
        'usage',
        'tool.start',
        'tool.delta',
        'tool.end',
      ]);
    });

    it('skips one await-input per user message beyond the prompt, and the tools before it', async () => {
      const run = snapshot(script([{ kind: 'tool' }, { kind: 'await-input' }, { kind: 'tool' }]), {
        committed: { openStepId: null, pauses: 0, toolEnds: 1 },
        status: 'starting',
      });
      const { context: ctx, emitted } = context({
        ...run,
        messages: [...run.messages, { ...run.messages[0]!, content: 'go on', id: 'm2' }],
      });

      await expect(executor.execute(ctx)).resolves.toEqual({ kind: 'succeeded' });

      expect(emitted.map((event) => event.type)).toEqual(['tool.start', 'tool.delta', 'tool.end']);
      expect(emitted[0]!.data).toMatchObject({ stepId: `${RUN}/2` });
    });

    it('waits for input again when the stall came before the input arrived', async () => {
      const { context: ctx, emitted } = context(
        snapshot(script([{ kind: 'tool' }, { kind: 'await-input' }, { kind: 'tool' }]), {
          committed: { openStepId: null, pauses: 0, toolEnds: 1 },
          status: 'running',
        }),
      );

      await expect(executor.execute(ctx)).resolves.toEqual({ kind: 'awaiting_input' });

      expect(emitted).toEqual([]);
    });

    it('skips one pause per paused state committed, and the tools before it (US4)', async () => {
      const { context: ctx, emitted } = context(
        snapshot(script([{ kind: 'tool' }, { kind: 'pause', reason: 'quota' }, { kind: 'tool' }]), {
          committed: { openStepId: null, pauses: 1, toolEnds: 1 },
          status: 'starting',
        }),
      );

      await expect(executor.execute(ctx)).resolves.toEqual({ kind: 'succeeded' });

      expect(emitted.map((event) => event.type)).toEqual(['tool.start', 'tool.delta', 'tool.end']);
      expect(emitted[0]!.data).toMatchObject({ stepId: `${RUN}/2` });
    });

    it('starts from the top on a fresh run, and after a stall that committed nothing', async () => {
      const { context: ctx, emitted } = context(snapshot(script(six), { status: 'running' }));

      await executor.execute(ctx);

      expect(emitted.filter((event) => event.type === 'tool.end')).toHaveLength(6);
      expect(emitted.some((event) => event.type === 'usage')).toBe(false);
    });
  });

  it('sleeps for the scripted time', async () => {
    const { context: ctx } = context(snapshot(script([{ kind: 'sleep', ms: 30 }])));
    const before = performance.now();

    await executor.execute(ctx);

    expect(performance.now() - before).toBeGreaterThanOrEqual(25);
  });

  it.each<Step>([{ kind: 'sleep', ms: 60_000 }, { kind: 'stall' }])(
    'aborts %o through the signal and rejects with its reason',
    async (step) => {
      const controller = new AbortController();
      const { context: ctx } = context(snapshot(script([step, { kind: 'tool' }])), {
        controller,
      });
      const running = executor.execute(ctx);

      setTimeout(() => controller.abort(new Error('fenced')), 10);

      await expect(running).rejects.toThrow('fenced');
    },
  );
});
