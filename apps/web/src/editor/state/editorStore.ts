import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { timelineActionRegistry, type RegistryOutcome, type TimelineComposition } from "@kimera-by-aelivion/shared";

/**
 * Canonical editor state (Phase 3 scaffolding).
 *
 * Lives OUTSIDE React (zustand vanilla store) so components subscribe to slices
 * and only re-render when that slice changes — the Figma-style granularity a
 * large timeline needs. All composition mutations route through the Timeline
 * Action Registry, so UI and AI share one validated, reversible path.
 *
 * Phase 3 introduces this store standalone (covered by `editor:test`); Phase 4
 * migrates `EditorPage`'s 39 `useState` hooks onto it slice by slice. Until then
 * `EditorPage` remains the live source of truth — no behavior change.
 */

export type PreviewQuality = "performance" | "balanced" | "quality";

const UNDO_LIMIT = 150;

export interface EditorState {
  composition: TimelineComposition | null;
  selection: string[];
  currentTime: number;
  isPlaying: boolean;
  previewQuality: PreviewQuality;
  undoStack: TimelineComposition[];
  redoStack: TimelineComposition[];

  // --- selection / playback ---
  setComposition: (composition: TimelineComposition | null) => void;
  select: (ids: string[]) => void;
  setCurrentTime: (seconds: number) => void;
  setPlaying: (playing: boolean) => void;
  setPreviewQuality: (quality: PreviewQuality) => void;

  // --- mutation (the only approved path) ---
  /** Run a registered timeline action against the current composition. */
  runAction: (actionId: string, params: unknown, options?: { ai?: boolean }) => RegistryOutcome;
  /** Apply a composition directly (e.g. tool Apply), recording one undo entry. */
  applyComposition: (next: TimelineComposition, options?: { recordHistory?: boolean }) => void;

  // --- history ---
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

export const editorStore = createStore<EditorState>()((set, get) => ({
  composition: null,
  selection: [],
  currentTime: 0,
  isPlaying: false,
  previewQuality: "balanced",
  undoStack: [],
  redoStack: [],

  setComposition: (composition) => set({ composition, undoStack: [], redoStack: [] }),
  select: (ids) => set({ selection: ids }),
  setCurrentTime: (seconds) => set({ currentTime: Math.max(0, seconds) }),
  setPlaying: (playing) => set({ isPlaying: playing }),
  setPreviewQuality: (quality) => set({ previewQuality: quality }),

  runAction: (actionId, params, options = {}) => {
    const { composition, selection, currentTime } = get();
    if (!composition) {
      return { ok: false, code: "execution_error", message: "No composition loaded" };
    }
    const outcome = timelineActionRegistry.execute(
      actionId,
      params,
      { composition, selection, nowSeconds: currentTime },
      { ai: options.ai }
    );
    if (outcome.ok) {
      get().applyComposition(outcome.result.after);
    }
    return outcome;
  },

  applyComposition: (next, options = {}) => {
    const { composition, undoStack } = get();
    if (options.recordHistory === false || !composition) {
      set({ composition: next });
      return;
    }
    const nextUndo = [...undoStack, composition];
    if (nextUndo.length > UNDO_LIMIT) {
      nextUndo.shift();
    }
    set({ composition: next, undoStack: nextUndo, redoStack: [] });
  },

  undo: () => {
    const { undoStack, redoStack, composition } = get();
    const previous = undoStack[undoStack.length - 1];
    if (!previous || !composition) {
      return;
    }
    set({
      composition: previous,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, composition]
    });
  },

  redo: () => {
    const { undoStack, redoStack, composition } = get();
    const next = redoStack[redoStack.length - 1];
    if (!next || !composition) {
      return;
    }
    set({
      composition: next,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, composition]
    });
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0
}));

/** React hook: subscribe to a slice of editor state (granular re-renders). */
export function useEditorStore<T>(selector: (state: EditorState) => T): T {
  return useStore(editorStore, selector);
}
