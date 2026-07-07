import { createContext, useContext } from "react";

/**
 * Auto-keyframe ("stopwatch") mode, shared with the inline inspector controls that live inside the
 * EditorPage monolith (effect-param sliders, Lumetri/Color, masks) which are too deeply nested to
 * prop-drill cleanly. Registry panels get the same flag via `InspectorPanelProps.autoKeyframe`; this
 * context is the equivalent channel for the inline controls. Default `false` = base-value edits.
 *
 * When true, editing any keyframeable value drops a keyframe at the playhead (After Effects / Premiere).
 */
export const AutoKeyframeContext = createContext<boolean>(false);

export function useAutoKeyframe(): boolean {
  return useContext(AutoKeyframeContext);
}
