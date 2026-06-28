import { Component, type ReactNode } from "react";

/**
 * Error boundary for the WebGL color overlays. If anything in the WebGL path throws
 * (context loss, shader/upload failure, driver quirk), it renders nothing instead of
 * crashing the editor — the underlying DOM/SVG layer (which always renders) stays
 * visible, so the worst case is "no float grade", never a blank screen.
 */
export class ColorEngineBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.warn("[color] WebGL color path failed; falling back to the DOM/SVG render.", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
