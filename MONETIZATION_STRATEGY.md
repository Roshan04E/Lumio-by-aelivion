# Kimera Monetization Strategy & Roadmap

**Doctrine (locked by founder, 2026-07-13):** The editor stays free forever. We never charge
for creativity — cutting, grading, effects, transitions, captions-on-device, keyframes, the
timeline itself. We charge only for things that cost *us* real money: our AI keys (cloud LLM
calls), image/video generation (fal.ai), and cloud services (storage, cloud render, cloud
transcription, payouts infrastructure).

This is not a compromise — it is the strategy. Everything below flows from it.

---

## 1. Why this model wins for *this specific app*

Most competitors' paid features are our free features, because our architecture makes their
marginal cost ≈ zero:

| Capability | CapCut / Veed / Kapwing | Kimera |
|---|---|---|
| Background removal, person extraction | Pro / credits (cloud GPU) | **Free** — browser adapter (WebGPU/WebCodecs, `apps/web/src/tools/`) |
| Auto captions | Pro / minutes-metered | **Free** — local `@huggingface/transformers` transcription |
| Voice control / TTS read-back | N/A or cloud | **Free** — local WebGPU Kokoro TTS + Moonshine ASR |
| Watermark-free export | Pro ($19.99/mo on CapCut) | **Free** — local WebCodecs export, our cost is zero |
| Pro color pipeline, scopes, keyframes | Often gated | **Free** — runs on the user's GPU |
| AI assistant edits | Credits per action | **Nearly free to us** — Kimera Brain's 5-tier cascade makes the LLM the *last* resort; most commands resolve deterministically at zero token cost |

Structural cost advantages no competitor can copy quickly:

1. **Local-first compute** — the user's machine does the work. Our COGS for the core product
   is bandwidth + a Postgres box.
2. **Kimera Brain token frugality** — tiers 0–4 answer most requests without an LLM call.
   Where CapCut pays cloud GPU for every AI action, we pay tokens only on the hard residue.
3. **The prompt bridge** — users who refuse to pay can route AI through *their own* chat AI
   for free. This is a conversion funnel, not a leak: it proves the value, then we sell
   convenience (one click vs copy-paste).
4. **BYOK is already scaffolded** — `GenerationProvider = "fal" | "local" | "byo"` and the
   `byoKey` availability flag exist in `packages/shared/src/skills/model-registry.ts`.
5. **The render manifest contract** — deterministic, renderer-agnostic composition data is
   itself a licensable asset (embed/API play, Phase 4).

**Marketing headline this buys us:** *"The editor is free. Forever. No watermark, no export
limit, no Pro tier for creativity. You only pay when we pay."* CapCut's May-2025 price hike
($9.99 → $19.99/mo) created a large, angry, price-sensitive audience actively looking for
exactly this promise — especially in India, where our wallet packs are already INR-priced.

---

## 2. What the market proves (research, July 2026)

- **CapCut**: ~$815M revenue in 2025 (top-grossing photo/video app), up from ~$100M in 2023.
  Mix: Pro subscription ($19.99/mo), AI credits pegged at **$0.01/credit** (packs from $4.99
  per 100; Pro includes 1,200/mo), and storage add-ons (100GB–3TB). Proof that credits +
  storage + subscription coexist at massive scale.
- **Canva**: ~$4B ARR end of 2025, 265M MAU, 31M paid — a **3–6% free→paid conversion** is
  enough when the free tier drives viral acquisition. Conversion levers: contextual upgrade
  prompts, trials, brand kits, teams.
- **AI video generation** (Runway/Pika/Kling): all credit-metered. Runway ~5–12 credits/sec
  of video; Kling's **daily free credit refill** (66/day) is the acquisition pattern that
  builds habit without a hard paywall. Per-clip street price ranges $0.01–$0.50.
- **AI pricing economics** (Bessemer, Metronome, Tunguz): AI features run **50–65% gross
  margin** (vs 80–90% classic SaaS); the winning model in 2025–26 is **hybrid** — a small
  predictable base + usage. Two hard warnings: (a) *reselling inference at cost is a
  zero-margin payment rail, not a business*; (b) if credits map 1:1 to tokens, users compute
  your markup — so **price on value units** (per second of generated video, per minute of
  cloud render), not on tokens. PostHog's transparent ~20% LLM markup + 50% credit rollover
  is the trust-building reference. Foundation-model costs fall 50–90%/yr — value-unit pricing
  means margins improve automatically while prices stay flat.
