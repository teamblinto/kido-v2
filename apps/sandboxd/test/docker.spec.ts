import { EventEmitter } from 'node:events';

import type Docker from 'dockerode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DockerodePort } from '../src/docker.ts';
import { FakeDocker } from './fake-docker.ts';

const port = (stub: object) => new DockerodePort(stub as Docker);

describe('events', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reconnects once when the stream emits error then close', async () => {
    const streams: (EventEmitter & { destroy: () => void })[] = [];
    const getEvents = vi.fn(() => {
      const s = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      streams.push(s);
      return Promise.resolve(s);
    });
    const stop = port({ getEvents }).events(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    streams[0]?.emit('error', new Error('boom'));
    streams[0]?.emit('close');
    await vi.advanceTimersByTimeAsync(1000);
    expect(getEvents).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getEvents).toHaveBeenCalledTimes(2);
    stop();
  });

  it('skips malformed lines and keeps delivering', async () => {
    const s = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const got: unknown[] = [];
    const stop = port({ getEvents: () => Promise.resolve(s) }).events((e) => got.push(e));
    await vi.advanceTimersByTimeAsync(0);
    const good = JSON.stringify({ Action: 'die', Actor: { ID: 'c1', Attributes: { a: 'b' } } });
    s.emit('data', Buffer.from(`not json\n${good}\n`));
    expect(got).toEqual([{ action: 'die', cid: 'c1', labels: { a: 'b' } }]);
    stop();
  });
});

describe('ensureNetwork', () => {
  const existing = (over: object) => ({
    listNetworks: () => Promise.resolve([{ Name: 'sbx-agent', Internal: false, ...over }]),
    createNetwork: vi.fn(),
  });

  it('rejects an existing network with the wrong Internal flag', async () => {
    await expect(port(existing({})).ensureNetwork('sbx-agent', { internal: true })).rejects.toThrow(
      /sbx-agent/,
    );
  });

  it('rejects a mismatched enable_icc', async () => {
    await expect(
      port(existing({ Options: {} })).ensureNetwork('sbx-agent', { internal: false, icc: false }),
    ).rejects.toThrow(/sbx-agent/);
  });

  it('accepts a matching network without creating', async () => {
    const stub = existing({ Internal: true });
    await port(stub).ensureNetwork('sbx-agent', { internal: true });
    expect(stub.createNetwork).not.toHaveBeenCalled();
  });

  it('FakeDocker mirrors the check', async () => {
    const f = new FakeDocker();
    await f.ensureNetwork('n', { internal: false });
    await expect(f.ensureNetwork('n', { internal: true })).rejects.toThrow(/n/);
  });
});
