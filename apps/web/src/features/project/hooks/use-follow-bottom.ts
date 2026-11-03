import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Within this many pixels of the end counts as "at the bottom". */
const AT_BOTTOM_PX = 32;

export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Follow the bottom of a scrolling list while it grows (spec 043, after t3code's timeline): the
 * reader scrolling up stops the following, reaching the end again resumes it, and `jumpToLatest`
 * goes back — smoothly, unless reduced motion is asked for. Following itself is instant: a smooth
 * scroll per streamed token would lag behind the text it chases.
 *
 * `content` is whatever changes when the list grows; each change re-pins a following list.
 */
export function useFollowBottom<T extends HTMLElement>(
  content: unknown,
): {
  readonly isFollowing: boolean;
  readonly jumpToLatest: () => void;
  readonly onScroll: () => void;
  readonly ref: React.RefObject<T | null>;
} {
  const ref = useRef<T>(null);
  const lastTop = useRef(0);
  const [isFollowing, setFollowingState] = useState(true);
  // Read by the growth effect without re-running it: a jump sets this and scrolls by itself.
  const following = useRef(true);
  const setIsFollowing = useCallback((next: boolean) => {
    following.current = next;
    setFollowingState(next);
  }, []);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (element === null) return;
    const { clientHeight, scrollHeight, scrollTop } = element;

    if (scrollHeight - scrollTop - clientHeight <= AT_BOTTOM_PX) {
      setIsFollowing(true);
    } else if (scrollTop < lastTop.current) {
      // Only the reader moves the list up; growth and a jump to latest only ever move it down.
      setIsFollowing(false);
    }

    lastTop.current = scrollTop;
  }, [setIsFollowing]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || !following.current) return;
    element.scrollTop = element.scrollHeight;
    lastTop.current = element.scrollTop;
  }, [content]);

  const jumpToLatest = useCallback(() => {
    const element = ref.current;
    setIsFollowing(true);
    if (element === null) return;

    if (typeof element.scrollTo === 'function') {
      element.scrollTo({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        top: element.scrollHeight,
      });
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }, [setIsFollowing]);

  return { isFollowing, jumpToLatest, onScroll, ref };
}
