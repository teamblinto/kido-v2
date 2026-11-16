import type { AttachmentKind } from '@repo/contracts';

/**
 * What the agent loop needs from chat attachments (spec 048): which files each message carried,
 * and their bytes on demand. `AttachmentService` implements it; the executor and the prompt
 * builder depend only on this port.
 */
export const ATTACHMENT_READER = Symbol('ATTACHMENT_READER');

export interface StoredAttachment {
  readonly extractedText: string | null;
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly mimeType: string;
  readonly name: string;
  readonly objectKey: string;
  readonly projectId: string;
  readonly sizeBytes: number;
}

export interface AttachmentReaderPort {
  /** The bytes of one attachment; throws when the object is gone. */
  bytes(attachment: StoredAttachment): Promise<Buffer>;
  /** Message id → its attachments in sent order; messages with none are absent. */
  forMessages(
    orgId: string,
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly StoredAttachment[]>>;
}
