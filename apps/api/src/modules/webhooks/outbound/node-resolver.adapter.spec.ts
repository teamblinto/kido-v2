import type { ConfigService } from '@nestjs/config';
import { createSocket, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';

import type { Environment } from '../../../config/environment';
import { NodeResolverAdapter } from './node-resolver.adapter';

const TYPE = { A: 1, AAAA: 28 } as const;
const RCODE = { NOERROR: 0, NXDOMAIN: 3, SERVFAIL: 2 } as const;

interface CannedResponse {
  readonly addresses?: readonly string[];
  readonly rcode?: number;
  /** Never answer: the query times out. */
  readonly silent?: boolean;
}

const u16 = (value: number) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
};

/** An A or AAAA RDATA from its text form. */
function rdata(address: string): Buffer {
  if (address.includes('.')) return Buffer.from(address.split('.').map(Number));
  const [head = '', tail = ''] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return Buffer.concat(groups.map((group) => u16(Number.parseInt(group, 16))));
}

function parseQuestion(query: Buffer): { name: string; question: Buffer; type: number } {
  let offset = 12;
  const labels: string[] = [];
  while (query[offset] !== 0) {
    const length = query[offset]!;
    labels.push(query.subarray(offset + 1, offset + 1 + length).toString());
    offset += length + 1;
  }
  return {
    name: labels.join('.').toLowerCase(),
    question: query.subarray(12, offset + 5),
    type: query.readUInt16BE(offset + 1),
  };
}

/** The answer packet: id echoed, one answer per address, each pointing back at the question. */
function respond(query: Buffer, canned: CannedResponse): Buffer {
  const { question, type } = parseQuestion(query);
  const addresses = (canned.addresses ?? []).filter(
    (address) => address.includes(':') === (type === TYPE.AAAA),
  );
  const flags = 0x8000 | (query.readUInt16BE(2) & 0x0100) | 0x0080 | (canned.rcode ?? 0);
  return Buffer.concat([
    query.subarray(0, 2),
    u16(flags),
    u16(1),
    u16(addresses.length),
    u16(0),
    u16(0),
    question,
    ...addresses.map((address) => {
      const data = rdata(address);
      return Buffer.concat([
        u16(0xc00c),
        u16(type),
        u16(1),
        Buffer.from([0, 0, 1, 44]),
        u16(data.length),
        data,
      ]);
    }),
  ]);
}

interface Responder {
  readonly address: string;
  readonly asked: string[];
  close(): Promise<void>;
}

async function startResponder(canned: CannedResponse): Promise<Responder> {
  const socket: Socket = createSocket('udp4');
  const asked: string[] = [];
  socket.on('message', (query, remote) => {
    const { name, type } = parseQuestion(query);
    asked.push(`${name} ${type}`);
    if (canned.silent === true) return;
    socket.send(respond(query, canned), remote.port, remote.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    address: `127.0.0.1:${socket.address().port}`,
    asked,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

/** The adapter over a real `Resolver`, pointed at loopback responders answering canned packets. */
describe('NodeResolverAdapter', () => {
  const responders: Responder[] = [];

  afterEach(async () => {
    await Promise.all(responders.splice(0).map((responder) => responder.close()));
  });

  async function adapterFor(...canned: CannedResponse[]) {
    const servers = await Promise.all(canned.map(startResponder));
    responders.push(...servers);
    const addresses = servers.map((server) => server.address);
    const config = { get: () => addresses } as unknown as ConfigService<Environment, true>;
    return { resolver: new NodeResolverAdapter(config), servers };
  }

  it('answers A and AAAA addresses together', async () => {
    const { resolver, servers } = await adapterFor({
      addresses: ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
    });

    const answer = await resolver.resolve('hooks.example.com');
    expect(answer).toEqual({
      addresses: ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
      kind: 'answer',
    });
    expect(servers[0]!.asked.sort()).toEqual([
      `hooks.example.com ${TYPE.A}`,
      `hooks.example.com ${TYPE.AAAA}`,
    ]);
  });

  it('answers with one family when the other has no data', async () => {
    const { resolver } = await adapterFor({ addresses: ['1.1.1.1'] });
    expect(await resolver.resolve('v4.example.com')).toEqual({
      addresses: ['1.1.1.1'],
      kind: 'answer',
    });
  });

  it('NXDOMAIN → empty', async () => {
    const { resolver } = await adapterFor({ rcode: RCODE.NXDOMAIN });
    expect(await resolver.resolve('missing.example.com')).toEqual({ kind: 'empty' });
  });

  it('SERVFAIL on every server → unavailable, having asked each', async () => {
    const { resolver, servers } = await adapterFor(
      { rcode: RCODE.SERVFAIL },
      { rcode: RCODE.SERVFAIL },
    );
    expect(await resolver.resolve('hooks.example.com')).toEqual({ kind: 'unavailable' });
    expect(servers[1]!.asked.length).toBeGreaterThan(0);
  });

  it('SERVFAIL on the first server and an answer on the second → the answer', async () => {
    const { resolver } = await adapterFor({ rcode: RCODE.SERVFAIL }, { addresses: ['8.8.8.8'] });
    expect(await resolver.resolve('hooks.example.com')).toEqual({
      addresses: ['8.8.8.8'],
      kind: 'answer',
    });
  });

  it('a server that never answers → unavailable within the 3 s bound', async () => {
    const { resolver } = await adapterFor({ silent: true });
    const started = Date.now();
    expect(await resolver.resolve('hooks.example.com')).toEqual({ kind: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(3500);
  });
});
