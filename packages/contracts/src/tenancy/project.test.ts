import { describe, expect, it } from 'vitest';

import {
  createProjectRequestSchema,
  projectSummarySchema,
  renameProjectRequestSchema,
} from './project';
import { containerNameSchema, createWorkspaceRequestSchema } from './workspace';

/**
 * The request schemas spec 007 added. `containerNameSchema` is shared by all four, so its edges
 * are asserted once and the request schemas are asserted for what is theirs alone: the template
 * default and strictness.
 */
describe('containerNameSchema', () => {
  it('trims', () => {
    expect(containerNameSchema.parse('  Landing page  ')).toBe('Landing page');
  });

  it('refuses a whitespace-only name, because trimming leaves nothing', () => {
    expect(containerNameSchema.safeParse('   ').success).toBe(false);
  });

  it('accepts 120 characters and refuses 121', () => {
    expect(containerNameSchema.safeParse('a'.repeat(120)).success).toBe(true);
    expect(containerNameSchema.safeParse('a'.repeat(121)).success).toBe(false);
  });
});

describe('createProjectRequestSchema', () => {
  it('defaults the template to vite-react', () => {
    expect(createProjectRequestSchema.parse({ name: 'Shop' })).toEqual({
      name: 'Shop',
      template: 'vite-react',
    });
  });

  it('refuses a template outside the catalogue', () => {
    expect(createProjectRequestSchema.safeParse({ name: 'Shop', template: 'rails' }).success).toBe(
      false,
    );
  });

  it('stays strict', () => {
    expect(createProjectRequestSchema.safeParse({ name: 'Shop', workspaceId: 'x' }).success).toBe(
      false,
    );
  });
});

describe('rename and workspace requests', () => {
  it.each([renameProjectRequestSchema, createWorkspaceRequestSchema])(
    'take a name and nothing else',
    (schema) => {
      expect(schema.parse({ name: ' Ops ' })).toEqual({ name: 'Ops' });
      expect(schema.safeParse({ name: 'Ops', template: 'vite-react' }).success).toBe(false);
    },
  );
});

describe('projectSummarySchema (022)', () => {
  const summary = {
    createdAt: '2026-09-14T10:00:00.000Z',
    id: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a',
    name: 'Shop',
    permissions: ['agent.run'],
  };

  it('carries the caller’s permissions', () => {
    expect(projectSummarySchema.parse(summary)).toEqual(summary);
    expect(projectSummarySchema.parse({ ...summary, permissions: [] }).permissions).toEqual([]);
  });

  it('refuses a summary without them — absent must not read as "may do nothing"', () => {
    const withoutPermissions: Record<string, unknown> = { ...summary };
    delete withoutPermissions.permissions;

    expect(projectSummarySchema.safeParse(withoutPermissions).success).toBe(false);
  });
});
