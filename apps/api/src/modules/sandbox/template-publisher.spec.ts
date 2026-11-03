import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { Environment } from '../../config/environment';
import type { DaytonaAdapter } from './daytona.adapter';
import { DEFAULT_SANDBOX_TIMINGS, poolFrontKey, type SandboxTimings } from './sandbox.constants';
import { TemplateCatalogue } from './template-catalogue';
import { TemplatePublisher } from './template-publisher';
import type { BeginOutcome, TemplateVersions } from './template-versions';

const FIXTURES = path.join(__dirname, '../../../test/fixtures/templates/good');
const NOW = '2026-09-17T10:00:00.000Z';
const TEMPLATE = 'nextjs';
const BUILD_ID = 'sandbox-build-1';
const ROOT = '/home/daytona';
/** Milliseconds: the polls spin, the bound is far enough for a scripted build and near for the timeout case. */
const TIMINGS: SandboxTimings = {
  ...DEFAULT_SANDBOX_TIMINGS,
  buildTimeoutMs: 2_000,
  readyPollMs: 1,
  snapshotPollMs: 1,
};

type Fake = { [K in keyof DaytonaAdapter]: Mock };

/**
 * The publisher over a scripted adapter and mocked versions (spec 015, contract § 3): the fake
 * sandbox reaches `started` on the second `describe`, `stopped` on the second after the stop,
 * and the snapshot is `null` once (the post-POST window of research R1) then `active`.
 */
function fakeDaytona(): Fake {
  const sandboxStates = ['creating', 'started'];
  // The first `describeSnapshot` is the adoption probe (nothing there); the poll then sees `active`.
  let probes = 0;
  return {
    create: vi.fn(() =>
      Promise.resolve({ id: BUILD_ID, state: 'creating', toolboxProxyUrl: 'http://x' }),
    ),
    describe: vi.fn(() =>
      Promise.resolve({ id: BUILD_ID, state: sandboxStates.shift() ?? 'started' }),
    ),
    describeSnapshot: vi.fn(() =>
      Promise.resolve(probes++ === 0 ? null : { errorReason: null, state: 'active' }),
    ),
    execute: vi.fn(() =>
      Promise.resolve({ exitCode: 0, result: 'added 1 package\n', timedOut: false }),
    ),
    remove: vi.fn(() => Promise.resolve()),
    snapshotSandbox: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => {
      sandboxStates.push('stopping', 'stopped');
      return Promise.resolve();
    }),
    upload: vi.fn(() => Promise.resolve()),
    workDir: vi.fn(() => Promise.resolve(ROOT)),
  } as unknown as Fake;
}

