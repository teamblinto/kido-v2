import { log } from '../src/log.ts';

function capture(fn: () => void): string {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out += String(s);
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

describe('log', () => {
  it('never prints sensitive field values', () => {
    const out = capture(() =>
      log('info', 'x', { apiKey: 's3cret', token: 't0k', authorization: 'Bearer z', ok: 1 }),
    );
    for (const v of ['s3cret', 't0k', 'Bearer z']) expect(out).not.toContain(v);
    expect(JSON.parse(out)).toMatchObject({ level: 'info', msg: 'x', ok: 1 });
  });
  it('caller fields cannot overwrite logger fields', () => {
    const out = capture(() => log('warn', 'real', { msg: 'fake', level: 'info', time: 'never' }));
    const j = JSON.parse(out) as Record<string, string>;
    expect(j.msg).toBe('real');
    expect(j.level).toBe('warn');
    expect(j.time).not.toBe('never');
  });
});
