import { ProviderError } from '../../src/modules/agent/provider-error';
import { ScriptedProvider } from './scripted-provider';

const request = { system: 's', tools: [], messages: [] };
const credential = {
  mode: 'PLATFORM' as const,
  provider: 'anthropic' as const,
  apiKey: 'sk-ant-test',
};

function hooks(signal: AbortSignal = new AbortController().signal) {
  const deltas: string[] = [];
  return { onDelta: (d: { text: string }) => deltas.push(d.text), signal, deltas };
}

describe('ScriptedProvider', () => {
  it('emits onDelta per space-split chunk then resolves the turn', async () => {
    const provider = new ScriptedProvider().script({ text: 'hello there world' });
    const client = provider.client(credential, 'claude-sonnet-5');
    const h = hooks();

    const turn = await client.complete(request, h);

    expect(h.deltas).toEqual(['hello', 'there', 'world']);
    expect(turn.text).toBe('hello there world');
    expect(turn.stop).toBe('end_turn');
  });

  it('throws a ProviderError with the scripted class on a fail step', async () => {
    const provider = new ScriptedProvider().script({ fail: 'rate-limited' });
    const client = provider.client(credential, 'claude-sonnet-5');

    await expect(client.complete(request, hooks())).rejects.toMatchObject(
      new ProviderError('rate-limited'),
    );
  });

  it('resolves a hang step only when the signal aborts, rejecting with its reason', async () => {
    const provider = new ScriptedProvider().script({ hang: true });
    const client = provider.client(credential, 'claude-sonnet-5');
    const controller = new AbortController();
    const h = hooks(controller.signal);

    const pending = client.complete(request, h);
    controller.abort(new Error('cancelled'));

    await expect(pending).rejects.toThrow('cancelled');
  });

  it('emits one delta per gap on a slow step, abortable between chunks', async () => {
    const provider = new ScriptedProvider().script({ slow: { chunks: ['a', 'b', 'c'], gapMs: 5 } });
    const client = provider.client(credential, 'claude-sonnet-5');
    const h = hooks();

    const turn = await client.complete(request, h);

    expect(h.deltas).toEqual(['a', 'b', 'c']);
    expect(turn.text).toBe('a b c');
  });

  it('aborts a slow step between chunks', async () => {
    const provider = new ScriptedProvider().script({
      slow: { chunks: ['a', 'b', 'c'], gapMs: 50 },
    });
    const client = provider.client(credential, 'claude-sonnet-5');
    const controller = new AbortController();
    const h = hooks(controller.signal);

    const pending = client.complete(request, h);
    setTimeout(() => controller.abort(new Error('stop')), 20);

    await expect(pending).rejects.toThrow('stop');
  });

  it('throws when the script is empty so a test never passes on a missing step', async () => {
    const provider = new ScriptedProvider();
    const client = provider.client(credential, 'claude-sonnet-5');

    await expect(client.complete(request, hooks())).rejects.toThrow();
  });

  it('logs deep-frozen copies of credential, model and request per call, and counts clients', async () => {
    const provider = new ScriptedProvider().script({ text: 'ok' });
    const client = provider.client(credential, 'claude-sonnet-5');
    await client.complete(request, hooks());

    expect(provider.clients).toBe(1);
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0];
    expect(call).toMatchObject({ model: 'claude-sonnet-5', credential });
    expect(Object.isFrozen(call)).toBe(true);
    expect(Object.isFrozen(call?.credential)).toBe(true);
  });
});
