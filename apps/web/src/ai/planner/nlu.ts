import type { WinkMethods } from "wink-nlp";

/**
 * Lightweight, fully in-browser NLU for the deterministic planner (the zero-key
 * floor under the LLM gateway). wink-nlp gives us real tokenization, lemmatization
 * and POS tags — far more robust than the old hand-rolled regex fall-through — with
 * no server, no API key, and no third-party network call.
 *
 * This module is the ONLY place that imports wink. The model is ~3.8 MB, so we
 * lazy-load wink + the model as a SEPARATE chunk on first use (the deterministic
 * planner is the fallback path) — it never bloats the initial editor bundle. The
 * single `winkNLP(model)` instance is then cached for the session.
 */

let nlpPromise: Promise<WinkMethods> | null = null;
async function nlp(): Promise<WinkMethods> {
  if (!nlpPromise) {
    nlpPromise = (async () => {
      const [{ default: winkNLP }, { default: model }] = await Promise.all([
        import("wink-nlp"),
        import("wink-eng-lite-web-model")
      ]);
      return winkNLP(model);
    })();
  }
  return nlpPromise;
}

export interface NluToken {
  /** Original surface form. */
  text: string;
  /** Lower-cased surface form. */
  norm: string;
  /** Dictionary form, e.g. "bigger" → "big", "removed" → "remove". */
  lemma: string;
  /** Universal POS tag, e.g. VERB / NOUN / ADJ. */
  pos: string;
}

export interface NluDoc {
  text: string;
  tokens: NluToken[];
  /** Set of all token lemmas (lower-cased) for quick membership checks. */
  lemmas: Set<string>;
  /** Whole prompt, lower-cased. */
  lower: string;
}

/** Tokenize + annotate a prompt. Lazily loads the model on first call, then cached. */
export async function analyze(prompt: string): Promise<NluDoc> {
  const instance = await nlp();
  // wink's `its.lemma`/`its.pos` typings demand model addons the lite web model
  // reports as `unknown`; the runtime contract is just `(its) => string[]`.
  const its = instance.its as unknown as { lemma: unknown; pos: unknown };
  const doc = instance.readDoc(prompt);
  const tokensOut = doc.tokens().out as (fn?: unknown) => string[];
  const surfaces = tokensOut();
  const lemmas = tokensOut(its.lemma);
  const tags = tokensOut(its.pos);
  const tokens: NluToken[] = surfaces.map((text, i) => ({
    text,
    norm: text.toLowerCase(),
    lemma: (lemmas[i] ?? text).toLowerCase(),
    pos: tags[i] ?? "X"
  }));
  return {
    text: prompt,
    tokens,
    lemmas: new Set(tokens.map((token) => token.lemma)),
    lower: prompt.toLowerCase()
  };
}

/** True when any of the given lemmas appears as a token lemma. */
export function hasLemma(doc: NluDoc, ...lemmas: string[]): boolean {
  return lemmas.some((lemma) => doc.lemmas.has(lemma));
}

/** First noun (lemma) in the doc, optionally restricted to a candidate set. */
export function firstNoun(doc: NluDoc, candidates?: Set<string>): string | undefined {
  for (const token of doc.tokens) {
    if ((token.pos === "NOUN" || token.pos === "PROPN") && (!candidates || candidates.has(token.lemma))) {
      return token.lemma;
    }
  }
  return undefined;
}