- **Marketplaces**: Envato moved to a flat **50% take** (2026), Creative Market takes 40%.
  A 20–30% take rate radically undercuts both and is still nearly pure margin on plugins/
  templates (we host manifests, not GPUs).
- **India**: creator economy ~$15–38B in 2025–26 growing ~20% CAGR; subscriptions +
  micropayments are already a ~$3B pool; **UPI micro-purchases beat subscriptions** for
  first-money — one-time ₹29–₹99 packs (which `walletPacks` already models) match how Indian
  creators actually pay. Only 8–10% of Indian creators monetize effectively → they are
  cost-sensitive *and* revenue-hungry: perfect audience for "free editor, pay per burst."

Sources: see §8.

---

## 3. Revenue streams (ranked by sequence, not size)

### Stream A — Metered AI credits (the core engine)
**What burns credits (all have real COGS):**
- Cloud image/video/audio generation (fal.ai via `generationRouter.service.ts`)
- Cloud LLM assistant calls *above a free daily allowance* (`aiGateway.service.ts`) — the
  Brain's cascade means most users never exceed the allowance; heavy users pay
- Cloud transcription (`geminiTranscription.service.ts`) when local ASR isn't viable
- Future cloud tool adapters (the `cloud` adapter type is already contract-stubbed)

**What never burns credits:** everything browser-side, the prompt bridge, exports, stock
browsing (Pexels/Pixabay are free APIs — bandwidth-only; keep free as an acquisition weapon).

**Pricing rules:**
- Value units, not tokens: *per second of generated video, per image, per minute of cloud
  transcription*. Publish the number. Never expose token math.
- Cost-plus targeting **55–65% blended gross margin**; audit quarterly as model costs fall.
- **Daily free allowance** (Kling pattern) instead of a one-time trial: e.g. N assistant
  calls + a couple of small generations per day. Builds habit; resets scarcity daily.
- Keep the existing INR one-time packs (₹29/₹49/₹99 UPI micropurchases) as the primary
  Indian on-ramp; add USD packs for global.
- **Rollover**: unused purchased credits last ≥ 1 year (CapCut does 2); subscription-granted
  credits roll 50% (PostHog pattern). Generosity here is cheap and buys trust.
- **BYOK**: user's own fal/OpenAI/Gemini key → zero credit burn (or a token platform fee
  later, only if support cost demands it). BYOK users are power users; they become the
  marketplace's creators and the product's evangelists. This is the trust feature that makes
  "we only charge what costs us" *verifiable*.

### Stream B — Cloud subscription (predictable base for hard costs)
One plan, not a ladder (add tiers only when data demands it): **Kimera Cloud**, ~₹199–₹499/mo
India (~$8–12 global), bundling:
- **Cloud render** — the worker's Remotion + BullMQ pipeline is real; sell background /
  faster-than-realtime / batch / 4K renders as *convenience* (local export stays free —
  never violate the doctrine)
- **Cloud storage & sync** — media library already models opt-in cloud upload
  (MEDIA_LIBRARY.md); price per GB above a free quota, like CapCut's storage add-ons
- **Monthly credit grant** at better-than-pack rates (hybrid base+usage, the proven model)
- Priority generation queue

Explicitly *not* in the subscription: any editing capability, any export watermark/limit,
any "Pro effects." The subscription sells compute and convenience, never creativity.

### Stream C — Creator marketplace (the compounding asset)
The plugin architecture (GLSL transition/effect manifests — this week's junction-drop work
carries `PluginTransitionManifest` end to end), templates-as-module-stacks, and brand kits
are all sellable creator artifacts:
- Creators sell **plugins, template stacks, LUT/grade presets, caption styles**; buyers pay
  via UPI/card; we take **20–30%** (vs Envato 50%, Creative Market 40%) — near-pure margin.
- Free marketplace tier stays (community plugins) — the paid shelf sits beside it.
- Later: CapCut-style **affiliate/creative-partner program** — creators earn commission
  bringing users; in India, creator distribution is the cheapest CAC available.

### Stream D — Copyright/rights services (paid because it costs us)
The FUTURE_PLANS.md "Export Safety Check" (ACRCloud/AudD audio fingerprinting, license
tracking, Rights Report) has real per-scan API cost → fits the doctrine perfectly as a
credit-metered or subscription-bundled feature. High willingness-to-pay: a YouTube claim
costs a creator far more than a scan.