describe('TemplatePublisher', () => {
  const catalogue = new TemplateCatalogue(FIXTURES);
  const def = catalogue.get(TEMPLATE);
  const config = {
    get: () => 'forge-test',
  } as unknown as ConfigService<Environment, true>;
  let daytona: Fake;
  let versions: Record<'begin' | 'ready' | 'fail', Mock>;
  let queue: { del: Mock };
  let publisher: TemplatePublisher;
  let warn: Mock;

  const publish = () => publisher.publish(TEMPLATE);
  const begins = (outcome: BeginOutcome) => versions.begin.mockResolvedValue(outcome);

  beforeEach(() => {
    daytona = fakeDaytona();
    versions = { begin: vi.fn(), fail: vi.fn(), ready: vi.fn() };
    queue = { del: vi.fn(() => Promise.resolve(1)) };
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined) as Mock;
    publisher = new TemplatePublisher(
      catalogue,
      versions as unknown as TemplateVersions,
      daytona as unknown as DaytonaAdapter,
      queue as never,
      new FakeClock(NOW),
      TIMINGS,
      config,
    );
    begins('reserved');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reserved → create, upload, install, stop, capture → built, ready, DEL front', async () => {
    expect(await publish()).toEqual({ kind: 'built' });

    expect(versions.begin).toHaveBeenCalledWith(
      def,
      new Date(NOW),
      new Date(new Date(NOW).getTime() - TIMINGS.buildTimeoutMs),
    );
    expect(daytona.create).toHaveBeenCalledWith({
      labels: { 'forge.kind': 'build', 'forge.owner': 'forge-test', 'forge.template': TEMPLATE },
      snapshot: def.manifest.base,
    });
    expect(daytona.upload.mock.calls).toEqual(
      def.files.map((file) => [BUILD_ID, path.posix.join(ROOT, file.path), file.content]),
    );
    expect(daytona.execute).toHaveBeenCalledWith(
      BUILD_ID,
      expect.objectContaining({ command: def.manifest.install, cwd: ROOT }),
    );
    expect(daytona.stop).toHaveBeenCalledWith(BUILD_ID);
    expect(daytona.snapshotSandbox).toHaveBeenCalledWith(BUILD_ID, def.snapshot);
    // Upload and install only once the sandbox is `started`; capture only once it is `stopped`.
    expect(daytona.describe.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(versions.ready).toHaveBeenCalledWith(def, new Date(NOW));
    expect(versions.fail).not.toHaveBeenCalled();
    expect(queue.del).toHaveBeenCalledWith(poolFrontKey(TEMPLATE));
    expect(daytona.remove).toHaveBeenCalledWith(BUILD_ID);
  });

  it('an active snapshot of the same name is adopted without a build', async () => {
    daytona.describeSnapshot.mockResolvedValueOnce({ errorReason: null, state: 'active' });

    expect(await publish()).toEqual({ kind: 'adopted' });

    expect(daytona.create).not.toHaveBeenCalled();
    expect(versions.ready).toHaveBeenCalledWith(def, new Date(NOW));
    expect(queue.del).toHaveBeenCalledWith(poolFrontKey(TEMPLATE));
  });

  it('a non-zero install exit fails the version with the output tail and still removes the sandbox', async () => {
    const output = `${'x'.repeat(3000)}npm ERR! missing script\n`;
    daytona.execute.mockResolvedValueOnce({ exitCode: 1, result: output, timedOut: false });

    const outcome = await publish();

    expect(outcome.kind).toBe('failed');
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toHaveLength(2048);
    expect(reason.endsWith('npm ERR! missing script\n')).toBe(true);
    expect(versions.fail).toHaveBeenCalledWith(def, reason, new Date(NOW));
    expect(versions.ready).not.toHaveBeenCalled();
    expect(queue.del).not.toHaveBeenCalled();
    expect(daytona.stop).not.toHaveBeenCalled();
    expect(daytona.snapshotSandbox).not.toHaveBeenCalled();
    expect(daytona.remove).toHaveBeenCalledWith(BUILD_ID);
  });

  it('a snapshot that lands build_failed fails the version with its errorReason', async () => {
    daytona.describeSnapshot
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ errorReason: 'runner out of disk', state: 'build_failed' });

    expect(await publish()).toEqual({ kind: 'failed', reason: 'runner out of disk' });

    expect(versions.fail).toHaveBeenCalledWith(def, 'runner out of disk', new Date(NOW));
    expect(versions.ready).not.toHaveBeenCalled();
    expect(daytona.remove).toHaveBeenCalledWith(BUILD_ID);
  });

  it('a build past buildTimeoutMs fails as a timeout and removes the sandbox', async () => {
    daytona.describe.mockResolvedValue({ id: BUILD_ID, state: 'creating' }); // never started
    publisher = new TemplatePublisher(
      catalogue,
      versions as unknown as TemplateVersions,
      daytona as unknown as DaytonaAdapter,
      queue as never,
      new FakeClock(NOW),
      { ...TIMINGS, buildTimeoutMs: 40 },
      config,
    );

    expect(await publish()).toEqual({ kind: 'failed', reason: 'timeout after 0.04s' });

    expect(versions.fail).toHaveBeenCalledWith(def, 'timeout after 0.04s', new Date(NOW));
    expect(daytona.upload).not.toHaveBeenCalled();
    expect(daytona.remove).toHaveBeenCalledWith(BUILD_ID);
  });

  it('formats the production bound as minutes', () => {
    expect(TemplatePublisher.timeoutReason(900_000)).toBe('timeout after 15m');
  });

  it.each<BeginOutcome>(['already-current', 'made-current', 'building-elsewhere'])(
    'begin → %s passes through without touching the provider',
    async (outcome) => {
      begins(outcome);

      expect(await publish()).toEqual({ kind: outcome });

      expect(daytona.describeSnapshot).not.toHaveBeenCalled();
      expect(daytona.create).not.toHaveBeenCalled();
      expect(versions.ready).not.toHaveBeenCalled();
      // The front is cleared only when the current version changed hands.
      expect(queue.del.mock.calls).toEqual(
        outcome === 'made-current' ? [[poolFrontKey(TEMPLATE)]] : [],
      );
    },
  );

  it('a remove that throws is logged, never thrown over the outcome', async () => {
    daytona.remove.mockRejectedValueOnce(new Error('provider down'));

    expect(await publish()).toEqual({ kind: 'built' });

    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining(`build sandbox ${BUILD_ID} not removed`),
    ]);
  });

  // Spec 041: an install longer than one HTTP exchange runs detached and is polled for its exit.
  it('runs an installInSession install in a daemon session and reads its exit code', async () => {
    const long = { ...def, manifest: { ...def.manifest, installInSession: true } };
    daytona.startSession = vi.fn(() => Promise.resolve());
    daytona.execute
      .mockResolvedValueOnce({ exitCode: 1, result: '', timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, result: '3\nnpm ERR! boom\n', timedOut: false });
    publisher = new TemplatePublisher(
      { get: () => long } as unknown as TemplateCatalogue,
      versions as unknown as TemplateVersions,
      daytona as unknown as DaytonaAdapter,
      queue as never,
      new FakeClock(NOW),
      TIMINGS,
      config,
    );

    expect(await publish()).toEqual({ kind: 'failed', reason: 'npm ERR! boom\n' });
    expect(daytona.startSession).toHaveBeenCalledWith(
      BUILD_ID,
      'forge-install',
      `cd ${ROOT} && (${def.manifest.install}) > /tmp/forge-install.log 2>&1; echo $? > /tmp/forge-install.exit`,
    );
    expect(daytona.execute).toHaveBeenCalledTimes(2);
  });
});
