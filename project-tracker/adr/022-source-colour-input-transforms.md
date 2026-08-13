# ADR-022 — Source colour: input transforms, the working space, and the verification gate

- Status: **Accepted** (normative) for §2–§5. §6 (working-space choice) is **Provisional** — it records a
  known limitation with a named successor decision, not a settled endpoint.
- Date drafted: 2026-08-03
- Governed by: `project-tracker/adr/README.md`

```
Depends on:  ADR-001 (foundation freeze — Rec.709 SDR lane)
Supersedes:  nothing
Amends:      nothing
Evidence base: plans/log-raw-source-color.md      (the staged plan + review history)
               packages/shared/src/color/input-transform.test.ts  (the executable gate)
Related:     project-tracker/editor-ui.md v10 (the grading-latency defect found alongside)
```

> ADR-019 is reserved for the expression contract; 022 is the next free number after 021.

---

## 0. What this does NOT reopen

The grade pipeline (`pipeline.ts` → `cpu.ts` → `bakePipelineToLut3d`) is unchanged. This ADR concerns
only what happens to a frame **before** it enters the working space. No grade math, no LUT baker
behaviour, no export tagging is amended here.

## 1. Context

"We only support generic footage" was one complaint hiding three unrelated problems with wildly
different costs:

| Problem | Real status |
|---|---|
| Container (`.mov`) | **Mostly already worked.** QuickTime is ISOBMFF; mp4box already demuxes it. |
| Codec (ProRes, RAW) | **Hard browser blocker.** Not a WebCodecs codec; no browser exposes a decoder. |
| Colour (log, 10-bit) | **Decoded fine, rendered wrong.** Nothing applied log→linear. |

Separating them inverted the priority. **Apple Log on iPhone is HEVC 10-bit, not only ProRes** — so most
"pro phone log footage" already decodes here and merely looks wrong. The cheap fix (colour) helps more
users than the expensive one (ProRes), which is why ProRes is last despite being what people ask for by
name.

## 2. Decision — a transfer function represents the ENCODING, not editor policy

Decoding is split from normalisation, as two named steps:

```
toLinear(code)              →  the encoding's own quantity
                               (PQ: cd/m², HLG: scene 0..1, camera log: scene-linear)
normalizeToWorkingSpace()   →  diffuse white = 1.0 in the working space
```

An earlier draft folded a 203-nit diffuse-white mapping into the PQ decode. That is a working-space
decision. Burying it in the decode means a future HDR export must **un-apply a normalisation it never
asked for**, with no single place to change the reference. Policy therefore lives in one function that
HDR export can decline to call.

Transfer and primaries are likewise separate steps (Stage 2a transfer; Stage 2b gamut, unbuilt).

## 3. Decision — a four-level verification ladder, with the top rung reserved for humans

Each status carries the evidence that status requires, so none can be claimed by editing one word:

| Status | Means | Requires |
|---|---|---|
| `spec-checked` | **human-reviewed** against the authoritative spec | `revision`, `checkedBy` |
| `corroborated` | independently compared against published material — **explicitly including agent work** | `evidence` |
| `spec-pending` | implemented, internally consistent, externally uncompared | `document` |
| `known-inconsistent` | a defect is located | `issue` |

**Only `spec-checked` clears a format for renderer wiring** (`spacesAwaitingVerification()`).

The human requirement is **definitional, not incidental** (founder decision 2026-08-03). This badge must
never come to mean "the implementation matched a document an LLM fetched", even when the numbers are
identical — an agent comparing figures and a colourist confirming a curve are different claims, and the
ladder is worthless if the top rung erodes.

`corroborated` exists because a flat verified/unverified flag destroyed the most useful distinction
available: a curve whose coefficients are unread but which independently reproduces a published
operating point is in a materially better state than one never compared to anything.

## 4. Decision — land the math dormant, gate it on review

Stage 2a shipped with **zero renderer call sites**. This is deliberate and is what made it safe to land
coefficients that had not yet been checked against vendor documents: the math gets reviewed before it can
affect a frame.

**This is dormancy as a safety gate, and is the exception to "vertical slices over dormant code", not a
licence for it.** Stage 2b (gamut) is explicitly NOT to be built until Stage 3 gives a user something to
select — it would add dormant code without adding capability.

