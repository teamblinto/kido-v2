import { writeFileRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * `PUT …/files/content` (024 contracts § 2–3). The request is `z.strictObject`, so an undeclared
 * key is a `422 validation-failed` from the application-wide pipe before anything reaches a
 * workspace.
 *
 * There is no response dto beside it. `writeFileResponseSchema` is a discriminated union, and
 * `createZodDto` builds a class from an object schema's statically known members — a union has
 * none. `FilesController` documents `fileContentResponseSchema`, the other union on this prefix,
 * the same way: in the `@ApiResponse` description. The union is still the contract the web parses
 * against; it is only the OpenAPI class that cannot exist.
 */
@ApiZodSchema()
export class WriteFileRequestDto extends createZodDto(writeFileRequestSchema) {}
