import {
  type Attachment,
  type AttachmentKind,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentTypeFor,
} from '@repo/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { messageFor } from '@/lib/api/problem';
import { deleteAttachment } from '../api';
import {
  AttachmentRefusal,
  type UploadOptions,
  prepareAttachmentFile,
  uploadAttachment,
} from '../lib/attachment-upload';

export type PendingStatus = 'failed' | 'preparing' | 'ready' | 'uploading';

/** A file in the composer, from the moment it is added until the message carrying it is sent. */
export interface PendingAttachment {
  readonly attachment?: Attachment;
  readonly error?: string;
  readonly file: File;
  readonly kind: AttachmentKind | undefined;
  readonly localId: string;
  readonly name: string;
  /** An object URL for a raster image's thumbnail; revoked when the chip goes. */
  readonly previewUrl?: string;
  /** 0…1 while uploading. */
  readonly progress: number;
  /** A refusal decided here (type, size) would fail again; a network or server one may not. */
  readonly retryable: boolean;
  readonly size: number;
  readonly status: PendingStatus;
}

export type UploadFn = (
  orgId: string,
  projectId: string,
  file: File,
  options: UploadOptions,
) => Promise<Attachment>;

/** Uploads in flight at once; the rest wait their turn. */
const MAX_CONCURRENT_UPLOADS = 3;

let nextId = 0;

const objectUrl = (file: File): string | undefined =>
  typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;

const revoke = (item: PendingAttachment): void => {
  if (item.previewUrl !== undefined) URL.revokeObjectURL(item.previewUrl);
};

/**
 * The composer's attachments (spec 048): each file is checked at once, then prepared (a large
 * image scaled down) and uploaded eagerly, three at a time, so Send only waits for what is left.
 */
