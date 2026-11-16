import type { Attachment, AttachmentKind } from '@repo/contracts';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react';
import { useState } from 'react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { PendingAttachment } from '../hooks/use-composer-attachments';
import { formatBytes } from '../lib/attachment-upload';

const KIND_ICONS: Readonly<Record<AttachmentKind, typeof FileIcon>> = {
  archive: FileArchiveIcon,
  document: FileTextIcon,
  image: ImageIcon,
  pdf: FileTextIcon,
  text: FileCodeIcon,
};

function KindIcon({
  className,
  kind,
}: {
  readonly className?: string;
  readonly kind: AttachmentKind | undefined;
}): React.JSX.Element {
  const Icon = kind === undefined ? FileIcon : KIND_ICONS[kind];

  return <Icon className={cn('size-4 shrink-0', className)} aria-hidden="true" />;
}

export interface ViewerImage {
  readonly alt: string;
  readonly src: string;
}

/** An image shown large; arrows (and ←/→) step through the others it came with. Escape closes. */
export function ImageViewer({
  images,
  index,
  onIndexChange,
}: {
  readonly images: readonly ViewerImage[];
  /** The image open, or `undefined` when closed. */
  readonly index: number | undefined;
  readonly onIndexChange: (index: number | undefined) => void;
}): React.JSX.Element {
  const image = index === undefined ? undefined : images[index];
  const many = images.length > 1;
  const step = (by: number): void => {
    if (index !== undefined) onIndexChange((index + by + images.length) % images.length);
  };

  return (
    <Dialog
      open={image !== undefined}
      onOpenChange={(open) => {
        if (!open) onIndexChange(undefined);
      }}
    >
      <DialogContent
        className="max-w-[min(960px,calc(100%-2rem))] items-center gap-3 p-4 pt-16"
        aria-describedby={undefined}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') step(-1);
          if (event.key === 'ArrowRight') step(1);
        }}
      >
        <DialogTitle className="text-label-sm absolute top-[27px] left-5 max-w-[70%] truncate font-medium">
          {image?.alt}
        </DialogTitle>
        {image === undefined ? null : (
          <img
            src={image.src}
            alt={image.alt}
            className="max-h-[calc(100dvh-10rem)] max-w-full rounded-lg object-contain"
          />
        )}
        {many ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Previous image"
              onClick={() => {
                step(-1);
              }}
              className="bg-muted text-subdued hover:bg-secondary hover:text-foreground flex size-8 items-center justify-center rounded-lg"
            >
              <ChevronLeftIcon className="size-4" aria-hidden="true" />
            </button>
            <span className="text-caption text-faint tabular-nums">
              {String((index ?? 0) + 1)} / {String(images.length)}
            </span>
            <button
              type="button"
              aria-label="Next image"
              onClick={() => {
                step(1);
              }}
              className="bg-muted text-subdued hover:bg-secondary hover:text-foreground flex size-8 items-center justify-center rounded-lg"
            >
              <ChevronRightIcon className="size-4" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const chipClass =
  'bg-subtle border-line-subtle relative flex h-16 items-center gap-2 overflow-hidden rounded-lg border';

/** The composer's attachments, above the text box: thumbnails and file chips with their progress. */
export function PendingAttachmentStrip({
  items,
  onRemove,
  onRetry,
}: {
  readonly items: readonly PendingAttachment[];
  readonly onRemove: (localId: string) => void;
  readonly onRetry: (localId: string) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState<number>();
  const [announcement, setAnnouncement] = useState('');
  const [seen, setSeen] = useState(items);
  const images = items.flatMap((item) =>
    item.previewUrl === undefined
      ? []
      : [{ alt: item.name, localId: item.localId, src: item.previewUrl }],
  );

  // Announce only a change into ready or failed, never each progress tick (derived in render).
  if (seen !== items) {
    const before = new Map(seen.map((item) => [item.localId, item.status]));
    const changes = items.flatMap((item) => {
      const was = before.get(item.localId);

      if (item.status === was) return [];
      if (item.status === 'failed') return [`${item.name} failed: ${item.error ?? 'Failed'}`];

      return item.status === 'ready' && was !== undefined ? [`${item.name} uploaded`] : [];
    });

    setSeen(items);
    if (changes.length > 0) setAnnouncement(changes.join('. '));
  }

  if (items.length === 0) return null;

  return (
    <>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <ul aria-label="Attachments" className="flex flex-wrap gap-2">
        {items.map((item) => {
          const failed = item.status === 'failed';
          const busy = item.status === 'preparing' || item.status === 'uploading';
          const imageIndex = images.findIndex((image) => image.localId === item.localId);
          const status = failed
            ? (item.error ?? 'Failed')
            : busy
              ? item.status === 'uploading'
                ? `Uploading ${String(Math.round(item.progress * 100))}%`
                : 'Preparing…'
              : formatBytes(item.size);

          return (
            <li
              key={item.localId}
              title={failed ? item.error : undefined}
              className={cn(
                chipClass,
                imageIndex === -1 ? 'max-w-[220px] pr-8 pl-2.5' : 'w-16 justify-center',
                failed && 'border-danger/60',
              )}
            >
              {imageIndex === -1 ? (
                <>
                  <KindIcon kind={item.kind} className={failed ? 'text-danger' : 'text-subdued'} />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-label-xs text-foreground truncate font-medium">
                      {item.name}
                    </span>
                    <span
                      className={cn('text-caption truncate', failed ? 'text-danger' : 'text-faint')}
                    >
                      {status}
                    </span>
                  </span>
                </>
              ) : (
                <button
                  type="button"
                  aria-label={`View ${item.name}`}
                  onClick={() => {
                    setOpen(imageIndex);
                  }}
                  className="size-full"
                >
                  <img
                    src={images[imageIndex]?.src}
                    alt={item.name}
                    className="size-full object-cover"
                  />
                </button>
              )}
              {imageIndex === -1 ? null : (
                <span className="sr-only">
                  {failed ? `Failed: ${status}` : busy ? status : 'Ready'}
                </span>
              )}

              {busy ? (
                <span
                  role="progressbar"
                  aria-label={`${item.name}: ${status}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(item.progress * 100)}
                  className="pointer-events-none absolute inset-0 flex items-end bg-black/30"
                >
                  {imageIndex === -1 ? null : (
                    <LoaderCircleIcon
                      className="absolute top-1/2 left-1/2 size-4 -translate-1/2 animate-spin text-white"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className="bg-brand h-[3px] transition-[width]"
                    style={{ width: `${String(Math.round(item.progress * 100))}%` }}
                  />
                </span>
              ) : null}

              {failed && item.retryable ? (
                <button
                  type="button"
                  aria-label={`Retry ${item.name}`}
                  title={item.error}
                  onClick={() => {
                    onRetry(item.localId);
                  }}
                  className={cn(
                    'bg-raised/90 text-foreground hover:bg-raised absolute flex size-6 items-center justify-center rounded-md',
                    imageIndex === -1 ? 'right-8 bottom-1' : 'bottom-1 left-1',
                  )}
                >
                  <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                </button>
              ) : null}

              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() => {
                  onRemove(item.localId);
                }}
                className="bg-raised/90 text-subdued hover:text-foreground absolute top-1 right-1 flex size-5 items-center justify-center rounded-full"
              >
                <XIcon className="size-3" aria-hidden="true" />
              </button>
            </li>
          );
        })}
        <ImageViewer images={images} index={open} onIndexChange={setOpen} />
      </ul>
    </>
  );
}

/** What a sent message carried: image thumbnails that open large, and file chips that download. */
export function MessageAttachments({
  attachments,
  contentUrl,
}: {
  readonly attachments: readonly Attachment[];
  readonly contentUrl: (attachmentId: string) => string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState<number>();
  const images = attachments.filter((attachment) => attachment.kind === 'image');
  const files = attachments.filter((attachment) => attachment.kind !== 'image');

  if (attachments.length === 0) return null;

  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
      {images.map((image, index) => (
        <button
          key={image.id}
          type="button"
          aria-label={`View ${image.name}`}
          onClick={() => {
            setOpen(index);
          }}
          className="border-line-subtle size-16 overflow-hidden rounded-lg border"
        >
          <img
            src={contentUrl(image.id)}
            alt={image.name}
            loading="lazy"
            className="size-full object-cover"
          />
        </button>
      ))}
      {files.map((file) => (
        <a
          key={file.id}
          href={contentUrl(file.id)}
          download={file.name}
          // `download` is ignored cross-origin; a new tab keeps the chat when a PDF opens inline.
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            chipClass,
            'hover:bg-muted h-auto max-w-[220px] px-2.5 py-2 transition-colors',
          )}
        >
          <KindIcon kind={file.kind} className="text-subdued" />
          <span className="flex min-w-0 flex-col">
            <span className="text-label-xs text-foreground truncate font-medium">{file.name}</span>
            <span className="text-caption text-faint">{formatBytes(file.sizeBytes)}</span>
          </span>
        </a>
      ))}
      <ImageViewer
        images={images.map((image) => ({ alt: image.name, src: contentUrl(image.id) }))}
        index={open}
        onIndexChange={setOpen}
      />
    </div>
  );
}
