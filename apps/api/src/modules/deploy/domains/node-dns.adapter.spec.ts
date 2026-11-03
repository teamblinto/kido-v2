import type { ConfigService } from '@nestjs/config';
import { createSocket, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';

import type { Environment } from '../../../config/environment';
import { MAX_CNAME_HOPS } from './dns.port';
import { NodeDnsAdapter } from './node-dns.adapter';

const TYPE = { CAA: 257, CNAME: 5, SOA: 6, TXT: 16 } as const;
const RCODE = { NOERROR: 0, NXDOMAIN: 3, SERVFAIL: 2 } as const;

/** One resource record of a canned answer, its RDATA already encoded. */
interface CannedRecord {
  readonly name: string;
  readonly rdata: Buffer;
  readonly type: number;
}

/** What the responder answers for one `name type` question. Unlisted questions answer NODATA. */
interface CannedResponse {
  readonly answers?: readonly CannedRecord[];
  readonly rcode?: number;
}

/** A name as uncompressed labels (RFC 1035 §3.1). */
function encodeName(name: string): Buffer {
  const labels = name.split('.').filter((label) => label !== '');
  return Buffer.concat([
    ...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);
}

const u16 = (value: number) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
};
const u32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};

/** TXT RDATA: each string one length-prefixed character-string (RFC 1035 §3.3.14). */
const txt = (name: string, ...strings: string[]): CannedRecord => ({
  name,
  rdata: Buffer.concat(
    strings.map((value) => Buffer.concat([Buffer.from([value.length]), Buffer.from(value)])),
  ),
  type: TYPE.TXT,
});

const cname = (name: string, target: string): CannedRecord => ({
  name,
  rdata: encodeName(target),
  type: TYPE.CNAME,
});

const soa = (name: string): CannedRecord => ({
  name,
  rdata: Buffer.concat([
    encodeName(`ns1.${name}`),
    encodeName(`hostmaster.${name}`),
    u32(2026092301),
    u32(7200),
    u32(3600),
    u32(1209600),
    u32(300),
  ]),
  type: TYPE.SOA,
});

/** CAA RDATA (RFC 8659 §4.1): flags, tag length, tag, value. */
const caa = (name: string, flags: number, tag: string, value: string): CannedRecord => ({
  name,
  rdata: Buffer.concat([Buffer.from([flags, tag.length]), Buffer.from(tag), Buffer.from(value)]),
  type: TYPE.CAA,
});

/** The question of a query: name (lowercased), type, and the raw bytes to echo. */
function parseQuestion(query: Buffer): { name: string; question: Buffer; type: number } {
  let offset = 12;
  const labels: string[] = [];
  while (query[offset] !== 0) {
    const length = query[offset]!;
    labels.push(query.subarray(offset + 1, offset + 1 + length).toString());
    offset += length + 1;
  }
  const end = offset + 1 + 4;
  return {
    name: labels.join('.').toLowerCase(),
    question: query.subarray(12, end),
    type: query.readUInt16BE(offset + 1),
  };
}

/** The response packet for `query` built from `canned`: id echoed, RD and RA set, no EDNS. */
function respond(query: Buffer, canned: CannedResponse): Buffer {
  const { question } = parseQuestion(query);
  const answers = canned.answers ?? [];
  const flags = 0x8000 | (query.readUInt16BE(2) & 0x0100) | 0x0080 | (canned.rcode ?? 0);
  return Buffer.concat([
    query.subarray(0, 2),
    u16(flags),
    u16(1),
    u16(answers.length),
    u16(0),
    u16(0),
    question,
    ...answers.map((record) =>
      Buffer.concat([
        encodeName(record.name),
        u16(record.type),
        u16(1),
        u32(300),
        u16(record.rdata.length),
        record.rdata,
      ]),
    ),
  ]);
}

interface Responder {
  readonly address: string;
  /** Every question asked, as `name TYPE-number`. */
  readonly asked: string[];
  close(): Promise<void>;
}

