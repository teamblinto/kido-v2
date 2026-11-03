import type { ArgumentMetadata, Paramtype } from '@nestjs/common';
import { cursorPageQuerySchema, emailSchema, passwordSchema } from '@repo/contracts';
import { z } from 'zod';

import { ValidationFailedError } from './validation-failed.error';
import { createZodDto } from './zod-dto';
import { ZodValidationPipe } from './zod-validation.pipe';

const strictSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  profile: z.object({ displayName: z.string().min(1) }).optional(),
  tags: z.array(z.string().min(1)).optional(),
});

class StrictDto extends createZodDto(strictSchema) {}
class StrippingDto extends createZodDto(z.object({ email: emailSchema })) {}
class AwkwardKeysDto extends createZodDto(
  z.strictObject({ 'a/b': z.string(), 'c~d': z.string() }),
) {}
class PageQueryDto extends createZodDto(cursorPageQuerySchema) {}

class PlainDto {
  email!: string;
}

function metadataFor(metatype: unknown, type: Paramtype = 'body'): ArgumentMetadata {
  return { data: undefined, metatype: metatype as ArgumentMetadata['metatype'], type };
}

function expectRejection(value: unknown, metadata: ArgumentMetadata): ValidationFailedError {
  try {
    pipe.transform(value, metadata);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationFailedError);

    return error as ValidationFailedError;
  }

  throw new Error('Expected the pipe to reject the value.');
}

let pipe: ZodValidationPipe;

beforeEach(() => {
  pipe = new ZodValidationPipe();
});

describe('ZodValidationPipe', () => {
  describe('when the parameter is not a contract DTO', () => {
    it.each([
      ['an untyped parameter', undefined],
      ['a primitive route parameter', String],
      ['a class that carries no schema', PlainDto],
    ])('passes %s through untouched', (_label, metatype) => {
      const value = { anything: 'at all' };

      expect(pipe.transform(value, metadataFor(metatype))).toBe(value);
    });
  });

  describe('when the value is valid', () => {
    it('returns the parsed output rather than the input', () => {
      const parsed = pipe.transform(
        { email: '  Ada@Example.COM  ', password: 'correct horse battery' },
        metadataFor(StrictDto),
      );

      expect(parsed).toStrictEqual({
        email: 'ada@example.com',
        password: 'correct horse battery',
      });
    });

    it('coerces the text a query string carries', () => {
      expect(pipe.transform({ limit: '50' }, metadataFor(PageQueryDto, 'query'))).toStrictEqual({
        limit: 50,
      });
    });
  });

  /**
   * The two halves of the `whitelist` / `forbidNonWhitelisted` behaviour being replaced. They are
   * now the schema's decision, so both are asserted against a schema that makes it.
   */
  describe('unknown keys', () => {
    it('strips them when the schema declares no opinion', () => {
      expect(
        pipe.transform(
          { email: 'ada@example.com', isAdmin: true, role: 'owner' },
          metadataFor(StrippingDto),
        ),
      ).toStrictEqual({ email: 'ada@example.com' });
    });

    it('rejects them when the schema is strict, naming each one separately', () => {
      const error = expectRejection(
        {
          email: 'ada@example.com',
          isAdmin: true,
          password: 'correct horse battery',
          role: 'owner',
        },
        metadataFor(StrictDto),
      );

      expect(error.issues).toStrictEqual([
        { code: 'unrecognized_keys', detail: 'Unrecognized key: "isAdmin".', pointer: '#/isAdmin' },
        { code: 'unrecognized_keys', detail: 'Unrecognized key: "role".', pointer: '#/role' },
      ]);
    });
  });

  describe('when the value is rejected', () => {
    it('reports the validation-failed problem type', () => {
      const error = expectRejection({}, metadataFor(StrictDto));

      expect(error.type).toBe('validation-failed');
      expect(error.status).toBe(422);
      expect(error.detail).toBe('The request body failed validation.');
    });

    it('gives every rejected field its own JSON Pointer', () => {
      const error = expectRejection(
        {
          email: 'not-an-address',
          password: 'short',
          profile: { displayName: '' },
          tags: ['ok', ''],
        },
        metadataFor(StrictDto),
      );

      expect(error.issues.map((issue) => issue.pointer)).toStrictEqual([
        '#/email',
        '#/password',
        '#/profile/displayName',
        '#/tags/1',
      ]);
    });

    it('carries a machine-readable code beside the human-readable message', () => {
      const error = expectRejection(
        { email: 'ada@example.com', password: 'short' },
        metadataFor(StrictDto),
      );

      expect(error.issues[0]).toStrictEqual({
        code: 'too_small',
        detail: 'Too small: expected string to have >=12 characters',
        pointer: '#/password',
      });
    });

    it('escapes the RFC 6901 characters a field name can contain', () => {
      const error = expectRejection({}, metadataFor(AwkwardKeysDto));

      expect(error.issues.map((issue) => issue.pointer)).toStrictEqual(['#/a~1b', '#/c~0d']);
    });

    it('points at the document root when the value is not an object at all', () => {
      const error = expectRejection('not json', metadataFor(StrictDto));

      expect(error.issues).toStrictEqual([
        {
          code: 'invalid_type',
          detail: 'Invalid input: expected object, received string',
          pointer: '#',
        },
      ]);
    });

    it('names the query string when that is what failed', () => {
      const error = expectRejection({ limit: '500' }, metadataFor(PageQueryDto, 'query'));

      expect(error.detail).toBe('The request query parameters failed validation.');
      expect(error.issues[0]?.pointer).toBe('#/limit');
    });
  });
});
