import { describe, expect, it } from 'vitest';

import { toInputSchema } from './tool-schema';

describe('toInputSchema', () => {
  it('passes a schema with a root type through verbatim', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };

    expect(toInputSchema(schema)).toBe(schema);
  });

  it('adds type object to a schema with none', () => {
    expect(toInputSchema({ properties: { path: { type: 'string' } } })).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
    });
  });

  it('flattens a root anyOf: every branch property, required only where every branch requires it', () => {
    // `z.toJSONSchema` of a union (`fs_edit`): a root `anyOf`, no root `type`, which the
    // provider APIs refuse ("input_schema does not support oneOf, allOf, or anyOf at the top level").
    expect(
      toInputSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        anyOf: [
          {
            type: 'object',
            properties: { content: { type: 'string' }, path: { type: 'string' } },
            required: ['content', 'path'],
          },
          {
            type: 'object',
            properties: { path: { type: 'string' }, search: { type: 'string' } },
            required: ['path', 'search'],
          },
        ],
      }),
    ).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        content: { type: 'string' },
        path: { type: 'string' },
        search: { type: 'string' },
      },
      required: ['path'],
    });
  });
});