/** A loopback UDP DNS server answering from `table`, keyed `name type`. */
async function startResponder(
  table: Readonly<Record<string, CannedResponse>>,
  fallback: CannedResponse = {},
): Promise<Responder> {
  const socket: Socket = createSocket('udp4');
  const asked: string[] = [];
  socket.on('message', (query, remote) => {
    const { name, type } = parseQuestion(query);
    asked.push(`${name} ${type}`);
    socket.send(respond(query, table[`${name} ${type}`] ?? fallback), remote.port, remote.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    address: `127.0.0.1:${socket.address().port}`,
    asked,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

/**
 * The adapter over a real `Resolver`, pointed at loopback responders that answer canned packets
 * (research R15): the real c-ares parsing, error codes and server fail-over.
 */
describe('NodeDnsAdapter', () => {
  const responders: Responder[] = [];

  afterEach(async () => {
    await Promise.all(responders.splice(0).map((responder) => responder.close()));
  });

  async function adapterFor(
    ...tables: { table: Record<string, CannedResponse>; fallback?: CannedResponse }[]
  ): Promise<{ dns: NodeDnsAdapter; servers: Responder[] }> {
    const servers = await Promise.all(
      tables.map(({ table, fallback }) => startResponder(table, fallback)),
    );
    responders.push(...servers);
    const resolvers = servers.map((server) => server.address);
    const config = { get: () => resolvers } as unknown as ConfigService<Environment, true>;
    return { dns: new NodeDnsAdapter(config), servers };
  }

  it('answers TXT records with each record multi-string joined', async () => {
    const name = '_forge-challenge.shop.example.com';
    const { dns } = await adapterFor({
      table: {
        [`${name} ${TYPE.TXT}`]: {
          answers: [txt(name, 'forge-verify=', 'abc234'), txt(name, 'other')],
        },
      },
    });

    const answer = await dns.resolveTxt(name);
    expect(answer.kind).toBe('answer');
    expect(answer.kind === 'answer' && [...answer.records].sort()).toEqual([
      'forge-verify=abc234',
      'other',
    ]);
  });

  it('follows a CNAME chain of 3 hops', async () => {
    const { dns } = await adapterFor({
      table: {
        [`www.shop.example.com ${TYPE.CNAME}`]: {
          answers: [cname('www.shop.example.com', 'a.example.net')],
        },
        [`a.example.net ${TYPE.CNAME}`]: { answers: [cname('a.example.net', 'b.example.net')] },
        [`b.example.net ${TYPE.CNAME}`]: {
          answers: [cname('b.example.net', 'edge.forge-saas.example')],
        },
      },
    });

    expect(await dns.resolveCnameChain('www.shop.example.com')).toEqual({
      chain: ['a.example.net', 'b.example.net', 'edge.forge-saas.example'],
      kind: 'answer',
    });
  });

  it('stops the CNAME chain at MAX_CNAME_HOPS and never asks for the 9th hop', async () => {
    const table: Record<string, CannedResponse> = {};
    for (let hop = 0; hop < 12; hop += 1) {
      table[`h${hop}.example.net ${TYPE.CNAME}`] = {
        answers: [cname(`h${hop}.example.net`, `h${hop + 1}.example.net`)],
      };
    }
    const { dns, servers } = await adapterFor({ table });

    const answer = await dns.resolveCnameChain('h0.example.net');
    expect(MAX_CNAME_HOPS).toBe(8);
    expect(answer).toEqual({
      chain: Array.from({ length: 8 }, (_, index) => `h${index + 1}.example.net`),
      kind: 'answer',
    });
    expect(servers[0]!.asked).not.toContain(`h8.example.net ${TYPE.CNAME}`);
  });

  it('stops a CNAME loop instead of following it', async () => {
    const { dns } = await adapterFor({
      table: {
        [`a.example.net ${TYPE.CNAME}`]: { answers: [cname('a.example.net', 'b.example.net')] },
        [`b.example.net ${TYPE.CNAME}`]: { answers: [cname('b.example.net', 'a.example.net')] },
      },
    });

    expect(await dns.resolveCnameChain('a.example.net')).toEqual({
      chain: ['b.example.net', 'a.example.net'],
      kind: 'answer',
    });
  });

  it('NXDOMAIN and NODATA → empty', async () => {
    const { dns } = await adapterFor({
      fallback: { rcode: RCODE.NXDOMAIN },
      table: { [`nodata.example.com ${TYPE.TXT}`]: { rcode: RCODE.NOERROR } },
    });

    expect(await dns.resolveTxt('missing.example.com')).toEqual({ kind: 'empty' });
    expect(await dns.resolveTxt('nodata.example.com')).toEqual({ kind: 'empty' });
    expect(await dns.resolveCnameChain('missing.example.com')).toEqual({ kind: 'empty' });
    expect(await dns.resolveCaa('missing.example.com')).toEqual({ kind: 'empty' });
    expect(await dns.resolveSoaOwner('missing.example.com')).toEqual({ kind: 'empty' });
  });

  it('SERVFAIL on both configured servers → unavailable, having asked both', async () => {
    const servfail = { fallback: { rcode: RCODE.SERVFAIL }, table: {} };
    const { dns, servers } = await adapterFor(servfail, servfail);

    expect(await dns.resolveTxt('shop.example.com')).toEqual({ kind: 'unavailable' });
    expect(await dns.resolveCnameChain('shop.example.com')).toEqual({ kind: 'unavailable' });
    expect(await dns.resolveCaa('shop.example.com')).toEqual({ kind: 'unavailable' });
    expect(await dns.resolveSoaOwner('shop.example.com')).toEqual({ kind: 'unavailable' });
    expect(servers[0]!.asked.length).toBeGreaterThan(0);
    expect(servers[1]!.asked.length).toBeGreaterThan(0);
  });

  it('SERVFAIL on the first server and an answer on the second → the answer', async () => {
    const name = 'shop.example.com';
    const { dns } = await adapterFor(
      { fallback: { rcode: RCODE.SERVFAIL }, table: {} },
      { table: { [`${name} ${TYPE.TXT}`]: { answers: [txt(name, 'ok')] } } },
    );

    expect(await dns.resolveTxt(name)).toEqual({ kind: 'answer', records: ['ok'] });
  });

  it('a later CNAME hop that is unavailable makes the whole chain unavailable', async () => {
    const { dns } = await adapterFor({
      fallback: { rcode: RCODE.SERVFAIL },
      table: {
        [`www.example.com ${TYPE.CNAME}`]: { answers: [cname('www.example.com', 'a.example.net')] },
      },
    });

    expect(await dns.resolveCnameChain('www.example.com')).toEqual({ kind: 'unavailable' });
  });

  it('answers an SOA whose owner equals the query name: a zone apex', async () => {
    const { dns } = await adapterFor({
      table: { [`example.com ${TYPE.SOA}`]: { answers: [soa('example.com')] } },
    });

    expect(await dns.resolveSoaOwner('example.com')).toEqual({
      kind: 'answer',
      owner: 'example.com',
    });
  });

  it('answers the CNAME target as the SOA owner for a name that is itself a CNAME', async () => {
    const { dns } = await adapterFor({
      table: {
        [`shop.example.com ${TYPE.CNAME}`]: {
          answers: [cname('shop.example.com', 'example.net')],
        },
        [`shop.example.com ${TYPE.SOA}`]: {
          answers: [cname('shop.example.com', 'example.net'), soa('example.net')],
        },
      },
    });

    expect(await dns.resolveSoaOwner('shop.example.com')).toEqual({
      kind: 'answer',
      owner: 'example.net',
    });
  });

  it('answers CAA records with the critical flag, lowercase tag and value', async () => {
    const name = 'example.com';
    const { dns } = await adapterFor({
      table: {
        [`${name} ${TYPE.CAA}`]: {
          answers: [
            caa(name, 0, 'issue', 'letsencrypt.org'),
            caa(name, 128, 'issuewild', ';'),
            caa(name, 0, 'iodef', 'mailto:sec@example.com'),
          ],
        },
      },
    });

    const answer = await dns.resolveCaa(name);
    expect(answer.kind).toBe('answer');
    expect(
      answer.kind === 'answer' && [...answer.records].sort((a, b) => a.tag.localeCompare(b.tag)),
    ).toEqual([
      { critical: false, tag: 'iodef', value: 'mailto:sec@example.com' },
      { critical: false, tag: 'issue', value: 'letsencrypt.org' },
      { critical: true, tag: 'issuewild', value: ';' },
    ]);
  });
});