export function useComposerAttachments(
  orgId: string | undefined,
  projectId: string,
  upload: UploadFn = uploadAttachment,
) {
  const [items, setItems] = useState<readonly PendingAttachment[]>([]);
  const [notice, setNotice] = useState<string>();
  // The source of truth, read synchronously so two adds in one tick both respect the cap.
  const current = useRef<readonly PendingAttachment[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const slots = useRef({ active: 0, waiting: [] as (() => void)[] });

  const commit = useCallback((next: readonly PendingAttachment[]) => {
    current.current = next;
    setItems(next);
  }, []);

  const patch = useCallback(
    (localId: string, change: Partial<PendingAttachment>) => {
      commit(
        current.current.map((item) => (item.localId === localId ? { ...item, ...change } : item)),
      );
    },
    [commit],
  );

  const process = useCallback(
    async (localId: string, original: File) => {
      const controller = new AbortController();
      controllers.current.set(localId, controller);
      const { signal } = controller;
      let holdsSlot = false;

      try {
        const { file } = await prepareAttachmentFile(original);

        if (signal.aborted) return;
        if (orgId === undefined) throw new Error('The organisation is not known yet.');

        if (slots.current.active < MAX_CONCURRENT_UPLOADS) {
          slots.current.active += 1;
        } else {
          await new Promise<void>((resolve) => slots.current.waiting.push(resolve));
        }

        holdsSlot = true;

        if (signal.aborted) return;
        patch(localId, { progress: 0, size: file.size, status: 'uploading' });

        const attachment = await upload(orgId, projectId, file, {
          onProgress: (progress) => {
            patch(localId, { progress });
          },
          signal,
        });

        if (signal.aborted) {
          // Removed while the last bytes were on their way: drop what landed, best-effort.
          deleteAttachment(orgId, projectId, attachment.id).catch(() => undefined);

          return;
        }

        patch(localId, { attachment, progress: 1, status: 'ready' });
      } catch (error) {
        if (signal.aborted) return;
        patch(localId, {
          error:
            error instanceof AttachmentRefusal
              ? error.message
              : messageFor(error, 'The upload failed. Try again.'),
          retryable: !(error instanceof AttachmentRefusal),
          status: 'failed',
        });
      } finally {
        if (holdsSlot) {
          const next = slots.current.waiting.shift();

          if (next === undefined) slots.current.active -= 1;
          else next();
        }

        if (controllers.current.get(localId) === controller) controllers.current.delete(localId);
      }
    },
    [orgId, patch, projectId, upload],
  );

  const add = useCallback(
    (files: Iterable<File>) => {
      const incoming = [...files];
      const room = MAX_ATTACHMENTS_PER_MESSAGE - current.current.length;
      const accepted = incoming.slice(0, Math.max(0, room));

      setNotice(
        accepted.length < incoming.length
          ? `A message can carry at most ${String(MAX_ATTACHMENTS_PER_MESSAGE)} files; ${String(incoming.length - accepted.length)} not added.`
          : undefined,
      );

      const added = accepted.map((file): PendingAttachment => {
        nextId += 1;
        const type = attachmentTypeFor(file.name);
        const isRaster = type?.kind === 'image';
        const previewUrl = isRaster ? objectUrl(file) : undefined;

        return {
          ...(type === null ? { error: "This file type isn't supported." } : {}),
          file,
          kind: type?.kind,
          localId: `a-${String(nextId)}`,
          name: file.name,
          ...(previewUrl === undefined ? {} : { previewUrl }),
          progress: 0,
          retryable: type !== null,
          size: file.size,
          status: type === null ? 'failed' : 'preparing',
        };
      });

      commit([...current.current, ...added]);

      for (const item of added) {
        if (item.status === 'preparing') void process(item.localId, item.file);
      }
    },
    [commit, process],
  );

  const remove = useCallback(
    (localId: string) => {
      const item = current.current.find((entry) => entry.localId === localId);

      if (item === undefined) return;

      controllers.current.get(localId)?.abort();
      revoke(item);
      setNotice(undefined);
      commit(current.current.filter((entry) => entry.localId !== localId));

      if (item.attachment !== undefined && orgId !== undefined) {
        deleteAttachment(orgId, projectId, item.attachment.id).catch(() => undefined);
      }
    },
    [commit, orgId, projectId],
  );

  const retry = useCallback(
    (localId: string) => {
      const item = current.current.find((entry) => entry.localId === localId);

      if (item?.status !== 'failed' || !item.retryable) return;

      commit(
        current.current.map((entry) =>
          entry.localId === localId
            ? { ...entry, error: undefined, progress: 0, status: 'preparing' as const }
            : entry,
        ),
      );
      void process(localId, item.file);
    },
    [commit, process],
  );

  /** Take every chip out of the composer for a send; `restore` puts them back if it is refused. */
  const take = useCallback((): readonly PendingAttachment[] => {
    const taken = current.current;
    commit([]);
    setNotice(undefined);

    return taken;
  }, [commit]);

  const restore = useCallback(
    (taken: readonly PendingAttachment[]) => {
      // Nothing is cut: files added while the send was in flight stay too, and an over-limit
      // composer blocks Send with a notice, so the person picks what to drop.
      commit([...taken, ...current.current]);
    },
    [commit],
  );

  /** The send went through: the thumbnails' object URLs are no longer needed. */
  const release = useCallback((taken: readonly PendingAttachment[]) => {
    taken.forEach(revoke);
  }, []);

  useEffect(() => {
    const inFlight = controllers.current;

    return () => {
      inFlight.forEach((controller) => {
        controller.abort();
      });
      current.current.forEach(revoke);
    };
  }, []);

  const overBy = items.length - MAX_ATTACHMENTS_PER_MESSAGE;

  return useMemo(
    () => ({
      add,
      hasFailed: items.some((item) => item.status === 'failed'),
      isBusy: items.some((item) => item.status === 'preparing' || item.status === 'uploading'),
      isFull: overBy >= 0,
      isOver: overBy > 0,
      items,
      notice:
        overBy > 0
          ? `A message can carry at most ${String(MAX_ATTACHMENTS_PER_MESSAGE)} files; remove ${String(overBy)} to send.`
          : notice,
      ready: items.flatMap((item) => (item.attachment === undefined ? [] : [item.attachment])),
      release,
      remove,
      restore,
      retry,
      take,
    }),
    [add, items, notice, overBy, release, remove, restore, retry, take],
  );
}

export type ComposerAttachments = ReturnType<typeof useComposerAttachments>;