### Stream E — Platform plays (year 2+)
- **Teams/Brand** (the Canva ladder): shared brand kits, review links, roles.
- **Embed/API licensing**: the deterministic render manifest + headless Remotion worker is
  an "editor + render farm in a box" for other products; B2B licensing at SaaS margins.
- **Enterprise/agency**: seats, SSO, priority support.

---

## 4. Unit-economics guardrails (non-negotiable)

1. **Never resell inference at cost** — every metered unit carries margin or doesn't ship.
2. **Value-metric pricing** — the credit price of "1s of generated video" is the contract;
   our underlying model/cost mix is our business. Falling model costs = our margin, not a
   forced repricing.
3. **Results stay editable timeline data regardless of payment state** (existing repo rule —
   now doctrine). No hostage exports, no gated re-edits of already-generated artifacts.
4. **Shadow-bill before real-bill** — never guess willingness; measure it (Phase 0).
5. **Transparent markup posture** — publish roughly what things cost us vs what we charge
   (PostHog-style). Our whole brand is "we only charge what costs us"; opacity kills it.
6. **India-first pricing psychology** — one-time UPI packs before subscriptions; ₹ anchors
   (₹29 impulse tier); subscriptions only for storage/render where recurring cost is real.

---

## 5. Roadmap

### Phase 0 — Instrument & shadow-bill (now → +4 weeks)
*Goal: know our real costs and the users' real demand before charging a rupee.*
- **Cost telemetry ledger**: log actual provider spend per action (fal request cost, LLM
  tokens×price, Gemini transcription minutes) into a per-user usage ledger (extend the
  existing `WalletTransaction` model with a `debit`/`usage` type and provider-cost fields).
- **Billable-surface registry**: turn `estimatedCostCredits` in `catalog.ts` /
  `toolCapabilityDefinitions` from decorative metadata into a real price table with a single
  shared `creditCost(action, units)` function — one source of truth for UI badges, shadow
  billing, and future enforcement.
- **Shadow billing**: everything stays free, but the wallet UI shows "this used N credits
  (free during beta)". Measures per-feature demand + would-be ARPU with zero conversion risk.
- Decide value units per surface: `/s` video gen, `/image`, `/min` cloud transcription,
  `/min` cloud render.

### Phase 1 — Real money on hard costs (+1–2 months)
- **Payments**: replace the mock provider behind `payment.service.ts` with **Razorpay**
  (UPI/cards, India) + **Stripe** (global). The provider abstraction already exists; keep it.
- **Enforce credit debits** on: cloud generation, cloud transcription, cloud LLM calls above
  the free **daily allowance**. Debit at completion, refund on provider failure.
- **BYOK settings UI** — wire the existing `byoKey` availability flag: user pastes a fal/LLM
  key (stored client-side/encrypted), router prefers it, zero credit burn.
