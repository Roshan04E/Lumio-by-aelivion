import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { ApiOfflineError, isApiOffline } from "../lib/api";

/**
 * Global last-resort error surface: catches `window.onerror` + unhandled promise rejections
 * that nothing else handled and shows ONE dismissible toast with a human message (instead of
 * errors dying silently in the console — user report). Handled paths stay quiet:
 * backend-offline errors are the ApiOfflineBanner's job, and repeated identical errors
 * collapse into a counter rather than stacking toasts.
 */

interface ToastState {
  headline: string;
  detail: string;
  count: number;
}

const AUTO_DISMISS_MS = 10_000;

/** Map raw error text to a message a user can act on. */
function describeError(raw: string): { headline: string; detail: string } | null {
  const text = raw.trim();
  if (!text) return null;
  // Browser noise with no user action — never toast these.
  if (/ResizeObserver loop/i.test(text)) return null;
  if (/AbortError|The user aborted|signal is aborted/i.test(text)) return null;

  if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(text)) {
    return {
      headline: "A file couldn't be loaded",
      detail:
        "A media or data request failed. If the backend is running, this is usually momentary — retry the action. The affected clip may show a placeholder until it loads."
    };
  }
  if (/QuotaExceededError|exceeded the quota/i.test(text)) {
    return {
      headline: "Browser storage is full",
      detail: "Orreris's local cache hit the browser's storage limit. Free disk space or clear old projects, then retry."
    };
  }
  if (/WebGL|GPU|context lost/i.test(text)) {
    return {
      headline: "Graphics hiccup",
      detail: "The GPU context was interrupted. The preview recovers automatically; if it stays black, reload the page."
    };
  }
  if (/decode|codec|VideoDecoder|AudioDecoder/i.test(text)) {
    return {
      headline: "Media couldn't be decoded",
      detail: `This file's format tripped the decoder. Try re-importing it or converting to H.264 MP4. (${text.slice(0, 120)})`
    };
  }
  return {
    headline: "Something went wrong",
    detail: text.length > 180 ? `${text.slice(0, 180)}…` : text
  };
}

export function GlobalErrorToast() {
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const report = (error: unknown) => {
      // Offline is a handled state with its own banner — don't double-report.
      if (error instanceof ApiOfflineError || isApiOffline()) return;
      const raw =
        error instanceof Error ? error.message : typeof error === "string" ? error : error ? String(error) : "";
      const described = describeError(raw);
      if (!described) return;
      setToast((current) =>
        current && current.detail === described.detail
          ? { ...current, count: current.count + 1 }
          : { ...described, count: 1 }
      );
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setToast(null), AUTO_DISMISS_MS);
    };

    const onRejection = (event: PromiseRejectionEvent) => report(event.reason);
    const onError = (event: ErrorEvent) => report(event.error ?? event.message);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!toast) return null;
  return (
    <div className="global-error-toast" role="alert">
      <AlertTriangle size={15} aria-hidden="true" />
      <div>
        <strong>
          {toast.headline}
          {toast.count > 1 ? ` (×${toast.count})` : ""}
        </strong>
        <span>{toast.detail}</span>
      </div>
      <button type="button" aria-label="Dismiss" onClick={() => setToast(null)}>
        <X size={13} />
      </button>
    </div>
  );
}
