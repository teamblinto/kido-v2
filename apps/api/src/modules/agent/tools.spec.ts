import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DaytonaError } from '../sandbox/sandbox.errors';
import type {
  ContentMatch,
  Edit,
  EditResult,
  ExecResult,
  FileEntry,
  MutationContext,
  PreviewStatus,
  SandboxPort,
  SandboxRef,
} from '../sandbox/sandbox.port';
import { ToolBroker } from './tool-broker';
import { TOOLS, type ToolName } from './tools';

const REF: SandboxRef = { orgId: 'org_1', projectId: 'proj_1' };
const CTX: MutationContext = { leaseEpoch: 1, operationId: 'run_1/step_1' };

interface Call {
  method: string;
  args: unknown[];
}

/** Record-and-answer fake: each method records its call and returns the queued answer. */
class FakePort implements SandboxPort {
  readonly calls: Call[] = [];
  private readonly answers = new Map<string, unknown>();

  setAnswer(method: string, value: unknown): void {
    this.answers.set(method, value);
  }

  private answer<T>(method: string, args: unknown[]): Promise<T> {
    this.calls.push({ args, method });
    const value = this.answers.get(method);
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value as T);
  }

  read(ref: SandboxRef, path: string, ctx?: MutationContext): Promise<string> {
    return this.answer('read', [ref, path, ctx]);
  }

  upload(ref: SandboxRef, path: string, body: Buffer, ctx: MutationContext): Promise<void> {
    return this.answer('upload', [ref, path, body, ctx]);
  }

  download(ref: SandboxRef, path: string, ctx: MutationContext): Promise<Buffer> {
    return this.answer('download', [ref, path, ctx]);
  }

  list(ref: SandboxRef, path: string, ctx?: MutationContext): Promise<readonly FileEntry[]> {
    return this.answer('list', [ref, path, ctx]);
  }

  edit(ref: SandboxRef, edit: Edit, ctx: MutationContext): Promise<EditResult> {
    return this.answer('edit', [ref, edit, ctx]);
  }

  exec(ref: SandboxRef, command: string, ctx: MutationContext): Promise<ExecResult> {
    return this.answer('exec', [ref, command, ctx]);
  }

  search(
    ref: SandboxRef,
    query: { readonly text: string; readonly path?: string },
    ctx?: MutationContext,
  ): Promise<readonly ContentMatch[]> {
    return this.answer('search', [ref, query, ctx]);
  }

  find(
    ref: SandboxRef,
    query: { readonly glob: string; readonly path?: string },
    ctx?: MutationContext,
  ): Promise<readonly string[]> {
    return this.answer('find', [ref, query, ctx]);
  }

  previewStatus(ref: SandboxRef, ctx?: MutationContext): Promise<PreviewStatus> {
    return this.answer('previewStatus', [ref, ctx]);
  }
}

function fakePort(): FakePort {
  return new FakePort();
}

