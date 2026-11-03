import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { useFollowBottom } from './use-follow-bottom';

/** A list whose geometry the test sets, since jsdom lays nothing out. */
function List({ count }: { count: number }): React.JSX.Element {
  const { isFollowing, jumpToLatest, onScroll, ref } = useFollowBottom<HTMLDivElement>(count);

  return (
    <>
      <div ref={ref} data-testid="list" onScroll={onScroll}>
        {count}
      </div>
      {isFollowing ? null : (
        <button type="button" onClick={jumpToLatest}>
          Jump to latest
        </button>
      )}
    </>
  );
}

const tops = new WeakMap<HTMLElement, number>();

/** A 100px viewport over `height` of content, with a scroll position jsdom would not keep. */
function geometry(element: HTMLElement, height: number): void {
  const clamp = (top: number) => Math.max(0, Math.min(top, height - 100));

  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 100 });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: height });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => tops.get(element) ?? 0,
    set: (top: number) => tops.set(element, clamp(top)),
  });
  Object.defineProperty(element, 'scrollTo', {
    configurable: true,
    value: ({ top }: ScrollToOptions) => tops.set(element, clamp(top ?? 0)),
  });
}

describe('useFollowBottom (spec 043)', () => {
  it('follows the bottom as the list grows, stops when the reader scrolls up, and jumps back', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<List count={1} />);
    const list = screen.getByTestId('list');

    geometry(list, 500);
    rerender(<List count={2} />);
    // Pinned to the end: the growth scrolled it there.
    expect(list.scrollTop).toBe(400);

    // The reader scrolls up: the list stops following and offers the way back.
    list.scrollTop = 200;
    fireEvent.scroll(list);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    geometry(list, 800);
    rerender(<List count={3} />);
    // More arrived and nothing moved under the reader.
    expect(list.scrollTop).toBe(200);

    await user.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(list.scrollTop).toBe(700);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();

    geometry(list, 900);
    rerender(<List count={4} />);
    expect(list.scrollTop).toBe(800);
  });

  it('starts following again when the reader scrolls back to the end', () => {
    const { rerender } = render(<List count={1} />);
    const list = screen.getByTestId('list');

    geometry(list, 500);
    rerender(<List count={2} />);
    list.scrollTop = 100;
    fireEvent.scroll(list);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    list.scrollTop = 390;
    fireEvent.scroll(list);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });
});
