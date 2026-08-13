/**
 * Professional Color System — Input transforms (IDT), plans/log-raw-source-color.md Stage 2a.
 *
 * Camera log footage decodes fine in this app and renders WRONG: flat, washed out, milky blacks. Not a
 * decode problem — a transfer problem. The camera encoded scene light through a log curve to fit ~14
 * stops into 10 bits, and nothing here ever undid it. These are the curves that undo it.
 *
 * **Two responsibilities, deliberately separated.**
 *
 *   decode transfer  →  the ENCODING's own quantity   (PQ: cd/m², HLG: scene 0..1, log: scene-linear)
 *          ↓
 *   normalizeToWorkingSpace  →  diffuse white = 1.0 in the working space
 *
 * A transfer function represents the encoding, not editor policy. An earlier draft folded a 203-nit
 * diffuse-white mapping into the PQ decode; that is a working-space decision, and burying it in the
 * decode means a future HDR export has to un-apply a normalisation it never asked for, with no single
 * place to change the reference. `toLinear` is therefore honest about what the format means, and the
 * policy lives in one named function that HDR export can decline to call.
 *
 * **Working space:** linear Rec.709, D65 (`ColorWorkingSpace = "rec709-linear"`). Note that Rec.709 is a
 * NARROW gamut: S-Gamut3 / ARRI Wide Gamut / BT.2020 all carry colours it cannot hold, so the gamut step
 * (Stage 2b, not yet written) clips them on the way in, before the grade. These transforms make log
 * *correctly interpreted*, not *colour accurate* — see the plan.
 *
 * **Nothing consumes this yet, on purpose.** No renderer call site; Stage 3's per-clip override is what
 * will select a space. That is what makes it safe to land with `verification: "spec-pending"` — the math
 * gets reviewed before it can affect a frame. See `VERIFICATION` below.
 */

import { rec709CodeToLinear, rec709LinearToCode } from "./color-management";

/**
 * Stored identifiers, never display strings — Stage 3 persists these into project files, so they are
 * part of the saved-project contract and localisation stays free.
 */
export type InputColorSpace =
  | "auto"
  | "rec709"
  | "srgb"
  | "apple-log"
  | "slog3"
  | "vlog"
  | "logc3"
  | "logc4"
  | "dlog"
  | "flog"
  | "hlg"
  | "pq";

/**
 * Confidence ladder, most trustworthy first. Provenance is structural, not a convention: each status
 * carries the evidence that status requires, so none of them can be claimed by editing a single word.
 *
 * "Unverified" was rejected as a word — it reads as "probably wrong", when the real state is
 * "implemented, internally tested, awaiting the authoritative document". And a flat verified/unverified
 * flag lost the most interesting distinction we actually have: a curve whose coefficients are unchecked
 * but which independently reproduces a published operating point is in a materially better state than
 * one that has never been compared to anything.
 *
 * **Only `spec-checked` clears a space for renderer wiring** — see `spacesAwaitingVerification()`.
 */
export type TransferVerification =
  /**
   * **HUMAN-REVIEWED** against the authoritative specification, with revision and reviewer recorded.
   *
   * The human requirement is definitional, not incidental (founder decision, 2026-08-03). This badge
   * must never come to mean "the implementation matched a document an LLM fetched", even when the
   * numbers turn out identical — an agent comparing figures and a colourist confirming a curve are
   * different claims, and the whole ladder is worthless if the top rung erodes. Agent-performed
   * comparison, however careful, lands at `corroborated`.
   */
  | { status: "spec-checked"; document: string; revision: string; checkedBy: string }
  /**
   * Independently compared against published vendor material — **explicitly including work performed
   * by an AI agent** — with the evidence recorded. Also covers a curve that reproduces a published
   * operating point (e.g. the vendor's stated 18% grey) without its full coefficient set being read.
   *
   * Strong enough to trust while developing; NOT sufficient to wire into a renderer.
   */
  | { status: "corroborated"; document: string; evidence: string }
  /** Implemented and internally consistent; nothing has been compared to anything external. */
  | { status: "spec-pending"; document: string }
  /** A defect is KNOWN and located. Must be corrected before use; never silently downgraded. */
  | { status: "known-inconsistent"; document: string; issue: string };

