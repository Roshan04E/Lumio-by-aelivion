import { useEffect, useMemo, useState, type CSSProperties, type RefObject } from "react";

export type EditorLayoutMode = "wide" | "laptop" | "tablet" | "phone";
export type EditorLayoutDensity = "comfortable" | "compact" | "tight";
export type EditorOverlayPanel = "assets" | "inspector" | "audio" | "ai" | "export" | null;

type PaneBounds = {
  min: number;
  preferred: number;
  max: number;
};

export const EDITOR_RESPONSIVE_LAYOUT = {
  modes: {
    wideMin: 1440,
    laptopMin: 1024,
    tabletMin: 760
  },
  density: {
    comfortableMin: 1320,
    compactMin: 1040
  },
  panes: {
    left: { min: 240, preferred: 340, max: 560 },
    right: { min: 256, preferred: 300, max: 500 },
    viewer: { min: 360, dualMin: 720 },
    timeline: { min: 180, preferred: 260, max: 480 },
    audioStrip: { minVisibleWidth: 1180, width: 46 },
    mixer: { minVisibleWidth: 1320, width: 280 }
  },
  chrome: {
    resizer: 8,
    pagePaddingX: 20,
    topbarHeight: 40,
    // 14" laptops commonly report 1280-1536 CSS px (1920x1080 @125-150%, or 1366x768 @100%) —
    // that's not enough room for every topbar icon inline, so fold the secondary document
    // actions into the overflow menu across that whole band (not just below it — a wider
    // 1536px window showing 6 MORE inline icons can overflow worse than a narrower collapsed one).
    compactTopbarMax: 1700
  },
  mobile: {
    viewerHeight: 54,
    timelineMinHeight: 230,
    overlayMaxHeight: 94,
    bottomRailHeight: 64,
    topbarHeight: 44,
    viewerControlsHeight: 44,
    timelineToolsWidth: 34,
    timelineTrackLabelWidth: 46
  }
} as const;

export type EditorResponsiveLayout = {
  mode: EditorLayoutMode;
  density: EditorLayoutDensity;
  width: number;
  height: number;
  cssVars: CSSProperties;
  usesOverlayPanels: boolean;
  usesPhoneShell: boolean;
  usesTopbarOverflow: boolean;
  showDedicatedAudio: boolean;
  showDedicatedMixer: boolean;
};

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function paneWidth(saved: number, bounds: PaneBounds, available: number) {
  const max = Math.max(bounds.min, Math.min(bounds.max, available));
  return clampNumber(saved || bounds.preferred, bounds.min, max);
}

export function getEditorLayoutMode(width: number): EditorLayoutMode {
  if (width >= EDITOR_RESPONSIVE_LAYOUT.modes.wideMin) return "wide";
  if (width >= EDITOR_RESPONSIVE_LAYOUT.modes.laptopMin) return "laptop";
  if (width >= EDITOR_RESPONSIVE_LAYOUT.modes.tabletMin) return "tablet";
  return "phone";
}

export function getEditorLayoutDensity(width: number): EditorLayoutDensity {
  if (width >= EDITOR_RESPONSIVE_LAYOUT.density.comfortableMin) return "comfortable";
  if (width >= EDITOR_RESPONSIVE_LAYOUT.density.compactMin) return "compact";
  return "tight";
}

export function getEditorPaneResizeBounds(width: number) {
  const mode = getEditorLayoutMode(width);
  const available = Math.max(0, width - EDITOR_RESPONSIVE_LAYOUT.chrome.pagePaddingX);
  const isDesktopLike = mode === "wide" || mode === "laptop";
  return {
    left: {
      min: EDITOR_RESPONSIVE_LAYOUT.panes.left.min,
      max: isDesktopLike ? Math.min(EDITOR_RESPONSIVE_LAYOUT.panes.left.max, Math.max(EDITOR_RESPONSIVE_LAYOUT.panes.left.min, available - 720)) : EDITOR_RESPONSIVE_LAYOUT.panes.left.min
    },
    right: {
      min: EDITOR_RESPONSIVE_LAYOUT.panes.right.min,
      max: isDesktopLike ? Math.min(EDITOR_RESPONSIVE_LAYOUT.panes.right.max, Math.max(EDITOR_RESPONSIVE_LAYOUT.panes.right.min, available - 760)) : EDITOR_RESPONSIVE_LAYOUT.panes.right.min
    },
    timeline: {
      min: EDITOR_RESPONSIVE_LAYOUT.panes.timeline.min,
      max: Math.min(EDITOR_RESPONSIVE_LAYOUT.panes.timeline.max, Math.max(EDITOR_RESPONSIVE_LAYOUT.panes.timeline.min, Math.floor((window.innerHeight || 720) * 0.55)))
    }
  };
}

