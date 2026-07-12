/**
 * Voice progressive-response ack — the Claude-style instant first phrase. Fired in PARALLEL
 * with the real planner call; a tiny payload-free request (prompt only — no slice, no
 * capabilities, no history) to the gateway's fast pool returns one prompt-SPECIFIC spoken
 * line ("Okay — moving clip 1 to the third video track.") that plays while the big model is
 * still thinking. Null on any failure — the ack is a nicety, never a blocker.
 */

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4100/api";

export async function requestSpokenAck(prompt: string): Promise<string | null> {
  try {
    const response = await fetch(`${API_URL}/ai/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.slice(0, 500) })
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { data?: { text?: string | null } };
    const text = body.data?.text;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}
