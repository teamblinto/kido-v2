import type { FileEntry } from '@repo/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { type DirectoryState, FileTree } from './file-tree';

const TREE: Record<string, FileEntry[]> = {
  '': [
    { kind: 'file', name: 'readme.md', size: 2048 },
    { kind: 'directory', name: 'src', size: 0 },
    { kind: 'link', name: 'shortcut', size: 0 },
  ],
  empty: [],
  src: [{ kind: 'file', name: 'main.ts', size: 512 }],
};

/** The hook `use-files.ts` will supply, answered here from a plain map. */
function useFakeDirectory(dir: string): DirectoryState {
  const entries = TREE[dir];
  return entries === undefined ? { isPending: true } : { entries, isPending: false };
}

function renderTree(onOpen = vi.fn()) {
  render(<FileTree onOpen={onOpen} useDirectory={useFakeDirectory} />);
  return onOpen;
}

function rowNames(): string[] {
  return screen.getAllByRole('treeitem').map((row) => row.getAttribute('aria-labelledby') ?? '');
}

describe('FileTree', () => {
  it('lists directories before files and does not list a directory until it is expanded', async () => {
    renderTree();

    expect(rowNames()).toEqual(['file-tree-src', 'file-tree-readme.md', 'file-tree-shortcut']);
    expect(screen.queryByText('main.ts')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('src'));

    expect(rowNames()).toEqual([
      'file-tree-src',
      'file-tree-src/main.ts',
      'file-tree-readme.md',
      'file-tree-shortcut',
    ]);
    expect(screen.getByRole('treeitem', { name: 'src' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows a file size on hover and opens only files', async () => {
    const onOpen = renderTree();

    expect(screen.getByRole('treeitem', { name: /readme\.md/ })).toHaveAttribute(
      'title',
      'readme.md — 2.0 KB',
    );

    await userEvent.click(screen.getByText('readme.md'));
    expect(onOpen).toHaveBeenCalledWith('readme.md');

    await userEvent.click(screen.getByText('shortcut'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('treeitem', { name: /shortcut/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('moves with the arrows and opens with Enter', async () => {
    const onOpen = renderTree();

    await userEvent.tab();
    expect(screen.getByRole('treeitem', { name: 'src' })).toHaveFocus();

    await userEvent.keyboard('{ArrowRight}'); // expands
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('treeitem', { name: /main\.ts/ })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith('src/main.ts');

    await userEvent.keyboard('{ArrowLeft}'); // back to the parent
    expect(screen.getByRole('treeitem', { name: 'src' })).toHaveFocus();

    await userEvent.keyboard('{ArrowLeft}'); // collapses
    expect(screen.queryByText('main.ts')).not.toBeInTheDocument();

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('treeitem', { name: /readme\.md/ })).toHaveFocus();
  });

  it('says an empty directory is empty rather than showing a sample path', async () => {
    render(
      <FileTree
        onOpen={vi.fn()}
        useDirectory={(dir) =>
          dir === ''
            ? { entries: [{ kind: 'directory', name: 'empty', size: 0 }], isPending: false }
            : useFakeDirectory(dir)
        }
      />,
    );

    await userEvent.click(screen.getByText('empty'));

    const group = screen.getByRole('group');
    expect(within(group).getByText('empty is empty.')).toBeInTheDocument();
    expect(within(group).queryAllByRole('treeitem')).toHaveLength(0);
  });
});
