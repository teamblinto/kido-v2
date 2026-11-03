// A stand-in for `codex app-server` (JSONL JSON-RPC without "jsonrpc", server requests in their
// own id space), shaped after live captures. The scenario is a keyword in the turn's text.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.162.1\n');
  process.exit(0);
}
if (args[0] !== 'app-server') process.exit(2);

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => out({ id, result });
let threadId = null;
let turn = null;
let serverRequestId = 0;
const serverPending = new Map();

const notify = (method, params = {}) =>
  out({ emittedAtMs: Date.now(), method, params: { threadId, turnId: turn?.id, ...params } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = serverRequestId++;
    serverPending.set(id, resolve);
    out({ id, method, params: { threadId, turnId: turn?.id, ...params } });
  });
const complete = (status, error = null) => {
  clearInterval(turn?.timer);
  notify('turn/completed', { turn: { error, id: turn.id, items: [], status } });
  turn = null;
};

async function runTurn(text) {
  notify('hook/started', { run: { id: 'h1' } }); // unknown to the companion: must be ignored
  notify('turn/started', { turn: { id: turn.id, status: 'inProgress' } });
  if (text.includes('crash')) {
    process.stderr.write('\u001b[31mpanic\u001b[0m: token=abc123secret\n');
    process.exit(5);
  }
  if (text.includes('limit')) {
    const error = { codexErrorInfo: 'usageLimitExceeded', message: 'You hit your usage limit.' };
    notify('error', { error, willRetry: false });
    return complete('failed', error);
  }
  if (text.includes('slow')) {
    turn.timer = setInterval(
      () => notify('item/agentMessage/delta', { delta: 'x', itemId: 'm1' }),
      20,
    );
    return;
  }
  if (text.includes('command')) {
    // `long` makes the command 9000 characters.
    const inner = text.includes('long') ? `node -v ${'x'.repeat(9_000)}` : 'node -v';
    const item = {
      command: `"powershell.exe" -Command '${inner}'`,
      commandActions: [{ command: inner, type: 'unknown' }],
      cwd: process.cwd(),
      id: 'exec-1',
      status: 'inProgress',
      type: 'commandExecution',
    };
    notify('item/started', { item });
    const answer = await ask('item/commandExecution/requestApproval', {
      availableDecisions: [
        'accept',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['node'] } },
        'cancel',
      ],
      command: item.command,
      commandActions: item.commandActions,
      cwd: process.cwd(),
      itemId: 'exec-1',
    });
    notify('serverRequest/resolved', { requestId: 0 });
    notify('item/agentMessage/delta', {
      delta: `decision:${answer.result.decision}`,
      itemId: 'm1',
    });
    if (answer.result.decision === 'accept') {
      notify('item/commandExecution/outputDelta', { delta: 'v24.0.0\n', itemId: 'exec-1' });
      notify('item/completed', { item: { ...item, exitCode: 0, status: 'completed' } });
    } else {
      notify('item/completed', { item: { ...item, status: 'declined' } });
    }
    return complete(answer.result.decision === 'cancel' ? 'interrupted' : 'completed');
  }
  if (text.includes('file')) {
    // `file:<relative path>` picks the file.
    const target = /file:(\S+)/.exec(text)?.[1] ?? 'hello.txt';
    const item = {
      changes: [{ diff: 'hi\n', kind: { type: 'add' }, path: join(process.cwd(), target) }],
      id: 'patch-1',
      status: 'inProgress',
      type: 'fileChange',
    };
    notify('item/started', { item });
    const answer = await ask('item/fileChange/requestApproval', {
      grantRoot: null,
      itemId: 'patch-1',
      reason: null,
    });
    notify('item/agentMessage/delta', {
      delta: `decision:${answer.result.decision}`,
      itemId: 'm1',
    });
    const accepted = answer.result.decision === 'accept';
    if (accepted) writeFileSync(join(process.cwd(), target), 'hi\n');
    notify('item/completed', { item: { ...item, status: accepted ? 'completed' : 'declined' } });
    return complete('completed');
  }
  notify('item/agentMessage/delta', { delta: 'Hel', itemId: 'm1' });
  notify('item/agentMessage/delta', { delta: 'lo', itemId: 'm1' });
  notify('thread/tokenUsage/updated', {
    tokenUsage: {
      last: { inputTokens: 10, outputTokens: 5 },
      total: { inputTokens: 99, outputTokens: 99 },
    },
  });
  complete('completed');
}

function onRequest({ id, method, params }) {
  switch (method) {
    case 'initialize':
      if (params.clientInfo?.name !== 'baios-companion')
        return out({ error: { code: -32600, message: 'bad client' }, id });
      return respond(id, {
        codexHome: '~/.codex',
        platformFamily: 'windows',
        platformOs: 'windows',
        userAgent: 'x',
      });
    case 'account/read': {
      const kind = process.env.FAKE_CODEX_ACCOUNT ?? 'apiKey';
      const account =
        kind === 'none'
          ? null
          : kind === 'chatgpt'
            ? { email: 'someone@example.com', planType: 'plus', type: 'chatgpt' }
            : { type: 'apiKey' };
      return respond(id, { account, requiresOpenaiAuth: true });
    }
    case 'model/list':
      return respond(id, {
        data: [
          { displayName: 'GPT-6.1-Sol', hidden: false, id: 'gpt-6.1-sol' },
          { hidden: true, id: 'secret-model' },
        ],
        nextCursor: null,
      });
    case 'thread/start':
    case 'thread/resume':
      if (process.env.FAKE_CODEX_PARAMS_FILE)
        writeFileSync(process.env.FAKE_CODEX_PARAMS_FILE, JSON.stringify({ method, params }));
      threadId = params.threadId ?? 'thread-1';
      return respond(id, { thread: { id: threadId, status: { type: 'idle' } } });
    case 'turn/start':
      turn = { id: 'turn-1', timer: null };
      respond(id, { turn: { id: turn.id, items: [], status: 'inProgress' } });
      void runTurn(params.input[0].text);
      return;
    case 'turn/interrupt':
      respond(id, {});
      if (turn) complete('interrupted');
      return;
    case 'turn/steer':
      return respond(id, { turnId: turn?.id });
    default:
      return out({ error: { code: -32600, message: `unknown variant ${method}` }, id });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method && message.id !== undefined) return onRequest(message);
  if (message.method) return;
  const settle = serverPending.get(message.id);
  serverPending.delete(message.id);
  settle?.(message);
});
process.stdin.on('end', () => process.exit(0));