/** What the encoding's linear quantity MEANS — the unit `toLinear` returns. */
export type LinearDomain =
  /** Scene-referred reflectance: 0.18 is an 18% grey card, 1.0 is a 100% diffuse white. */
  | "scene-linear"
  /** Absolute display light in cd/m² (PQ). 10000 is the format's peak. */
  | "absolute-nits"
  /** HLG scene-referred 0..1 from the inverse OETF; diffuse white sits well below 1.0. */
  | "hlg-scene"
  /** Already display-linear 0..1 (Rec.709 / sRGB) — no normalisation needed. */
  | "display-linear";

export interface InputTransferDefinition {
  id: InputColorSpace;
  /** Display only. Never persisted, never compared against. */
  label: string;
  /** 0..1 code value → this encoding's own linear quantity (see `domain`). */
  toLinear(code: number): number;
  /**
   * Exact inverse of `toLinear`. The renderer never needs it; it exists because a round-trip is the only
   * way to catch a transcription slip in a piecewise function when there is no reference implementation
   * to diff against — the same reason `cpu.ts` is ground truth for the LUT baker.
   */
  fromLinear(linear: number): number;
  domain: LinearDomain;
  /** Consumed by Stage 2b (gamut). Recorded now so 2b is a pure addition. */
  nativeGamut: string;
  implementation: "stub" | "implemented";
  verification: TransferVerification;
}

const LOG10 = Math.LN10;
const log10 = (x: number): number => Math.log(x) / LOG10;
const log2 = (x: number): number => Math.log2(x);

/* ------------------------------------------------------------------ Sony S-Log3 */
// Sony's published S-Log3 reflection curve. The 0.18/0.01 terms are the 18% grey anchor at code 420.
const SLOG3_BREAK_CODE = 171.2102946929;
function slog3ToLinear(x: number): number {
  if (x >= SLOG3_BREAK_CODE / 1023) return 10 ** ((x * 1023 - 420) / 261.5) * (0.18 + 0.01) - 0.01;
  return ((x * 1023 - 95) * 0.01125) / (SLOG3_BREAK_CODE - 95);
}
function slog3FromLinear(y: number): number {
  if (y >= 0.01125) return (420 + log10((y + 0.01) / (0.18 + 0.01)) * 261.5) / 1023;
  return ((y * (SLOG3_BREAK_CODE - 95)) / 0.01125 + 95) / 1023;
}

/* ------------------------------------------------------------------ Panasonic V-Log */
const VLOG = { cut1: 0.01, cut2: 0.181, b: 0.00873, c: 0.241514, d: 0.598206 } as const;
function vlogToLinear(x: number): number {
  if (x < VLOG.cut2) return (x - 0.125) / 5.6;
  return 10 ** ((x - VLOG.d) / VLOG.c) - VLOG.b;
}
function vlogFromLinear(y: number): number {
  if (y < VLOG.cut1) return 5.6 * y + 0.125;
  return VLOG.c * log10(y + VLOG.b) + VLOG.d;
}

/* ------------------------------------------------------------------ ARRI LogC3 (EI 800) */
const LOGC3 = {
  cut: 0.010591, a: 5.555556, b: 0.052272, c: 0.24719, d: 0.385537, e: 5.367655, f: 0.092809
} as const;
const LOGC3_CUT_CODE = LOGC3.e * LOGC3.cut + LOGC3.f;
function logc3ToLinear(x: number): number {
  if (x > LOGC3_CUT_CODE) return (10 ** ((x - LOGC3.d) / LOGC3.c) - LOGC3.b) / LOGC3.a;
  return (x - LOGC3.f) / LOGC3.e;
}
function logc3FromLinear(y: number): number {
  if (y > LOGC3.cut) return LOGC3.c * log10(LOGC3.a * y + LOGC3.b) + LOGC3.d;
  return LOGC3.e * y + LOGC3.f;
}

/* ------------------------------------------------------------------ ARRI LogC4 */
// Constants are DERIVED from the spec's definitions rather than transcribed as decimals — the whole
// point of LogC4's formulation is that a/b/c come from the 10-bit legal range, so deriving them removes
// a transcription surface entirely.
const LOGC4_A = (2 ** 18 - 16) / 117.45;
const LOGC4_B = (1023 - 95) / 1023;
const LOGC4_C = 95 / 1023;
const LOGC4_S = (7 * Math.LN2 * 2 ** (7 - (14 * LOGC4_C) / LOGC4_B)) / (LOGC4_A * LOGC4_B);
const LOGC4_T = (2 ** (14 * (-LOGC4_C / LOGC4_B) + 6) - 64) / LOGC4_A;
function logc4ToLinear(x: number): number {
  if (x < 0) return x * LOGC4_S + LOGC4_T;
  return (2 ** ((14 * (x - LOGC4_C)) / LOGC4_B + 6) - 64) / LOGC4_A;
}
function logc4FromLinear(y: number): number {
  if (y < LOGC4_T) return (y - LOGC4_T) / LOGC4_S;
  return ((log2(LOGC4_A * y + 64) - 6) / 14) * LOGC4_B + LOGC4_C;
}