## 5. Decision — reproduce published specs faithfully, including their defects

**Fujifilm's F-Log curve is discontinuous at the toe.** The data sheet branches encode on `cut1 = 0.00089`
in LINEAR space and decode on `cut2 = 0.100537775223865` in CODE space; those do not name the same point
(`e·cut1 + f = 0.1006387 ≠ cut2`) because `cut2` derives from the log segment and `e·cut1+f` from the
linear one, and **the two segments do not meet**.

We reproduce it as published. A corrected-but-nonstandard F-Log would disagree with every other tool
implementing the data sheet, which is worse than a 1e-4 seam in near-black. The seam is asserted by a test
so a future "fix" fails loudly and must answer whether it just diverged from everyone else.

## 6. Working colour space — linear Rec.709 D65 (PROVISIONAL)

Every IDT maps into **linear Rec.709, D65** (`ColorWorkingSpace = "rec709-linear"`). Stating this was a
real omission: without it, Stage 2b is undefined, because a gamut matrix needs a destination.

**Known limitation.** Rec.709 is a *narrow* working gamut and a poor one for grading log. S-Gamut3, ARRI
Wide Gamut and BT.2020 all carry colours it cannot hold, so converting into it **clips them permanently,
before the grade**, where a colourist would have wanted to pull them back. A scene-referred wide space
(ACEScg, or linear BT.2020) is the correct long-term answer.

Not changed here: the working space touches grade math, the LUT baker, export tagging and every saved
project. It deserves its own ADR. `ColorWorkingSpace` is a union type with one member — that is the
extension point.

**Consequence for UI copy: Stage 2b makes log *correctly interpreted*, not *colour accurate*.** Do not
let the interface imply otherwise.

## 7. Alternatives considered

- **Ship log support on the 8-bit pipeline.** Rejected: log is *designed* to be stretched in the grade,
  and 8-bit intermediates band visibly doing it. It would technically "work" and look worse than the
  honest warning shown today. Hence working precision (Stage 0) is a prerequisite, not an optimisation.
- **Fold diffuse white into the transfer functions.** Rejected — §2.
- **A binary verified/unverified flag.** Rejected — §3.
- **Let agent verification grant `spec-checked`.** Rejected — §3.
- **"Fix" F-Log's discontinuity.** Rejected — §5.
- **Move to ACEScg now.** Deferred — §6.
- **ProRes first.** Deferred to last: biggest lift, fewest users helped, blocks nothing.

## 8. Consequences

- `packages/shared/src/color/input-transform.ts` is the single home for input transforms. Adding a format
  means adding a registry entry with `verification` evidence; it cannot be added silently.
- `pnpm --filter @orreris/shared idt:test` prints the verification ladder on every run. Because the stage
  is dormant, **that output is the colour-science progress tracker** — reviewers read it rather than
  walking the registry.
- Stage 3 must offer only `spec-checked` spaces. At time of writing that is 4 of 11, which means **the
  vendor-document review, not the UI, is what gates Stage 3 shipping.**
- A method rule that generalises beyond colour: **a property test identifies a disagreement, not a guilty
  party.** The continuity test correctly flagged F-Log; the first attribution ("our transcription is
  wrong") was wrong. Resolve against the specification, never by assumption.

## 9. Status of the staged programme

| Stage | State |
|---|---|
| 0 — working precision | Shipped. Flag `?hdrPipeline=1`, **default OFF**. Does NOT preserve source bit depth (uploads are RGBA8); it buys grade-chain headroom. |
| 1 — detection | Shipped. Reads `colr` + real bit depth from `hvcC`/`avcC`. Pixel-neutral. |
| 2a — transfer curves | Shipped **dormant**. 11 encodings, 4 cleared for wiring. |
| 2b — gamut matrices | **Not started, deliberately.** After Stage 3. |
| 2.5 — display transform (ODT) | Recorded as the correct home for tone mapping / display LUTs / SDR preview of HDR. Not scheduled. |
| 3 — per-clip Input Color Space override | Blocked on the verification pass and on ADR-012 landing. **Mandatory** — H.273 has no code point for camera log, so detection can never identify it. |
| 4 — unsupported acquisition codecs | Last. ProRes, CineForm, DNxHR, REDCODE, BRAW, Canon RAW, X-OCN — one feature, not seven. |
