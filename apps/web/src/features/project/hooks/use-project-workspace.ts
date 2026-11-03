import type { PresenceLocation } from '@repo/contracts';
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { metaShortcutLabel, useMetaShortcut } from '@/hooks/use-meta-shortcut';
import type { GitView, StageTab } from '../types';
import type { MobilePane } from '../components/project-topbar';

/** Which device width the preview is framed at. */
export type PreviewViewport = 'desktop' | 'mobile';

export const logShortcutLabel = metaShortcutLabel('j');
export const chatShortcutLabel = metaShortcutLabel('\\');

export interface ProjectWorkspace {
  gitView: GitView;
  isChatOpen: boolean;
  isLogOpen: boolean;
  /** True when the chat is collapsed on a wide screen, which splits the stage. */
  isSplit: boolean;
  /** Where the person is, for presence (spec 031, research R11). */
  location: PresenceLocation;
  mobilePane: MobilePane;
  /** The Code stage opened a file; the path is lifted here to compose {@link location}. */
  onOpenFile: (path: string) => void;
  setGitView: (view: GitView) => void;
  setMobilePane: (pane: MobilePane) => void;
  setStage: (stage: StageTab) => void;
  setViewport: (viewport: PreviewViewport) => void;
  stage: StageTab;
  toggleChat: () => void;
  toggleLog: () => void;
  viewport: PreviewViewport;
}

/**
 * The project screen's layout state: which pane is showing, and whether the chat is collapsed.
 *
 * It used to read `?run=` too, to pick which of the design's frames to demonstrate. That
 * parameter now names an actual run and is read by `use-run.ts` (R4, FR-025), so this hook is
 * the layout state its name always claimed it was.
 */
export function useProjectWorkspace(): ProjectWorkspace {
  const [stage, setStage] = useState<StageTab>('preview');
  const [gitView, setGitView] = useState<GitView>('changes');
  const [mobilePane, setMobilePane] = useState<MobilePane>('chat');
  const [viewport, setViewport] = useState<PreviewViewport>('desktop');
  const [isChatOpen, setIsChatOpen] = useState(true);
  const [isLogOpen, setIsLogOpen] = useState(false);
  const [openPath, setOpenPath] = useState<string | undefined>(undefined);
  const [searchParams] = useSearchParams();
  const runId = searchParams.get('run') ?? undefined;

  const toggleChat = useCallback(() => {
    setIsChatOpen((open) => !open);
  }, []);

  const toggleLog = useCallback(() => {
    setIsLogOpen((open) => !open);
  }, []);

  useMetaShortcut('j', toggleLog);
  useMetaShortcut('\\', toggleChat);

  // Collapsing the chat on a wide screen is what produces the split view: the
  // stage then has room for the code and the preview at once.
  const isSplit = !isChatOpen && stage !== 'git';

  // Keeping the two switches in step means the mobile segments and the desktop
  // tabs never disagree about which pane is showing.
  const selectStage = useCallback((next: StageTab) => {
    setStage(next);
    setMobilePane(next);
  }, []);

  const selectMobilePane = useCallback((next: MobilePane) => {
    setMobilePane(next);

    if (next !== 'chat') {
      setStage(next);
    }
  }, []);

  /*
   * The presence location (R11): the Code stage names its open file; the git history names
   * itself; a run in `?run=` names the run; anything else is the preview.
   */
  const location = useMemo((): PresenceLocation => {
    if (stage === 'code') {
      return openPath === undefined ? { view: 'code' } : { path: openPath, view: 'code' };
    }

    if (stage === 'git' && gitView === 'history') {
      return { view: 'history' };
    }

    if (runId !== undefined && /^[0-9a-f-]{36}$/i.test(runId)) {
      return { runId, view: 'run' };
    }

    return { view: 'preview' };
  }, [gitView, openPath, runId, stage]);

  return {
    gitView,
    isChatOpen,
    isLogOpen,
    isSplit,
    location,
    mobilePane,
    onOpenFile: setOpenPath,
    setGitView,
    setMobilePane: selectMobilePane,
    setStage: selectStage,
    setViewport,
    stage,
    toggleChat,
    toggleLog,
    viewport,
  };
}