/* ------------------------------------------------------------------ Apple Log */
// Apple Log Profile White Paper (2023). The quadratic toe below Rt and the log segment above it are
// fitted to meet — which the continuity test exploits as a real check on these constants.
const APPLE = { R0: -0.05641088, Rt: 0.01, c: 47.28711236, beta: 0.00964052, gamma: 0.08550479, delta: 0.69336945 } as const;
const APPLE_PT = APPLE.c * (APPLE.Rt - APPLE.R0) ** 2;
function appleLogToLinear(x: number): number {
  if (x < APPLE_PT) return APPLE.R0 + Math.sqrt(Math.max(0, x / APPLE.c));
  return 2 ** ((x - APPLE.delta) / APPLE.gamma) - APPLE.beta;
}
function appleLogFromLinear(y: number): number {
  if (y < APPLE.R0) return 0;
  if (y < APPLE.Rt) return APPLE.c * (y - APPLE.R0) ** 2;
  return APPLE.gamma * log2(y + APPLE.beta) + APPLE.delta;
}

/* ------------------------------------------------------------------ DJI D-Log */
const DLOG_CUT_LINEAR = 0.0078;
// DJI publishes the DECODE threshold as 0.14 in code space, not as e*cut1+f (= 0.139995). Using the
// published figure rather than the derived one, because matching the document is the point — see F-Log
// for why the two can legitimately differ. Consequence is a 5e-6-wide code band that is not exactly
// round-trippable; that band is the spec's, not ours.
const DLOG_CUT_CODE = 0.14;
function dlogToLinear(x: number): number {
  if (x <= DLOG_CUT_CODE) return (x - 0.0929) / 6.025;
  return (10 ** ((x - 0.584555) / 0.256663) - 0.0108) / 0.9892;
}
function dlogFromLinear(y: number): number {
  if (y <= DLOG_CUT_LINEAR) return 6.025 * y + 0.0929;
  return log10(y * 0.9892 + 0.0108) * 0.256663 + 0.584555;
}

/* ------------------------------------------------------------------ Fujifilm F-Log */
/**
 * Verified against the Fujifilm F-Log Data Sheet (Ver. 1.0/1.1/1.2 all agree). Every constant here is
 * the published one.
 *
 * **The ~1.3% discontinuity at the toe is Fujifilm's, not ours** — an earlier note in this file blamed a
 * transcription error, and that was wrong. The data sheet gives the two directions DIFFERENT thresholds
 * in DIFFERENT spaces: encode branches on `cut1 = 0.00089` in LINEAR space, decode branches on
 * `cut2 = 0.100537775223865` in CODE space. Those two do not name the same point —
 * `e·cut1 + f = 0.1006387 ≠ cut2` — because `cut2` is derived from the LOG segment while `e·cut1 + f`
 * comes from the LINEAR one, and the two segments do not meet.
 *
 * So the published curve is genuinely discontinuous at the join, and encode/decode are not exact
 * inverses across the ~1e-4-wide code band between the two thresholds. We reproduce the spec rather
 * than "fix" it: a corrected-but-nonstandard F-Log would disagree with every other tool that
 * implements the data sheet, which is a worse outcome than a 1e-4 seam in near-black.
 */
const FLOG = { a: 0.555556, b: 0.009468, c: 0.344676, d: 0.790453, e: 8.735631, f: 0.092864, cut1: 0.00089 } as const;
/** Published decode threshold. NOT `e·cut1 + f` — see above; using the derived value was our one real bug. */
const FLOG_CUT_CODE = 0.100537775223865;
function flogToLinear(x: number): number {
  if (x < FLOG_CUT_CODE) return (x - FLOG.f) / FLOG.e;
  return (10 ** ((x - FLOG.d) / FLOG.c) - FLOG.b) / FLOG.a;
}
function flogFromLinear(y: number): number {
  if (y < FLOG.cut1) return FLOG.e * y + FLOG.f;
  return FLOG.c * log10(FLOG.a * y + FLOG.b) + FLOG.d;
}