function spec(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

describe('TOOLS', () => {
  it('is the seven tools in fixed order', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'fs_read',
      'fs_list',
      'fs_edit',
      'exec',
      'search',
      'find',
      'preview_status',
    ]);
  });

  it('offers no domain tool and none reaches DomainService (spec 028 FR-030)', () => {
    for (const tool of TOOLS) expect(tool.name).not.toMatch(/domain/i);

    // A tool's only reach is the `SandboxPort` its `call` is handed: the tool and broker modules
    // import nothing from the deploy module, so no domain service or repository is in scope.
    for (const file of ['tools.ts', 'tool-broker.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map(([, from]) => from);
      expect(imports.filter((from) => /deploy|domain/i.test(from!))).toEqual([]);
      expect(source).not.toMatch(/DomainService/);
    }
  });

  it('offers no webhook tool and none reaches EndpointService or SafeTransport (spec 029)', () => {
    for (const tool of TOOLS) expect(tool.name).not.toMatch(/webhook/i);

    // Endpoints must never be creatable, and no outbound request sendable, from inside a sandbox:
    // the tool and broker modules import nothing from the webhooks module.
    for (const file of ['tools.ts', 'tool-broker.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map(([, from]) => from);
      expect(imports.filter((from) => /webhook|transport/i.test(from!))).toEqual([]);
      expect(source).not.toMatch(/EndpointService|SafeTransport/);
    }
  });

  describe('fs_read', () => {
    it('calls read and returns the text', async () => {
      const port = fakePort();
      port.setAnswer('read', 'file contents');
      const outcome = await spec('fs_read').call(port, REF, { path: 'a.ts' }, CTX);
      expect(port.calls).toEqual([{ method: 'read', args: [REF, 'a.ts', CTX] }]);
      expect(outcome).toEqual({ output: 'file contents' });
    });
  });

  describe('fs_list', () => {
    it('formats kind, name and size per line', async () => {
      const port = fakePort();
      const entries: FileEntry[] = [
        { kind: 'file', name: 'a.ts', size: 12 },
        { kind: 'directory', name: 'sub', size: 0 },
        { kind: 'link', name: 'l', size: 3 },
      ];
      port.setAnswer('list', entries);
      const outcome = await spec('fs_list').call(port, REF, { path: '.' }, CTX);
      expect(outcome).toEqual({
        output: 'file\ta.ts\t12\ndirectory\tsub\t0\nlink\tl\t3',
      });
    });
  });

  describe('fs_edit', () => {
    it('returns the diff and a patch when it changed the file', async () => {
      const port = fakePort();
      const result: EditResult = { diff: '--- a/x\n+++ b/x\n@@\n-a\n+b\n', bytes: 1 };
      port.setAnswer('edit', result);
      const input: Edit = { content: 'b', path: 'x' };
      const outcome = await spec('fs_edit').call(port, REF, input, CTX);
      expect(port.calls).toEqual([{ method: 'edit', args: [REF, input, CTX] }]);
      expect(outcome).toEqual({ output: result.diff, patch: { diff: result.diff, path: 'x' } });
    });

    it('returns "no change" and no patch when the diff is empty', async () => {
      const port = fakePort();
      const result: EditResult = { diff: '', bytes: 1 };
      port.setAnswer('edit', result);
      const input: Edit = { path: 'x', replace: 'b', search: 'a' };
      const outcome = await spec('fs_edit').call(port, REF, input, CTX);
      expect(outcome).toEqual({ output: 'no change' });
    });

    it('accepts exactly one of the two shapes', () => {
      const parsed1 = spec('fs_edit').input.safeParse({ content: 'x', path: 'a' });
      const parsed2 = spec('fs_edit').input.safeParse({ path: 'a', replace: 'y', search: 'x' });
      expect(parsed1.success).toBe(true);
      expect(parsed2.success).toBe(true);
      const mixed = spec('fs_edit').input.safeParse({
        content: 'x',
        path: 'a',
        replace: 'y',
        search: 'x',
      });
      expect(mixed.success).toBe(false);
      const neither = spec('fs_edit').input.safeParse({ path: 'a' });
      expect(neither.success).toBe(false);
    });
  });

  describe('exec', () => {
    it('formats exit code, output and the truncation marker', async () => {
      const port = fakePort();
      const result: ExecResult = {
        exitCode: 1,
        output: 'boom',
        timedOut: false,
        truncated: true,
      };
      port.setAnswer('exec', result);
      const outcome = await spec('exec').call(port, REF, { command: 'ls' }, CTX);
      expect(port.calls).toEqual([{ method: 'exec', args: [REF, 'ls', CTX] }]);
      expect(outcome).toEqual({ output: 'exit 1\nboom\n[output truncated]' });
    });

    it('reports a timeout with no output', async () => {
      const port = fakePort();
      const result: ExecResult = { output: '', timedOut: true, truncated: false };
      port.setAnswer('exec', result);
      const outcome = await spec('exec').call(port, REF, { command: 'sleep 999' }, CTX);
      expect(outcome).toEqual({ output: 'timed out after 120 s' });
    });
  });

  describe('search', () => {
    it('formats path:line: text', async () => {
      const port = fakePort();
      const matches: ContentMatch[] = [
        { line: 3, path: 'a.ts', text: 'const x = 1' },
        { line: 10, path: 'b.ts', text: 'const y = 2' },
      ];
      port.setAnswer('search', matches);
      const outcome = await spec('search').call(port, REF, { text: 'const' }, CTX);
      expect(port.calls).toEqual([
        { method: 'search', args: [REF, { path: undefined, text: 'const' }, CTX] },
      ]);
      expect(outcome).toEqual({ output: 'a.ts:3: const x = 1\nb.ts:10: const y = 2' });
    });

    it('reports "no matches"', async () => {
      const port = fakePort();
      port.setAnswer('search', []);
      const outcome = await spec('search').call(port, REF, { text: 'nope' }, CTX);
      expect(outcome).toEqual({ output: 'no matches' });
    });
  });

  describe('find', () => {
    it('lists paths', async () => {
      const port = fakePort();
      port.setAnswer('find', ['a.ts', 'b.ts']);
      const outcome = await spec('find').call(port, REF, { glob: '*.ts' }, CTX);
      expect(port.calls).toEqual([
        { method: 'find', args: [REF, { glob: '*.ts', path: undefined }, CTX] },
      ]);
      expect(outcome).toEqual({ output: 'a.ts\nb.ts' });
    });

    it('reports "no matches"', async () => {
      const port = fakePort();
      port.setAnswer('find', []);
      const outcome = await spec('find').call(port, REF, { glob: '*.md' }, CTX);
      expect(outcome).toEqual({ output: 'no matches' });
    });
  });

  /** Spec 023 US4, contracts/preview-status-tool.md § 3: one line, and it is the whole answer. */
  describe('preview_status', () => {
    const answer = async (status: PreviewStatus) => {
      const port = fakePort();
      port.setAnswer('previewStatus', status);
      const outcome = await spec('preview_status').call(port, REF, {}, CTX);
      expect(port.calls).toEqual([{ method: 'previewStatus', args: [REF, CTX] }]);
      return outcome;
    };

    it('says a project has no preview port when the template declares none', async () => {
      expect(await answer({ port: null })).toEqual({ output: 'this project has no preview port' });
    });

    it('says a declared port is not observed yet, which is an answer and not a failure', async () => {
      expect(await answer({ observed: null, port: 3000 })).toEqual({
        output: 'port 3000: not observed yet',
      });
    });

    it('says the observed state and the time it was observed', async () => {
      expect(
        await answer({
          observed: { at: '2026-09-22T14:03:11.492Z', state: 'listening' },
          port: 3000,
        }),
      ).toEqual({ output: 'port 3000: listening (observed 2026-09-22T14:03:11.492Z)' });
    });

    it('is an ok BrokerResult for all three, never a failure (FR-021)', async () => {
      const cases: readonly (readonly [PreviewStatus, string])[] = [
        [{ port: null }, 'this project has no preview port'],
        [{ observed: null, port: 3000 }, 'port 3000: not observed yet'],
        [
          { observed: { at: '2026-09-22T14:03:11.492Z', state: 'failed' }, port: 3000 },
          'port 3000: failed (observed 2026-09-22T14:03:11.492Z)',
        ],
      ];

      for (const [status, output] of cases) {
        const port = fakePort();
        port.setAnswer('previewStatus', status);
        const broker = new ToolBroker(TOOLS, new Set<ToolName>(['preview_status']), port, REF);

        // Even `failed` is a `preview_status` that succeeded: the dev server failed, not the call.
        await expect(
          broker.handle({ input: {}, name: 'preview_status' }, CTX, (fn) => fn()),
        ).resolves.toEqual({ ok: true, output });
      }
    });

    it('carries no provider identity, node, internal address or preview label (FR-024)', async () => {
      // Anchored end to end: a sandbox id, a node, an upstream address or a preview label
      // appended anywhere in the line breaks the match, whatever it is called.
      const shapes: readonly (readonly [PreviewStatus, RegExp])[] = [
        [{ port: null }, /^this project has no preview port$/],
        [{ observed: null, port: 3000 }, /^port \d+: not observed yet$/],
        [
          { observed: { at: '2026-09-22T14:03:11.492Z', state: 'listening' }, port: 3000 },
          /^port \d+: (?:starting|listening|failed) \(observed [\d-]{10}T[\d:.]+Z\)$/,
        ],
      ];

      for (const [status, shape] of shapes) {
        const { output } = await answer(status);
        expect(output).toMatch(shape);
      }
    });

    it('takes no input at all: any field fails the schema', () => {
      expect(spec('preview_status').input.safeParse({}).success).toBe(true);
      expect(spec('preview_status').input.safeParse({ port: 3000 }).success).toBe(false);
    });
  });

  it('every input schema is strict: an undeclared field fails', () => {
    expect(spec('fs_read').input.safeParse({ extra: 1, path: 'a' }).success).toBe(false);
    expect(spec('fs_list').input.safeParse({ extra: 1, path: 'a' }).success).toBe(false);
    expect(spec('fs_edit').input.safeParse({ content: 'x', extra: 1, path: 'a' }).success).toBe(
      false,
    );
    expect(
      spec('fs_edit').input.safeParse({ extra: 1, path: 'a', replace: 'b', search: 'a' }).success,
    ).toBe(false);
    expect(spec('exec').input.safeParse({ command: 'ls', extra: 1 }).success).toBe(false);
    expect(spec('search').input.safeParse({ extra: 1, text: 'a' }).success).toBe(false);
    expect(spec('find').input.safeParse({ extra: 1, glob: '*' }).success).toBe(false);
  });

  it('propagates a DaytonaError from the port', async () => {
    const port = fakePort();
    port.setAnswer('read', new DaytonaError('unreachable', 'nope'));
    await expect(spec('fs_read').call(port, REF, { path: 'a' }, CTX)).rejects.toThrow(DaytonaError);
  });
});
