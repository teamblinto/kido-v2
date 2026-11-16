import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Attachment } from '@repo/contracts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { DomainError } from '../../../common/errors/domain-error';
import { OwnsTenantTransaction } from '../../../database/tenant-context.interceptor';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { AttachmentService } from '../attachments/attachment.service';
import { AttachmentDto, UploadAttachmentQueryDto } from '../dto/attachment.dto';

/** Raster images and PDFs render in the browser; everything else (SVG, HTML above all) downloads. */
const INLINE_KINDS = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

/** A body this route reads itself; `rawBody` is set only when a JSON or form parser took it first. */
type UploadRequest = IncomingMessage & { rawBody?: Buffer };

/**
 * Chat attachments (spec 048). The upload takes the raw file as the body — no multipart parser is
 * installed and none is added — and reads the request stream itself under the type's cap. Send it
 * as `application/octet-stream`: the JSON and form parsers ignore that type, and when a client
 * sends one they do match, the bytes they kept on `rawBody` are read instead. CSRF is the header
 * token, so a raw body passes it like any other. An `Idempotency-Key` fingerprints the method, path
 * and name only (the bytes are not a parsed body), so a client sends a fresh key per file.
 */
@ApiTags('agent')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/attachments', version: '1' })
export class AttachmentsController {
  constructor(@Inject(AttachmentService) private readonly attachments: AttachmentService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('project:agent.run')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @OwnsTenantTransaction()
  @ApiOperation({ summary: 'Upload a file to attach to a message' })
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { format: 'binary', type: 'string' } })
  @ApiResponse({ status: 201, type: AttachmentDto })
  async upload(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Query() query: UploadAttachmentQueryDto,
    @Req() req: UploadRequest,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<Attachment> {
    // One upload per connection: a refused body is not drained, the connection closes after the
    // problem response instead.
    res.setHeader('Connection', 'close');
    // No transaction is open while the body streams (`@OwnsTenantTransaction`); this bounds memory
    // and the request slot a stalled client could hold.
    req.setTimeout(120_000, () => req.destroy());

    // A parser took the body and kept no copy (an app built without `rawBody`): nothing left to read.
    if (req.rawBody === undefined && req.readableEnded) {
      throw new DomainError('unsupported-media-type', 'Send the file as application/octet-stream.');
    }

    const length = Number.parseInt(req.headers['content-length'] ?? '', 10);

    return this.attachments.upload(
      orgId,
      projectId,
      caller.userId,
      query.name,
      req.rawBody === undefined ? req : Readable.from([req.rawBody]),
      Number.isNaN(length) ? undefined : length,
    );
  }

  @Get(':attachmentId/content')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Download an attachment' })
  async content(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const { attachment, body } = await this.attachments.content(orgId, projectId, attachmentId);
    const inline = INLINE_KINDS.has(attachment.mimeType);

    res.statusCode = HttpStatus.OK;
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; ${contentDispositionName(attachment.name)}`,
    );
    res.setHeader('Content-Length', body.length);
    // Chrome will not run its PDF viewer under a sandbox CSP, and helmet's default (object-src
    // 'none') can block it too, so a PDF goes without one; nosniff still pins its type.
    if (attachment.mimeType === 'application/pdf') res.removeHeader('Content-Security-Policy');
    else res.setHeader('Content-Security-Policy', 'sandbox');
    // Helmet's `same-origin` would block the web app's <img> thumbnails from a sibling origin.
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader(
      'Content-Type',
      attachment.kind === 'text' ? `${attachment.mimeType}; charset=utf-8` : attachment.mimeType,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('project:agent.run')
  @ApiOperation({ summary: 'Remove an attachment that has not been sent' })
  async remove(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<void> {
    await this.attachments.deletePending(orgId, projectId, attachmentId);
  }
}

/** `filename="<ASCII fallback>"; filename*=UTF-8''<RFC 5987>`, so no name can break the header. */
export function contentDispositionName(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
