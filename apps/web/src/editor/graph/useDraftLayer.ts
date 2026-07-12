import { useEffect, useRef, useState } from "react";
import type { TimelineLayer } from "@lumio-by-aelivion/shared";

/**
 * Draft-during-drag / commit-on-release — the lifted TransformPanel pattern.
 * While a gesture is active every move updates a LOCAL draft layer (no store
 * writes, no undo churn); on release the final layer is committed through
 * `onChange` exactly once, so one gesture = one undo snapshot.
 */
export function useDraftLayer(
  layer: TimelineLayer,
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void
) {
  const [draftLayer, setDraftLayer] = useState<TimelineLayer | null>(null);
  const draftRef = useRef<TimelineLayer | null>(null);

  useEffect(() => {
    // Selection moved on — abandon any stale draft.
    setDraftLayer(null);
    draftRef.current = null;
  }, [layer.id]);

  function beginDraft() {
    draftRef.current = layer;
    setDraftLayer(layer);
  }

  function updateDraft(updater: (layer: TimelineLayer) => TimelineLayer) {
    const next = updater(draftRef.current ?? layer);
    draftRef.current = next;
    setDraftLayer(next);
  }

  function commitDraft() {
    const next = draftRef.current;
    if (!next) return;
    onChange(() => next);
    // Keep the draft on screen briefly so the committed layer prop can catch up
    // without a one-frame snap-back (same 120ms grace the TransformPanel used).
    window.setTimeout(() => {
      setDraftLayer(null);
      draftRef.current = null;
    }, 120);
  }

  function cancelDraft() {
    setDraftLayer(null);
    draftRef.current = null;
  }

  return {
    displayLayer: draftLayer ?? layer,
    isDrafting: draftLayer !== null,
    beginDraft,
    updateDraft,
    commitDraft,
    cancelDraft
  };
}