export function useEditorResponsiveLayout(
  containerRef: RefObject<HTMLElement | null>,
  saved: { leftPaneWidth: number; rightPaneWidth: number; timelineHeight: number }
): EditorResponsiveLayout {
  const [size, setSize] = useState({ width: 1440, height: 900 });

  useEffect(() => {
    let raf = 0;
    let observer: ResizeObserver | null = null;
    let node: HTMLElement | null = null;
    const update = () => {
      if (!node) return;
      const rect = node.getBoundingClientRect();
      setSize({
        width: Math.max(320, Math.round(rect.width || window.innerWidth || 1440)),
        height: Math.max(480, Math.round(window.innerHeight || rect.height || 900))
      });
    };
    const attach = () => {
      node = containerRef.current;
      if (!node) {
        raf = window.requestAnimationFrame(attach);
        return;
      }
      update();
      observer = new ResizeObserver(update);
      observer.observe(node);
      window.addEventListener("resize", update);
    };
    attach();
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [containerRef]);

  return useMemo(() => {
    const mode = getEditorLayoutMode(size.width);
    const density = getEditorLayoutDensity(size.width);
    const usesPhoneShell = mode === "phone";
    const usesOverlayPanels = mode === "tablet" || mode === "phone";
    const showDedicatedAudio = size.width >= EDITOR_RESPONSIVE_LAYOUT.panes.audioStrip.minVisibleWidth && !usesOverlayPanels;
    const showDedicatedMixer = size.width >= EDITOR_RESPONSIVE_LAYOUT.panes.mixer.minVisibleWidth && !usesOverlayPanels;
    const sideBudget = Math.max(EDITOR_RESPONSIVE_LAYOUT.panes.left.min + EDITOR_RESPONSIVE_LAYOUT.panes.right.min, size.width - EDITOR_RESPONSIVE_LAYOUT.panes.viewer.min - 72);
    const leftAvailable = mode === "wide" ? EDITOR_RESPONSIVE_LAYOUT.panes.left.max : Math.floor(sideBudget * 0.52);
    const rightAvailable = mode === "wide" ? EDITOR_RESPONSIVE_LAYOUT.panes.right.max : Math.floor(sideBudget * 0.48);
    const leftPane = usesOverlayPanels ? EDITOR_RESPONSIVE_LAYOUT.panes.left.preferred : paneWidth(saved.leftPaneWidth, EDITOR_RESPONSIVE_LAYOUT.panes.left, leftAvailable);
    const rightPane = usesOverlayPanels ? EDITOR_RESPONSIVE_LAYOUT.panes.right.preferred : paneWidth(saved.rightPaneWidth, EDITOR_RESPONSIVE_LAYOUT.panes.right, rightAvailable);
    const timeline = clampNumber(saved.timelineHeight || EDITOR_RESPONSIVE_LAYOUT.panes.timeline.preferred, EDITOR_RESPONSIVE_LAYOUT.panes.timeline.min, EDITOR_RESPONSIVE_LAYOUT.panes.timeline.max);

    const cssVars = {
      "--editor-left-pane-width": `${leftPane}px`,
      "--editor-right-pane-width": `${rightPane}px`,
      "--editor-timeline-height": `${timeline}px`,
      "--editor-viewer-min-width": `${EDITOR_RESPONSIVE_LAYOUT.panes.viewer.min}px`,
      "--editor-panel-min-width": `${EDITOR_RESPONSIVE_LAYOUT.panes.left.min}px`,
      "--editor-audio-strip-width": `${EDITOR_RESPONSIVE_LAYOUT.panes.audioStrip.width}px`,
      "--editor-mixer-width": `${EDITOR_RESPONSIVE_LAYOUT.panes.mixer.width}px`,
      "--editor-mobile-viewer-height": `${EDITOR_RESPONSIVE_LAYOUT.mobile.viewerHeight}dvh`,
      "--editor-mobile-timeline-min-height": `${EDITOR_RESPONSIVE_LAYOUT.mobile.timelineMinHeight}px`,
      "--editor-overlay-max-height": `${EDITOR_RESPONSIVE_LAYOUT.mobile.overlayMaxHeight}dvh`,
      "--editor-mobile-bottom-rail-height": `${EDITOR_RESPONSIVE_LAYOUT.mobile.bottomRailHeight}px`,
      "--editor-mobile-topbar-height": `${EDITOR_RESPONSIVE_LAYOUT.mobile.topbarHeight}px`,
      "--editor-mobile-viewer-controls-height": `${EDITOR_RESPONSIVE_LAYOUT.mobile.viewerControlsHeight}px`,
      "--editor-mobile-timeline-tools-width": `${EDITOR_RESPONSIVE_LAYOUT.mobile.timelineToolsWidth}px`,
      "--editor-mobile-track-label-width": `${EDITOR_RESPONSIVE_LAYOUT.mobile.timelineTrackLabelWidth}px`,
      "--left-pane-width": `${leftPane}px`,
      "--right-pane-width": `${rightPane}px`,
      "--timeline-height": `${timeline}px`
    } as CSSProperties;

    return {
      mode,
      density,
      width: size.width,
      height: size.height,
      cssVars,
      usesOverlayPanels,
      usesPhoneShell,
      usesTopbarOverflow: size.width < EDITOR_RESPONSIVE_LAYOUT.chrome.compactTopbarMax,
      showDedicatedAudio,
      showDedicatedMixer
    };
  }, [saved.leftPaneWidth, saved.rightPaneWidth, saved.timelineHeight, size.height, size.width]);
}
