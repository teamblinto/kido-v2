import type { CompanionRunEventBatch, CompanionStatusReport } from '@repo/contracts';
import type { LocalAgentDeviceRow } from '@repo/db';
import { describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import { DeviceService } from './device.service';
import type { LocalAgentRepository } from './local-agent.repository';
import type { AppendResult, HomeAuth, LocalAgentStore } from './local-agent.store';

const USER = 'b0400000-0000-4000-8000-0000000000a1';
const DEVICE = 'b0400000-0000-4000-8000-0000000000d1';
const RUN = 'b0400000-0000-4000-8000-000000000001';
const ORG = 'b0400000-0000-4000-8000-0000000000c1';

const device = {
  companionVersion: '0.1.0',
  id: DEVICE,
  kind: 'cloud',
  lastSeenAt: null,
  name: 'Cloud agent home',
  platform: 'linux',
  revokedAt: null,
  userId: USER,
} as unknown as LocalAgentDeviceRow;

const batch: CompanionRunEventBatch = {
  events: [{ data: { text: 'hi' }, seq: 1, type: 'text.delta' }],
  turn: 2,
};

function setup(options: { status?: string; appended?: AppendResult } = {}) {
  const repository = {
    byId: vi.fn(() => Promise.resolve(device)),
    byTokenHash: vi.fn(() => Promise.resolve(device)),
    runForDevice: vi.fn(() =>
      Promise.resolve({ orgId: ORG, providerSessionId: null, status: options.status ?? 'running' }),
    ),
    setProviderSession: vi.fn(() => Promise.resolve()),
    touch: vi.fn(() => Promise.resolve()),
  };
  const store = {
    abortRun: vi.fn(() => Promise.resolve()),
    appendRunEvents: vi.fn(() =>
      Promise.resolve(options.appended ?? { accepted: 1, kind: 'appended' }),
    ),
  };
  const service = new DeviceService(
    repository as unknown as LocalAgentRepository,
    store as unknown as LocalAgentStore,
    new FakeClock('2026-11-02T00:00:00Z'),
  );

  return { repository, service, store };
}

describe('DeviceService', () => {
  describe('ingest', () => {
    it('appends a batch to the turn it names while a worker holds the run', async () => {
      const { service, store } = setup();

      await expect(service.ingest(device, RUN, batch)).resolves.toBe(1);
      expect(store.appendRunEvents).toHaveBeenCalledWith(RUN, 2, batch.events);
    });

    it.each(['queued', 'awaiting_input', 'succeeded', 'failed', 'cancelled'])(
      'refuses events for a run that is %s (409), appending nothing',
      async (status) => {
        const { service, store } = setup({ status });

        await expect(service.ingest(device, RUN, batch)).rejects.toMatchObject({
          type: 'conflict',
        });
        expect(store.appendRunEvents).not.toHaveBeenCalled();
      },
    );

    it('refuses a turn that is not the running one (409): a late retry of an earlier turn', async () => {
      const { service } = setup({ appended: { kind: 'not-active' } });

      await expect(service.ingest(device, RUN, batch)).rejects.toMatchObject({
        type: 'conflict',
      });
    });

    it('refuses a batch past the turn’s budget (413) and aborts the run', async () => {
      const { service, store } = setup({ appended: { kind: 'over-budget' } });

      await expect(service.ingest(device, RUN, batch)).rejects.toMatchObject({
        type: 'payload-too-large',
      });
      expect(store.abortRun).toHaveBeenCalledWith(RUN, 'over-budget');
    });
  });

  describe('reportStatus', () => {
    const usage = {
      checkedAt: '2026-11-02T00:00:00.000Z',
      windows: [{ kind: 'session' as const, resetsAt: null, utilization: 59 }],
    };
    const claude = (
      extra: Partial<CompanionStatusReport['providers'][number]> = {},
    ): CompanionStatusReport => ({
      companionVersion: '0.1.0',
      providers: [
        {
          auth: { method: 'subscription', plan: 'Max', status: 'authenticated' },
          checkedAt: '2026-11-02T00:00:00.000Z',
          installed: true,
          message: null,
          models: [
            { description: 'Best for everyday tasks', id: 'default', label: 'Default' },
            { id: 'sonnet', label: 'Sonnet 5.5' },
            { id: '--dangerously-skip-permissions', label: 'Flag' },
          ],
          policy: { allowed: true, reason: null },
          provider: 'claude',
          usage,
          version: '2.1.317',
          ...extra,
        },
      ],
    });

    function reporting() {
      const { repository, service, store } = setup();
      let saved: HomeAuth | undefined;
      const extra = {
        clearSignIn: vi.fn(() => Promise.resolve()),
        homeAuth: vi.fn(() => Promise.resolve(saved)),
        saveHomeAuth: vi.fn((_id: string, auth: HomeAuth) => {
          saved = JSON.parse(JSON.stringify(auth)) as HomeAuth;
          return Promise.resolve();
        }),
        saveStatus: vi.fn(() => Promise.resolve()),
      };
      Object.assign(store, extra);
      Object.assign(repository, { setCompanionVersion: vi.fn(() => Promise.resolve()) });

      return { saved: () => saved, service };
    }

    it('keeps the models the signed-in CLI listed and its limits with the verdict, never a flag-shaped id', async () => {
      const { saved, service } = reporting();

      await service.reportStatus(device, claude());

      expect(saved()).toEqual({
        checkedAt: '2026-11-02T00:00:00.000Z',
        models: [
          { description: 'Best for everyday tasks', id: 'default', label: 'Default' },
          { description: null, id: 'sonnet', label: 'Sonnet 5.5' },
        ],
        plan: 'Max',
        status: 'authenticated',
        usage,
      });
    });

    it('keeps the last models and limits through a report that could not ask the CLI, and drops them on sign-out', async () => {
      const { saved, service } = reporting();

      await service.reportStatus(device, claude());
      await service.reportStatus(device, claude({ models: [], usage: undefined }));
      expect(saved()).toMatchObject({ models: [{ id: 'default' }, { id: 'sonnet' }], usage });

      await service.reportStatus(
        device,
        claude({ auth: { method: null, plan: null, status: 'unauthenticated' }, models: [] }),
      );
      expect(saved()).toEqual({
        checkedAt: '2026-11-02T00:00:00.000Z',
        plan: null,
        status: 'unauthenticated',
      });
    });
  });

  it('is live while its row exists unrevoked', async () => {
    const { repository, service } = setup();

    await expect(service.isLive(DEVICE)).resolves.toBe(true);
    repository.byId.mockResolvedValueOnce({ ...device, revokedAt: new Date() });
    await expect(service.isLive(DEVICE)).resolves.toBe(false);
    repository.byId.mockResolvedValueOnce(undefined as unknown as LocalAgentDeviceRow);
    await expect(service.isLive(DEVICE)).resolves.toBe(false);
    // A person's own paired computer (spec 040) is retired: never live, even unrevoked.
    repository.byId.mockResolvedValueOnce({ ...device, kind: 'local' });
    await expect(service.isLive(DEVICE)).resolves.toBe(false);
  });

  describe('authenticate', () => {
    const token = `bld_${'a'.repeat(43)}`;

    it('takes a live agent home’s token', async () => {
      const { service } = setup();

      await expect(service.authenticate(token)).resolves.toBe(device);
    });

    it('refuses a missing, malformed, unknown, revoked or retired-local token as revoked (401)', async () => {
      const { repository, service } = setup();

      await expect(service.authenticate(undefined)).rejects.toMatchObject({
        type: 'local-agent-revoked',
      });
      await expect(service.authenticate('bld_short')).rejects.toMatchObject({
        type: 'local-agent-revoked',
      });

      for (const found of [
        undefined,
        { ...device, revokedAt: new Date() },
        { ...device, kind: 'local' },
      ]) {
        repository.byTokenHash.mockResolvedValueOnce(found as LocalAgentDeviceRow);
        await expect(service.authenticate(token)).rejects.toMatchObject({
          type: 'local-agent-revoked',
        });
      }
    });
  });
});
