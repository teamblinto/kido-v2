import { describe, expect, it } from 'vitest';

import { classifyTool, commandText, describeTool, diffStat, readOutput } from './tool-activity';

describe('tool activity', () => {
  it('classifies the broker tools, the CLI tools and MCP-bridged names', () => {
    expect(classifyTool('fs_read')).toBe('read');
    expect(classifyTool('fs_edit')).toBe('edit');
    expect(classifyTool('exec')).toBe('command');
    expect(classifyTool('find')).toBe('search');
    expect(classifyTool('preview_logs')).toBe('preview');
    expect(classifyTool('Agent')).toBe('agent');
    expect(classifyTool('WebSearch')).toBe('web');
    expect(classifyTool('TaskCreate')).toBe('task');
    expect(classifyTool('mcp__baios__fs_read')).toBe('read');
    expect(classifyTool('run pnpm test')).toBe('command');
    expect(classifyTool('something_new')).toBe('other');
  });

  it('says what a call did, in the tense its status calls for', () => {
    expect(describeTool('fs_read', { path: 'src/App.tsx' }, 'running')).toMatchObject({
      target: 'src/App.tsx',
      verb: 'Reading',
    });
    expect(
      describeTool('fs_edit', { path: 'a.ts', replace: 'b', search: 'a' }, 'done'),
    ).toMatchObject({
      target: 'a.ts',
      verb: 'Edited',
    });
    expect(describeTool('fs_edit', { content: 'x', path: 'a.ts' }, 'done').verb).toBe('Wrote');
    expect(
      describeTool('exec', { command: 'pnpm install --frozen-lockfile' }, 'running'),
    ).toMatchObject({
      target: 'pnpm install --frozen-lockfile',
      verb: 'Running pnpm',
    });
    expect(describeTool('search', { path: 'src', text: 'useState' }, 'done')).toMatchObject({
      target: '"useState" in src',
      verb: 'Searched for',
    });
    expect(describeTool('Agent', { description: 'Audit the styles' }, 'running')).toMatchObject({
      target: 'Audit the styles',
      verb: 'Delegating to a subagent',
    });
    expect(describeTool('mystery', {}, 'done')).toMatchObject({ target: 'mystery', verb: 'Used' });
  });

  it('unwraps a shell-wrapped command to its first line', () => {
    expect(commandText(`bash -lc "npm run build"`)).toBe('npm run build');
    expect(commandText('a\nb')).toBe('a');
  });

  it('reads an exec exit status and a subscription tool failure out of the output', () => {
    expect(readOutput('exit 0\nok')).toEqual({ exitCode: 0, failed: false, text: 'ok' });
    expect(readOutput('exit 2\nboom')).toEqual({ exitCode: 2, failed: true, text: 'boom' });
    expect(readOutput({ ok: false, summary: 'not found' })).toEqual({
      failed: true,
      text: 'not found',
    });
    expect(readOutput(undefined)).toEqual({ failed: false, text: '' });
  });

  it('counts changed lines, not file headers', () => {
    expect(diffStat('--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-a\n+b\n+c\n')).toEqual({
      added: 2,
      removed: 1,
    });
  });
});