/* ------------------------------------------------------------------ HLG (ITU-R BT.2100) */
const HLG = { a: 0.17883277, b: 0.28466892, c: 0.55991073 } as const;
function hlgToLinear(x: number): number {
  if (x <= 0.5) return (x * x) / 3;
  return (Math.exp((x - HLG.c) / HLG.a) + HLG.b) / 12;
}
function hlgFromLinear(y: number): number {
  if (y <= 1 / 12) return Math.sqrt(3 * y);
  return HLG.a * Math.log(12 * y - HLG.b) + HLG.c;
}
/** Scene value at E'=0.75, HLG's nominal diffuse white. Derived, not hardcoded. */
export const HLG_SCENE_DIFFUSE_WHITE = hlgToLinear(0.75);

/* ------------------------------------------------------------------ PQ (SMPTE ST 2084) */
const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;
const PQ_PEAK_NITS = 10000;
/** Returns ABSOLUTE cd/m², because that is what PQ encodes. Normalisation is a separate step. */
function pqToLinear(x: number): number {
  const p = Math.max(0, x) ** (1 / PQ_M2);
  const num = Math.max(p - PQ_C1, 0);
  const den = PQ_C2 - PQ_C3 * p;
  if (den === 0) return 0;
  return (num / den) ** (1 / PQ_M1) * PQ_PEAK_NITS;
}
function pqFromLinear(nits: number): number {
  const ym = Math.max(0, nits / PQ_PEAK_NITS) ** PQ_M1;
  return ((PQ_C1 + PQ_C2 * ym) / (1 + PQ_C3 * ym)) ** PQ_M2;
}
/** ITU-R BT.2408 reference (graphics) white. The working-space policy, not part of the decode. */
export const PQ_DIFFUSE_WHITE_NITS = 203;

/* ------------------------------------------------------------------ registry */

// No entry is `spec-pending` any more — the 2026-08-03 document pass gave every format evidence. The
// status remains in the type as the correct starting state for the next format someone adds.

