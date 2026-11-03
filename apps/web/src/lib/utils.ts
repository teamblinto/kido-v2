import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The BAIOS type ramp uses names rather than Tailwind's numeric sizes. Without
 * this, tailwind-merge classifies `text-heading-xl` as a colour and silently
 * drops it whenever a `text-<colour>` utility follows it.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'display-sm',
            'heading-xl',
            'heading-lg',
            'heading-md',
            'heading-sm',
            'body-lg',
            'body-md',
            'body-sm',
            'label-md',
            'label-sm',
            'label-xs',
            'caption',
            'overline',
            'mono-sm',
          ],
        },
      ],
    },
  },
});

/** Merges conditional class names and resolves conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
