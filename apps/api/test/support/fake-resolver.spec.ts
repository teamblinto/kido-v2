import { describe, expect, it } from 'vitest';

import { FakeResolver } from './fake-resolver';

describe('FakeResolver', () => {
  it('answers scripted calls in order and repeats the last, so rebinding can be played', async () => {
    const resolver = new FakeResolver().set('Hooks.Example.com.', [['1.1.1.1'], ['127.0.0.1']]);

    expect(await resolver.resolve('hooks.example.com')).toEqual({
      addresses: ['1.1.1.1'],
      kind: 'answer',
    });
    expect(await resolver.resolve('hooks.example.com')).toEqual({
      addresses: ['127.0.0.1'],
      kind: 'answer',
    });
    expect(await resolver.resolve('hooks.example.com')).toEqual({
      addresses: ['127.0.0.1'],
      kind: 'answer',
    });
    expect(resolver.asked).toEqual(['hooks.example.com', 'hooks.example.com', 'hooks.example.com']);
  });

  it('an unset host or an empty answer is empty', async () => {
    const resolver = new FakeResolver().set('none.example.com', [[]]);
    expect(await resolver.resolve('missing.example.com')).toEqual({ kind: 'empty' });
    expect(await resolver.resolve('none.example.com')).toEqual({ kind: 'empty' });
  });

  it('unavailable(host) answers unavailable until set again', async () => {
    const resolver = new FakeResolver()
      .set('a.example.com', [['8.8.8.8']])
      .unavailable('a.example.com');
    expect(await resolver.resolve('a.example.com')).toEqual({ kind: 'unavailable' });
    resolver.set('a.example.com', [['8.8.4.4']]);
    expect(await resolver.resolve('a.example.com')).toEqual({
      addresses: ['8.8.4.4'],
      kind: 'answer',
    });
  });
});
