import { DomainError } from '../../../common/errors/domain-error';

/** The type is not allowed, the bytes disagree with it, or the archive cannot be read safely. */
export class AttachmentRejectedError extends DomainError {
  constructor(detail: string) {
    super('attachment-rejected', detail);
  }
}

/** Past `maxBytesFor(kind)`; the upload is cut off and nothing is stored. */
export class AttachmentTooLargeError extends DomainError {
  constructor(maxBytes: number) {
    super('attachment-too-large', `A file of this type can be at most ${formatMiB(maxBytes)}.`, {
      maxBytes,
    });
  }
}

/** Not an attachment of this project — another org's, another project's, or gone alike. */
export class AttachmentNotFoundError extends DomainError {
  constructor() {
    super('attachment-not-found', 'No such attachment in this project.');
  }
}

function formatMiB(bytes: number): string {
  return `${String(Math.round(bytes / (1024 * 1024)))} MiB`;
}