export const INPUT_TRANSFERS: Record<Exclude<InputColorSpace, "auto">, InputTransferDefinition> = {
  rec709: {
    id: "rec709", label: "Rec.709", toLinear: rec709CodeToLinear, fromLinear: rec709LinearToCode,
    domain: "display-linear", nativeGamut: "bt709", implementation: "implemented",
    // Already shipped and exercised by the pixel gate through the managed grade path.
    verification: { status: "spec-checked", document: "ITU-R BT.709 / IEC 61966-2-1", revision: "in-tree since Phase 3", checkedBy: "render:compare:pixels" }
  },
  srgb: {
    id: "srgb", label: "sRGB", toLinear: rec709CodeToLinear, fromLinear: rec709LinearToCode,
    domain: "display-linear", nativeGamut: "bt709", implementation: "implemented",
    verification: { status: "spec-checked", document: "IEC 61966-2-1", revision: "in-tree since Phase 3", checkedBy: "render:compare:pixels" }
  },
  "apple-log": {
    id: "apple-log", label: "Apple Log", toLinear: appleLogToLinear, fromLinear: appleLogFromLinear,
    domain: "scene-linear", nativeGamut: "bt2020", implementation: "implemented",
    verification: {
      status: "corroborated",
      document: "Apple, Apple Log Profile White Paper (Sept 2023)",
      evidence:
        "All six constants confirmed against the published white paper: R0 −0.05641088, Rt 0.01, " +
        "c 47.28711236, β 0.00964052, γ 0.08550479, δ 0.69336945. Branches meet at the join to 1.19e-8."
    }
  },
  slog3: {
    id: "slog3", label: "Sony S-Log3", toLinear: slog3ToLinear, fromLinear: slog3FromLinear,
    domain: "scene-linear", nativeGamut: "s-gamut3.cine", implementation: "implemented",
    verification: {
      status: "corroborated",
      document: "Sony, S-Log3/S-Gamut3 Technical Summary",
      evidence:
        "Full coefficient set confirmed against the Technical Summary's published formula, not just an " +
        "operating point: log segment (420 + log10((in+0.01)/(0.18+0.01))·261.5)/1023, linear segment " +
        "(in·(171.2102946929−95)/0.01125 + 95)/1023. The break code 171.2102946929 is the spec's own " +
        "value, carried here at full published precision rather than derived. 18% grey → 0.41056, " +
        "matching Sony's published code 420/1023."
    }
  },
  vlog: {
    id: "vlog", label: "Panasonic V-Log", toLinear: vlogToLinear, fromLinear: vlogFromLinear,
    domain: "scene-linear", nativeGamut: "v-gamut", implementation: "implemented",
    verification: {
      status: "corroborated",
      document: "Panasonic, V-Log/V-Gamut Reference Manual (2014-11-28)",
      evidence:
        "Full coefficient set confirmed against the reference manual, not just an operating point: " +
        "cut1 = 0.01, cut2 = 0.181, b = 0.00873, c = 0.241514, d = 0.598206, linear segment " +
        "5.6·in + 0.125. Note the manual gives cut1 for ENCODE (linear domain) and cut2 for DECODE " +
        "(code domain) — two different thresholds naming different points, as implemented here. " +
        "18% grey → 0.4233, matching Panasonic's published 42.3% IRE."
    }
  },
  logc3: {
    id: "logc3", label: "ARRI LogC3 (EI 800)", toLinear: logc3ToLinear, fromLinear: logc3FromLinear,
    domain: "scene-linear", nativeGamut: "arri-wide-gamut-3", implementation: "implemented",
    verification: {
      status: "corroborated",
      document: "ARRI, ALEXA LogC Curve — Usage in VFX",
      evidence:
        "Full coefficient set confirmed for EI 800: cut = 0.010591, a = 5.555556, b = 0.052272, " +
        "c = 0.247190, d = 0.385537, e = 5.367655, f = 0.092809. 18% grey → 0.391006, matching ARRI's " +
        "published ~39.1%. " +
        "TRAP, recorded so nobody 'fixes' this to match a reference implementation: ARRI publishes " +
        "LogC3 in TWO parameterizations. These are the NORMALIZED SENSOR SIGNAL constants. The " +
        "LINEAR SCENE EXPOSURE FACTOR form of the same curve has different numbers " +
        "(cut 0.004201, a 200.0, b −0.729169, e 0.193235573, f 0.149658) and is what colour-science " +
        "tabulates. Only c and d are shared between the two. A side-by-side against colour-science " +
        "will look like a mismatch and is not one — check which domain the other table is in first."
    }
  },
  logc4: {
    id: "logc4", label: "ARRI LogC4", toLinear: logc4ToLinear, fromLinear: logc4FromLinear,
    domain: "scene-linear", nativeGamut: "arri-wide-gamut-4", implementation: "implemented",
    verification: {
      status: "corroborated",
      document: "ARRI, LogC4 Logarithmic Colour Space Specification (2022-05)",
      evidence:
        "a = (2^18−16)/117.45, b = (1023−95)/1023, c = 95/1023 confirmed against the ARRI " +
        "specification via the OpenColorIO config-aces ARRI transform generator; s and t are derived " +
        "from them here exactly as the spec defines, which removes the transcription surface entirely. " +
        "Join continuous to 1.26e-8."
    }
  },
  dlog: {
    id: "dlog", label: "DJI D-Log", toLinear: dlogToLinear, fromLinear: dlogFromLinear,
    domain: "scene-linear", nativeGamut: "d-gamut", implementation: "implemented",
    verification: {
      status: "corroborated",
      document: "DJI, D-Log/D-Gamut White Paper",
      evidence:
        "All constants confirmed against the DJI white paper: linear segment 6.025/0.0929, log " +
        "segment 0.256663/0.584555, scaling 0.9892/0.0108, encode cut 0.0078. Decode threshold " +
        "corrected to DJI's PUBLISHED 0.14 — it had been derived as 0.139995."
    }
  },
  flog: {
    id: "flog", label: "Fujifilm F-Log", toLinear: flogToLinear, fromLinear: flogFromLinear,
    domain: "scene-linear", nativeGamut: "f-gamut", implementation: "implemented",
    verification: {
      status: "corroborated",
      document: "Fujifilm, F-Log Data Sheet (Ver. 1.0 / 1.1 / 1.2 — identical constants)",
      evidence:
        "All eight constants confirmed against the data sheet. The ~1.3e-2 join discontinuity is the " +
        "SPEC's, not a transcription error, reversing this entry's earlier verdict: encode branches on " +
        "cut1 = 0.00089 in LINEAR space, decode on cut2 = 0.100537775223865 in CODE space, and " +
        "e·cut1 + f = 0.1006387 ≠ cut2. Our one genuine bug was using the derived threshold instead of " +
        "the published cut2 — fixed. Reproduced as published rather than corrected, so this agrees with " +
        "every other data-sheet implementation."
    }
  },
  hlg: {
    id: "hlg", label: "HLG (BT.2100)", toLinear: hlgToLinear, fromLinear: hlgFromLinear,
    domain: "hlg-scene", nativeGamut: "bt2020", implementation: "implemented",
    // An open standard stated in full in the recommendation — not a vendor curve read off a PDF.
    verification: { status: "spec-checked", document: "ITU-R BT.2100 inverse OETF", revision: "BT.2100-2", checkedBy: "standard text" }
  },
  pq: {
    id: "pq", label: "PQ / HDR10 (ST 2084)", toLinear: pqToLinear, fromLinear: pqFromLinear,
    domain: "absolute-nits", nativeGamut: "bt2020", implementation: "implemented",
    verification: { status: "spec-checked", document: "SMPTE ST 2084 inverse EOTF", revision: "ST 2084:2014", checkedBy: "standard text" }
  }
};

