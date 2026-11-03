import { ApiSchema } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';

/**
 * The base class `createZodDto` produces. It is newable so `@Body() body: SignupDto` types as the
 * parsed output, and it carries the schema as a static so `ZodValidationPipe` can find it from the
 * `metatype` Nest hands every pipe — which is what makes that pipe global and zero-configuration
 * instead of a decorator every route has to remember.
 */
export interface ZodDtoClass<TSchema extends ZodType<object> = ZodType<object>> {
  new (): z.output<TSchema>;
  readonly zodSchema: TSchema;
}

/**
 * Build the base class for a request DTO.
 *
 * ```ts
 * @ApiZodSchema()
 * export class SignupDto extends createZodDto(signupSchema) {}
 * ```
 *
 * The `extends` is not a style choice. Nest resolves a parameter's DTO from `design:paramtypes`,
 * and that metadata only names a real class declaration — a `const SignupDto = createZodDto(...)`
 * paired with a type alias serialises to `Object`, at which point the pipe sees no schema and every
 * body passes through unvalidated. A named subclass is the only shape that survives the emit.
 */
export function createZodDto<TSchema extends ZodType<object>>(
  schema: TSchema,
): ZodDtoClass<TSchema> {
  class ZodDto {
    static readonly zodSchema: TSchema = schema;
  }

  return ZodDto as unknown as ZodDtoClass<TSchema>;
}

/**
 * Publish a `createZodDto` subclass's schema into the OpenAPI document, as a component named after
 * the class.
 *
 * It is a separate decorator rather than something `createZodDto` could do itself because
 * `@nestjs/swagger` reads schema metadata with `Reflect.getOwnMetadata`: metadata defined on the
 * base class is invisible from the subclass, and the subclass is the only class that has a usable
 * name. Applying it here also means the component is named by the declaration a reader is looking
 * at rather than by a string argument that can drift from it.
 */
export function ApiZodSchema(): ClassDecorator {
  return (target) => {
    if (!isZodDto(target)) {
      throw new TypeError(
        `@ApiZodSchema() on "${target.name}", which does not extend createZodDto(schema).`,
      );
    }

    // `ApiSchemaOptions` documents only `name` and `description`, but `SchemaObjectFactory` spreads
    // everything except `name` over the component it builds, and a `createZodDto` subclass has no
    // `@ApiProperty` members for it to build one from — so the Zod-derived schema lands verbatim,
    // `additionalProperties: false` and nested definitions included. That merge order is
    // load-bearing and undocumented, so `zod-dto.spec.ts` asserts the generated document.
    ApiSchema({ name: target.name, ...toOpenApiSchema(target.zodSchema) })(target);
  };
}

/** Whether a Nest `metatype` is one of ours, and therefore something the pipe must validate. */
export function isZodDto(metatype: unknown): metatype is ZodDtoClass {
  if (typeof metatype !== 'function' || !('zodSchema' in metatype)) {
    return false;
  }

  const { zodSchema } = metatype as { zodSchema: unknown };

  // Structural, not `instanceof ZodType`: `@repo/contracts` carries its own `zod` dependency, and
  // an injected workspace package can end up with a second physical copy of it. A schema built
  // there is still a schema; `instanceof` against this package's copy would say otherwise.
  return (
    typeof zodSchema === 'object' &&
    zodSchema !== null &&
    'safeParse' in zodSchema &&
    typeof zodSchema.safeParse === 'function'
  );
}

/**
 * `io: 'input'` because the document describes what a client sends, and several primitives are
 * pipes whose output differs from their input — a normalising `emailSchema` accepts more than it
 * returns. `reused: 'inline'` keeps `$defs` out of the result, which matters because the component
 * is published as-is and nothing rewrites a `#/$defs/...` reference into a component path.
 *
 * Both `throw` settings are deliberate: a schema that cannot be represented in OpenAPI should fail
 * at import time, where a developer is watching, rather than publish a document that quietly
 * under-describes the endpoint.
 */
function toOpenApiSchema(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    cycles: 'throw',
    io: 'input',
    reused: 'inline',
    target: 'openapi-3.0',
    unrepresentable: 'throw',
  });
}