- **Pricing page** with the doctrine as the headline + the transparency table.
- Keep packs one-time (₹29/₹49/₹99 + a ₹249 tier); no subscription yet.
- KPIs: % of MAU hitting the daily allowance ceiling; pack purchase conversion (target 1–2%
  of active editors initially; Canva's mature 3–6% is the ceiling); blended margin ≥ 55%.

### Phase 2 — Kimera Cloud subscription (+2–4 months)
- Ship **cloud render** as a paid queue on the existing worker (BullMQ mode is already
  built; needs hosting + artifact delivery), and **cloud storage** quotas on the media
  library's opt-in upload path.
- One plan: monthly credits + storage GB + priority renders + background exports.
- Credit rollover rules (50% for granted, 12mo for purchased).
- KPIs: subscription attach rate among credit buyers (target 15–25%); storage/render COGS
  per subscriber vs price; churn < 5%/mo.

### Phase 3 — Marketplace + creator flywheel (+4–8 months)
- Marketplace beta: paid plugins/templates/preset packs; **80/20 creator split at launch**
  (announce loudly against Envato's 50%); UPI payouts; license metadata on every item
  (dovetails with Stream D's rights tracking).
- Creator partner/affiliate program (CapCut pattern) for distribution.
- Ship the **Export Safety Check** (ACRCloud/AudD) as a credit-metered scan.
- KPIs: marketplace GMV, take-rate revenue, % of new users arriving via creator links.

### Phase 4 — Platform & teams (+8–14 months)
- Teams/brand-kit tier; review/share links (free, watermarkless — they're also acquisition).
- Embed/API licensing pilot with 1–2 design partners (the render-manifest contract is the
  product).
- Revisit pricing with 12 months of cost telemetry; model costs will have fallen — bank the
  margin or cut credit prices publicly (both are wins; cutting prices publicly is marketing).

---

## 6. Revenue model sketch (illustrative, sanity-check math)

Assume 100k MAU at month 12 (India-weighted), doctrine intact:
- **Credits**: 2% buy packs monthly at avg ₹120 → ~₹2.4L/mo (~$2.9k) at ≥55% margin.
- **Kimera Cloud**: 0.7% subscribe at ₹299 → ~₹2.1L/mo (~$2.5k), margin dominated by
  storage/render COGS (~50–60%).
- **Marketplace**: early GMV ₹5L/mo at 20% take → ₹1L/mo, ~90% margin.
- Total ≈ ₹5.5L/mo (~$6.6k) at 100k MAU — small, but every stream scales linearly with MAU
  and the free-forever editor is the MAU machine. CapCut's curve ($100M → $815M in two
  years) shows what the same mix does at 100M+ MAU; Canva shows 3–6% conversion is
  achievable at maturity (≈3× the numbers above without adding a single stream).

The strategic bet: **acquisition is the bottleneck, not monetization** — so the free editor
(our zero-COGS advantage) is the growth engine, and monetization deliberately never touches
it.

---

## 7. Risks & mitigations

- **Credits feel like a tax** → daily free allowance + prompt bridge + BYOK mean nobody is
  ever *blocked*; paying is always the convenience path, not the capability path.
- **Margin compression if a competitor gives generation away** → our editor is the moat, not
  the generation; generation is pass-through economics for everyone.
- **Marketplace cold start** → seed it ourselves (we already build plugin-format transitions
  in-house), pay the first 20 creators guaranteed minimums.
- **India ARPU is low** → UPI packs monetize breadth; USD/global pricing monetizes depth;
  marketplace + embed licensing are currency-agnostic.
- **Trust collapse if we gate something creative "just once"** → doctrine is public and
  written down (§4.3). Every PR touching billing gets reviewed against §4.

---

## 8. Research sources

- CapCut: [revenue & growth stats](https://sendshort.ai/statistics/capcut/) ·
  [credit rules](https://www.capcut.com/clause/credits-rule) ·
  [what credits are](https://www.capcut.com/help/credits-in-capcut) ·
  [2026 price-hike analysis](https://fluxnote.io/guides/capcut-pro-pricing-2026) ·
  [business model](https://breakevenpointcalculator.com/how-does-capcut-make-money-business-model-explained/)
- Canva: [Sacra revenue/valuation](https://sacra.com/c/canva/) ·
  [stats 2026](https://techrt.com/canva-statistics/) ·
  [conversion strategy](https://www.getmonetizely.com/articles/how-did-canva-pro-convert-millions-of-free-users-to-paying-customers) ·
  [freemium benchmarks](https://chartmogul.com/reports/saas-conversion-report/)
- AI pricing economics: [Bessemer AI pricing playbook](https://www.bvp.com/atlas/the-ai-pricing-and-monetization-playbook) ·
  [Metronome on credit models](https://metronome.com/blog/the-rise-of-ai-credits-why-cost-plus-credit-models-work-until-they-dont) ·
  [Tunguz — selling inference](https://tomtunguz.com/so-you-want-to-sell-inference/) ·
  [credit-pricing pitfalls](https://softwarepricing.com/blog/credit-based-pricing-ai/) ·
  [Chargebee prepaid-credit guide](https://www.chargebee.com/pricing-labs/prepaid-credit-pricing-guide/)
- Gen-video pricing: [Runway pricing](https://runwayml.com/pricing) ·
  [cost-per-video comparison](https://www.vo3ai.com/ai-video-generator-pricing-comparison)
- Marketplaces: [Envato flat 50% move](https://www.therepository.email/envato-ends-exclusive-author-model-moves-all-marketplace-sellers-to-flat-50-revenue-share) ·
  [Canva Creators](https://www.canva.com/help/canva-creators-program/)
- India: [BCG creator-economy report](https://web-assets.bcg.com/c8/35/2a008ddf4e049d99a901b17233f0/gift-report.pdf) ·
  [market forecast](https://www.coherentmarketinsights.com/industry-reports/india-creator-economy-market) ·
  [monetization guide 2026](https://ownstreet.in/blog/india-creator-economy-2026-platforms-monetization-guide) ·
  [Elevation Capital consumer monetization](https://www.elevationcapital.com/perspectives/the-founders-guide-to-consumer-app-monetization-part-one)
