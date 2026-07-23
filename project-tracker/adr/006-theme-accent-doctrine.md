# ADR-006 — Theme Accent Doctrine

- Status: Stable
- Date adopted: 2026-07-23 (documenting a long-standing rule)

## Context

A single-accent editor UI is easy to break in two ways: hardcoding the accent color at call
sites (so a re-theme misses spots), and over-using the accent as decoration (so it stops
signalling interaction and, in the node graph, collides with a functional color language).

## Decision

- **Chrome accents are a token, never a literal.** UI accents use `var(--nle-accent)`. Do not
  hardcode the amber literal (`#e8b04b`) or any accent hex at a call site.
- **Accent signals interaction, not decoration.** In the Flarex node canvas, sockets, node
  stripes, and wires are **neutral at rest**; accent appears only for interaction states
  (hover/select/drag).
- **One functional exception:** socket and wire color **encodes data type** (image / matte /
  number / future data sockets). That is a functional color language, not decoration, and is
  therefore exempt from the "neutral at rest" rule.

## Alternatives considered

- **Per-component color choices.** Rejected: re-theming becomes a hunt for literals; accent
  loses meaning.
- **Accent everywhere for "vibrancy."** Rejected: destroys the interaction signal and clashes
  with the data-type color language on the graph.

## Consequences

- Re-theming is a token change, not a code sweep.
- A new node/socket/wire must pick its color from the **data-type** palette, not the accent.
- Any hardcoded accent hex in a diff is a review-blocking event.
