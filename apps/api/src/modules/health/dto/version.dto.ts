import { versionResponseSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** `GET /api/v1/version`: which build is running (spec 025 § contracts 4). */
@ApiZodSchema()
export class VersionResponseDto extends createZodDto(versionResponseSchema) {}
