// A stand-in for Claude Code's headless stream-json protocol, shaped after live captures. The
// scenario is picked by a keyword in the prompt. It calls the BAIOS tools by starting the MCP
// server from --mcp-config exactly as Claude Code does (server/discover probe first).
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
// With FAKE_CLAUDE_LOGIN_FILE set, that file existing means signed in (login writes it).
const loginFile = process.env.FAKE_CLAUDE_LOGIN_FILE;
if (args[0] === '--version') {
  process.stdout.write('2.1.316 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'login') {
  // Like 2.1.309+ on plain pipes: closing stdin does not end it; a wrong code does.
  const url =
    process.env.FAKE_CLAUDE_LOGIN_URL ??
    'https://claude.com/cai/oauth/authorize?code=true&client_id=c1&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s1';
  process.stdout.write(
    `Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\nPaste code here if prompted > `,
  );
  setInterval(() => undefined, 60_000);
  createInterface({ input: process.stdin }).on('line', (line) => {
    process.stdout.write(`${line}\n`); // echoes what was pasted, which must never reach a log
    if (!line.includes('#')) {
      process.stdout.write('Invalid code. Please make sure the full code was copied.\n');
    } else if (line === 'abc#xyz') {
      if (loginFile) writeFileSync(loginFile, 'signed in');
      process.stdout.write('Login successful.\n');
      process.exit(0);
    } else {
      process.stderr.write('Login failed: Request failed with status code 400\n');
      process.exit(1);
    }
  });
  await new Promise(() => undefined); // never run the stream-json part below
}
if (args[0] === 'auth' && args[1] === 'logout') {
  if (loginFile) rmSync(loginFile, { force: true });
  process.stdout.write('Successfully logged out from your Anthropic account.\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  const fallback = process.env.FAKE_CLAUDE_AUTH ?? 'claude.ai';
  const method = loginFile ? (existsSync(loginFile) ? 'claude.ai' : 'none') : fallback;
  process.stdout.write(
    `${JSON.stringify({
      apiProvider: 'firstParty',
      authMethod: method,
      email: 'someone@example.com',
      loggedIn: method !== 'none',
      orgId: 'org-secret',
      subscriptionType: 'max',
    })}\n`,
  );
  process.exit(method === 'none' ? 1 : 0);
}

// Like the real CLI: `--flag value` or `--flag=value`.
const flag = (name) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
if (process.env.FAKE_CLAUDE_ARGV_FILE) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGV_FILE, JSON.stringify(args));
}
if (process.env.FAKE_CLAUDE_INFO_FILE) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(CLAUDE_CODE_|MCP_)/.test(key)),
  );
  const cwd = process.cwd();
  writeFileSync(
    process.env.FAKE_CLAUDE_INFO_FILE,
    JSON.stringify({ cwd, entries: readdirSync(cwd), env }),
  );
}
// Rules from `--allowedTools` (comma or space separated); `mcp__baios` covers the whole server.
const allowed = (flag('--allowedTools') ?? '').split(/[ ,]+/).filter(Boolean);
const preApproved = (name) => allowed.some((rule) => rule === name || name.startsWith(`${rule}__`));
const sessionId = flag('--resume') ?? '11111111-2222-4333-8444-555555555555';
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let lastWasError = false;
let slowTimer = null;
// One turn at a time; user lines that arrive mid-turn are queued and run together as one turn.
let busy = false;
const queued = [];

const init = () =>
  out({
    cwd: process.cwd(),
    mcp_servers: [{ name: 'baios', status: 'connected' }],
    permissionMode: 'default',
    session_id: sessionId,
    subtype: 'init',
    type: 'system',
  });
const delta = (text) =>
  out({
    event: { delta: { text, type: 'text_delta' }, index: 0, type: 'content_block_delta' },
    session_id: sessionId,
    type: 'stream_event',
  });
const result = (extra = {}) => {
  const message = {
    is_error: false,
    result: 'ok',
    session_id: sessionId,
    subtype: 'success',
    type: 'result',
    usage: {
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      input_tokens: 4,
      output_tokens: 7,
    },
    ...extra,
  };
  lastWasError = message.is_error === true;
  out(message);
  busy = false;
  if (queued.length) setTimeout(() => startTurn(queued.splice(0).join('\n')), 50);
};

