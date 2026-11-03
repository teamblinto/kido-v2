import { Body, Controller, Post } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { cursorPageQuerySchema, emailSchema, passwordSchema } from '@repo/contracts';
import { z } from 'zod';

import { ApiZodSchema, createZodDto, isZodDto } from './zod-dto';

const signupSchema = z.strictObject({
  email: emailSchema,
  invitedBy: emailSchema.optional(),
  password: passwordSchema,
  profile: z.object({ displayName: z.string().min(1) }).optional(),
});

@ApiZodSchema()
class SignupFixtureDto extends createZodDto(signupSchema) {}

@ApiZodSchema()
class PageQueryFixtureDto extends createZodDto(cursorPageQuerySchema) {}

class UndecoratedDto extends createZodDto(signupSchema) {}

@Controller({ path: 'zod-dto-fixtures' })
class ZodDtoFixtureController {
  @Post()
  create(@Body() body: SignupFixtureDto): SignupFixtureDto {
    return body;
  }
}

interface DocumentShape {
  components?: { schemas?: Record<string, unknown> };
  paths: Record<
    string,
    { post?: { requestBody?: { content?: Record<string, { schema?: unknown }> } } }
  >;
}

const expectedSignupSchema = z.toJSONSchema(signupSchema, {
  io: 'input',
  reused: 'inline',
  target: 'openapi-3.0',
});

async function buildOpenApiDocument(): Promise<DocumentShape> {
  const module = await Test.createTestingModule({
    controllers: [ZodDtoFixtureController],
  }).compile();
  const app = module.createNestApplication();

  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Fixture').setVersion('1.0').build(),
    ) as unknown as DocumentShape;
  } finally {
    await app.close();
  }
}

describe('createZodDto', () => {
  it('hands the schema back for the pipe to find, through the subclass', () => {
    expect(SignupFixtureDto.zodSchema).toBe(signupSchema);
    expect(PageQueryFixtureDto.zodSchema).toBe(cursorPageQuerySchema);
  });

  /**
   * The reason for the `extends` shape. If this ever regresses to `Object`, Nest hands the pipe no
   * metatype, the pipe finds no schema, and every body reaches its controller unvalidated — a
   * silent failure that no behavioural test of a *valid* request would catch.
   */
  it('leaves a paramtype Nest can resolve the schema from', () => {
    const paramtypes: unknown = Reflect.getMetadata(
      'design:paramtypes',
      ZodDtoFixtureController.prototype,
      'create',
    );

    expect(paramtypes).toStrictEqual([SignupFixtureDto]);
  });
});

describe('isZodDto', () => {
  it('recognises the classes this factory produces', () => {
    expect(isZodDto(SignupFixtureDto)).toBe(true);
    expect(isZodDto(PageQueryFixtureDto)).toBe(true);
  });

  it.each([
    ['a primitive constructor', String],
    ['a plain class', class Plain {}],
    [
      'a class whose static is not a schema',
      class Fake {
        static zodSchema = 'nope';
      },
    ],
    ['a schema that is not a class', signupSchema],
    ['undefined', undefined],
    ['null', null],
  ])('rejects %s', (_label, candidate) => {
    expect(isZodDto(candidate)).toBe(false);
  });
});

describe('ApiZodSchema', () => {
  it('refuses a class that carries no schema, rather than publishing an empty component', () => {
    expect(() => {
      ApiZodSchema()(class NotADto {});
    }).toThrow(TypeError);
  });
});

/**
 * The acceptance criterion, asserted rather than assumed: Swagger still generates, and what it
 * generates is the Zod schema.
 *
 * The mechanism — `SchemaObjectFactory` spreading `@ApiSchema` options over a component it has no
 * `@ApiProperty` members to build — is load-bearing and undocumented, so it is pinned here. If a
 * `@nestjs/swagger` upgrade changes the merge order this fails, instead of silently publishing
 * `{ type: 'object', properties: {} }` for every request body in the API.
 */
describe('the generated OpenAPI document', () => {
  it('publishes the Zod-derived schema verbatim as a named component', async () => {
    const document = await buildOpenApiDocument();

    expect(document.components?.schemas?.SignupFixtureDto).toStrictEqual(expectedSignupSchema);
  });

  it('keeps the constraints a client needs, not just the field names', () => {
    expect(expectedSignupSchema).toStrictEqual({
      additionalProperties: false,
      properties: {
        email: {
          description:
            'An email address. Surrounding whitespace is trimmed and the value is lower-cased.',
          format: 'email',
          maxLength: 254,
          type: 'string',
        },
        invitedBy: {
          description:
            'An email address. Surrounding whitespace is trimmed and the value is lower-cased.',
          format: 'email',
          maxLength: 254,
          type: 'string',
        },
        password: {
          description:
            'A candidate password. Length only — strength and breach checks run server-side and ' +
            'reject separately.',
          maxLength: 128,
          minLength: 12,
          type: 'string',
        },
        profile: {
          properties: { displayName: { minLength: 1, type: 'string' } },
          required: ['displayName'],
          type: 'object',
        },
      },
      required: ['email', 'password'],
      type: 'object',
    });
  });

  it('references the component from the request body of the route that uses it', async () => {
    const document = await buildOpenApiDocument();
    const path = Object.keys(document.paths).find((candidate) =>
      candidate.includes('zod-dto-fixtures'),
    );

    expect(path).toBeDefined();
    expect(
      document.paths[path ?? '']?.post?.requestBody?.content?.['application/json']?.schema,
    ).toStrictEqual({ $ref: '#/components/schemas/SignupFixtureDto' });
  });

  /**
   * The decorator is separable from the base class, so it is possible to forget it. That costs
   * documentation, never validation — the schema still reaches the pipe through the static.
   */
  it('still validates a DTO whose schema was never published', () => {
    expect(isZodDto(UndecoratedDto)).toBe(true);
  });
});
