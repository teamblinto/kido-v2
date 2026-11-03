import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWatchdog, httpProbe } from './watchdog.ts';

const START_PERIOD_MS = 60_000;
const INTERVAL_MS = 10_000;

/** A watchdog on a fake clock whose probe answers from `answers`, one per tick. */
function build(answers: boolean[]) {
  let now = 0;
  const onDead = vi.fn();
  const probe = vi.fn(() => Promise.resolve(answers.shift() ?? false));
  const watchdog = createWatchdog({
    failures: 3,
    now: () => now,
    onDead,
    probe,
    startPeriodMs: START_PERIOD_MS,
  });
  /** Advance the clock one interval, then tick: what main.ts's setInterval does. */
  const tick = async (times = 1) => {
    for (let i = 0; i < times; i += 1) {
      now += INTERVAL_MS;
      await watchdog.tick();
    }
  };
  return { onDead, probe, tick };
}

describe('createWatchdog', () => {
  it('declares the namespace dead after three consecutive unanswered probes past the start period', async () => {
    const { onDead, tick } = build([]);

    await tick(5); // 10–50 s: inside the start period, not counted
    expect(onDead).not.toHaveBeenCalled();
    await tick(3); // 60, 70, 80 s
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('never fires while the api answers, and an answer resets the count', async () => {
    const answers = [...Array<boolean>(6).fill(true), false, false, true, false, false, true];
    const { onDead, probe, tick } = build(answers);

    await tick(12);

    expect(probe).toHaveBeenCalledTimes(12);
    expect(onDead).not.toHaveBeenCalled();
  });

  it('leaves an api that is still booting alone for the whole start period', async () => {
    // Refused for 50 s (the api has not bound yet), then up.
    const { onDead, tick } = build([false, false, false, false, false, true, true]);

    await tick(7);

    expect(onDead).not.toHaveBeenCalled();
  });

  it('fires once and stops probing after it has fired', async () => {
    const { onDead, probe, tick } = build([]);

    await tick(10);

    expect(onDead).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(8);
  });
});

describe('httpProbe', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function listen(status: number): Promise<string> {
    server = createServer((_req, res) => res.writeHead(status).end('down'));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/health`;
  }

  it('counts any HTTP answer, a 503 included, as a live namespace', async () => {
    expect(await httpProbe(await listen(503), 1_000)()).toBe(true);
  });

  it('counts a refused connect as no answer', async () => {
    const url = await listen(200);
    server!.close();
    await new Promise((resolve) => server!.once('close', resolve));

    expect(await httpProbe(url, 1_000)()).toBe(false);
  });

  it('counts a probe that outlives its timeout as no answer', async () => {
    server = createServer(() => undefined); // accepts, never answers
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;

    expect(await httpProbe(url, 50)()).toBe(false);
    server.closeAllConnections();
  });
});
