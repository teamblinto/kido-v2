import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { ValidationIssue } from '@repo/contracts';
import type { ZodError } from 'zod';

import { ValidationFailedError } from './validation-failed.error';
import { isZodDto } from './zod-dto';

/**
 * The one place an inbound value becomes a trusted one.
 *
 * It is registered globally and decides what to do from the `metatype` alone: a parameter typed as
 * a `createZodDto` class is parsed against that class's schema, and anything else — a `@Param('id')
 * id: string`, a route with no DTO — passes through untouched. There is no per-route decorator to
 * forget, which is the property the `ValidationPipe` it replaces also had and the reason this is a
 * pipe rather than a helper controllers call.
 *
 * Two behaviours are inherited from that pipe deliberately, and both are now decisions the *schema*
 * makes rather than global flags:
 *
 * - `whitelist` — the parsed output is returned, not the input, so a plain `z.object` strips keys it
 *   does not declare and the controller can never see one.
 * - `forbidNonWhitelisted` — a `z.strictObject` rejects them instead, with one `errors` entry per
 *   offending key. Every request schema in `@repo/contracts` is strict, so this is the live
 *   behaviour; the stripping path exists for the response and internal shapes that are not strict.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform<unknown, unknown> {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const { metatype } = metadata;

    if (!isZodDto(metatype)) {
      return value;
    }

    const result = metatype.zodSchema.safeParse(value);

    if (!result.success) {
      throw new ValidationFailedError(metadata.type, toValidationIssues(result.error));
    }

    return result.data;
  }
}

/**
 * Zod reports every unrecognised key of an object as a single issue whose path is the *object*.
 * That would collapse to one pointer at the parent, so it is expanded into one entry per key: the
 * client asked which fields are wrong, and "one of the keys of this object" is not an answer.
 */
export function toValidationIssues(error: ZodError): ValidationIssue[] {
  return error.issues.flatMap((issue): ValidationIssue[] => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        code: issue.code,
        detail: `Unrecognized key: "${key}".`,
        pointer: toJsonPointer([...issue.path, key]),
      }));
    }

    return [{ code: issue.code, detail: issue.message, pointer: toJsonPointer(issue.path) }];
  });
}

/**
 * RFC 6901, which is the form RFC 9457's own `errors` example uses. A failure with no path — a body
 * that is not an object at all — points at the document root.
 */
function toJsonPointer(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (pointer, segment) => `${pointer}/${escapePointerSegment(String(segment))}`,
    '#',
  );
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}
