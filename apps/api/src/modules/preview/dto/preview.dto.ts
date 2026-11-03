import {
  authorizePreviewResponseSchema,
  previewResponseSchema,
  rotatePreviewResponseSchema,
  setPreviewVisibilityRequestSchema,
} from '@repo/contracts';
import { z } from 'zod';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** `GET …/preview` (contracts § 2): the preview's address, port and visibility — never the label. */
@ApiZodSchema()
export class PreviewResponseDto extends createZodDto(previewResponseSchema) {}

/** `POST …/preview/rotate` (contracts § 2): the fresh address, the same port, and a status word. */
@ApiZodSchema()
export class RotatePreviewResponseDto extends createZodDto(rotatePreviewResponseSchema) {}

/** `PUT …/preview/visibility` (contracts § 2): who may reach the preview from now on. */
@ApiZodSchema()
export class SetPreviewVisibilityRequestDto extends createZodDto(
  setPreviewVisibilityRequestSchema,
) {}

/**
 * `POST preview/authorize` (contracts § 2): the label the gateway bounced with and the preview host
 * to return to. Local to the API rather than `@repo/contracts` because the web page posts what the
 * gateway's redirect gave it, verbatim; the host's grammar is the service's check, not the DTO's.
 */
export const previewAuthorizeRequestSchema = z.strictObject({
  label: z.string().regex(/^[0-9a-f]{20,64}$/),
  // The whole authority, not just a hostname prefix: `<label>-<port>.<domain>[:port]` and nothing
  // that `new URL` could read as userinfo, a path or a second host.
  returnHost: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(/^[0-9a-f]{20,64}-\d{4,5}\.[a-z0-9.-]+(:\d{1,5})?$/i),
});

@ApiZodSchema()
export class PreviewAuthorizeRequestDto extends createZodDto(previewAuthorizeRequestSchema) {}

/** `POST preview/authorize`'s answer: the preview URL carrying the code, for the page to follow. */
@ApiZodSchema()
export class AuthorizePreviewResponseDto extends createZodDto(authorizePreviewResponseSchema) {}