let mcp = null;
function startMcp() {
  const config = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8'));
  const server = config.mcpServers.baios;
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    const settle = pending.get(message.id);
    pending.delete(message.id);
    settle?.(message);
  });
  const call = (id, method, params) =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`);
    });
  let nextId = 0;
  return (async () => {
    const discover = await call('server-discover-probe-1', 'server/discover', {});
    if (discover.error?.code !== -32601) throw new Error('server/discover must be -32601');
    const initialized = await call(nextId++, 'initialize', {
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '2.1.316' },
      protocolVersion: '2025-11-25',
    });
    if (initialized.result.protocolVersion !== '2025-11-25') throw new Error('protocol not echoed');
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const tools = await call(nextId++, 'tools/list', {});
    const names = tools.result.tools.map((tool) => tool.name);
    return {
      child,
      names,
      request: async (method, params) => (await call(nextId++, method, params)).result,
    };
  })();
}

function startTurn(text) {
  busy = true;
  void onPrompt(text);
}

async function onPrompt(text) {
  init();
  if (text.includes('merge')) {
    delta('first');
    return setTimeout(() => result(), 300);
  }
  if (text.includes('crash')) {
    process.stderr.write('fatal: lost connection, key sk-ant-api03-abcdefghijklmnop\n');
    process.exit(3);
  }
  if (text.includes('auth')) {
    out({
      error: 'authentication_failed',
      message: { content: [{ text: 'Not logged in', type: 'text' }] },
      type: 'assistant',
    });
    return result({ is_error: true, result: 'Not logged in · Please run /login' });
  }
  if (text.includes('limit')) {
    out({
      rate_limit_info: { rateLimitType: 'five_hour', resetsAt: 1793643000, status: 'rejected' },
      type: 'rate_limit_event',
    });
    return result({ api_error_status: 429, is_error: true, result: 'Claude usage limit reached' });
  }
  if (text.includes('slow')) {
    slowTimer = setInterval(() => delta('x'), 20);
    return;
  }
  const toolMatch = /tool:(\w+)/.exec(text);
  if (toolMatch) {
    // A BAIOS sandbox tool, called the way Claude Code calls an MCP tool.
    const name = `mcp__baios__${toolMatch[1]}`;
    const id = 'toolu_mcp_1';
    const input = { path: 'README.md' };
    out({
      message: { content: [{ id, input, name, type: 'tool_use' }], role: 'assistant' },
      type: 'assistant',
    });
    mcp ??= startMcp();
    const { names, request } = await mcp;
    let answer;
    if (!names.includes(toolMatch[1]))
      answer = { content: [{ text: 'no such tool' }], isError: true };
    // `dontAsk` without a rule: refused, no prompt.
    else if (!preApproved(name))
      answer = { content: [{ text: 'permission denied' }], isError: true };
    else answer = await request('tools/call', { arguments: input, name: toolMatch[1] });
    const output = answer.content[0].text;
    if (process.env.FAKE_CLAUDE_TOOL_LOG) {
      appendFileSync(process.env.FAKE_CLAUDE_TOOL_LOG, `${JSON.stringify(answer)}\n`);
    }
    out({
      message: {
        content: [
          { content: output, is_error: answer.isError, tool_use_id: id, type: 'tool_result' },
        ],
        role: 'user',
      },
      type: 'user',
    });
    delta(`${answer.isError ? 'error' : 'ok'} ${output}`);
    return result();
  }
  delta('Hel');
  delta('lo');
  out({
    message: { content: [{ text: 'Hello', type: 'text' }], role: 'assistant' },
    type: 'assistant',
  });
  result();
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'user') {
    const text = String(message.message.content);
    if (!busy) startTurn(text);
    else if (!process.env.FAKE_CLAUDE_ABSORB_INPUT) queued.push(text);
  } else if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
    if (process.env.FAKE_CLAUDE_IGNORE_INTERRUPT) return;
    clearInterval(slowTimer);
    out({
      response: {
        request_id: message.request_id,
        response: { still_queued: [] },
        subtype: 'success',
      },
      type: 'control_response',
    });
    out({
      aborted: true,
      message: { content: [{ text: 'xx', type: 'text' }], role: 'assistant' },
      type: 'assistant',
    });
    result({
      is_error: true,
      subtype: 'error_during_execution',
      terminal_reason: 'aborted_streaming',
    });
  }
});
process.stdin.on('end', () => {
  clearInterval(slowTimer);
  void mcp?.then(({ child }) => child.stdin.end()).catch(() => undefined);
  setTimeout(() => process.exit(lastWasError ? 1 : 0), 20);
});
