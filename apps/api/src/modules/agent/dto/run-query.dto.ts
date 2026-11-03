import { runEventsQuerySchema, runListQuerySchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** `GET …/runs?cursor=&limit=`: newest first, cursor-paged, at most 100. */
@ApiZodSchema()
export class RunListQueryDto extends createZodDto(runListQuerySchema) {}

/** `GET …/runs/:runId/events?after=&limit=`: `seq > after`, ascending, at most 500. */
@ApiZodSchema()
export class RunEventsQueryDto extends createZodDto(runEventsQuerySchema) {}
