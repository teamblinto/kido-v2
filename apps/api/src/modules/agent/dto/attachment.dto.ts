import { attachmentSchema, uploadAttachmentQuerySchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** `POST …/projects/:projectId/attachments?name=`: the raw file is the body, the name the query. */
@ApiZodSchema()
export class UploadAttachmentQueryDto extends createZodDto(uploadAttachmentQuerySchema) {}

/** One stored attachment, as the upload answers it. */
@ApiZodSchema()
export class AttachmentDto extends createZodDto(attachmentSchema) {}