export function inputTransfer(space: InputColorSpace): InputTransferDefinition {
  if (space === "auto") return INPUT_TRANSFERS.rec709;
  return INPUT_TRANSFERS[space];
}

/**
 * The working-space policy, kept OUT of the transfer functions on purpose (see the module header).
 * Maps the encoding's own linear quantity onto "diffuse white = 1.0" in linear Rec.709.
 *
 * HDR export is expected to skip this and consume `toLinear` directly — that is the entire reason the
 * two are separable.
 */
export function normalizeToWorkingSpace(domain: LinearDomain, value: number): number {
  switch (domain) {
    case "absolute-nits":
      return value / PQ_DIFFUSE_WHITE_NITS;
    case "hlg-scene":
      return value / HLG_SCENE_DIFFUSE_WHITE;
    case "scene-linear":
    case "display-linear":
      return value;
  }
}

/** Decode one code value all the way to the working space. The composition of the two steps above. */
export function inputCodeToWorkingLinear(space: InputColorSpace, code: number): number {
  const def = inputTransfer(space);
  return normalizeToWorkingSpace(def.domain, def.toLinear(code));
}

/** Per-channel form. Gamut (Stage 2b) is NOT applied — see the module header. */
export function inputRgbToWorkingLinear(
  space: InputColorSpace,
  rgb: readonly [number, number, number]
): [number, number, number] {
  return [
    inputCodeToWorkingLinear(space, rgb[0]),
    inputCodeToWorkingLinear(space, rgb[1]),
    inputCodeToWorkingLinear(space, rgb[2])
  ];
}

/** Every space a Stage 3 dropdown should offer, in presentation order. */
export const SELECTABLE_INPUT_SPACES: InputColorSpace[] = [
  "auto", "rec709", "srgb",
  "apple-log", "slog3", "vlog", "logc3", "logc4", "dlog", "flog",
  "hlg", "pq"
];

export type VerificationStatus = TransferVerification["status"];

/** Most trustworthy first. Also the display order of the `idt:test` dashboard. */
export const VERIFICATION_ORDER: VerificationStatus[] = [
  "spec-checked",
  "corroborated",
  "spec-pending",
  "known-inconsistent"
];

const ALL_TRANSFER_IDS = (): Exclude<InputColorSpace, "auto">[] =>
  Object.keys(INPUT_TRANSFERS) as Exclude<InputColorSpace, "auto">[];

/**
 * Everything NOT cleared for renderer wiring. `corroborated` is deliberately included: agreeing with a
 * published grey point is evidence about one operating point, not about the coefficient set, and the
 * gate is "someone read the document" — not "it looks right".
 */
export function spacesAwaitingVerification(): InputColorSpace[] {
  return ALL_TRANSFER_IDS().filter((id) => INPUT_TRANSFERS[id].verification.status !== "spec-checked");
}

/**
 * Verification state grouped by status. Because Stage 2a is intentionally dormant, this is the colour
 * science work's progress tracker — `idt:test` renders it on every run so a reviewer can read the
 * confidence picture without going through the registry by hand.
 */
export function verificationSummary(): { status: VerificationStatus; spaces: InputTransferDefinition[] }[] {
  return VERIFICATION_ORDER.map((status) => ({
    status,
    spaces: ALL_TRANSFER_IDS()
      .map((id) => INPUT_TRANSFERS[id])
      .filter((def) => def.verification.status === status)
  }));
}
