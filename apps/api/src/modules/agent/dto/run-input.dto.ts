import { runInputRequestSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** The body of `POST …/runs/:runId/input` (US4); the run must be `awaiting_input`. */
@ApiZodSchema()
export class RunInputDto extends createZodDto(runInputRequestSchema) {}
