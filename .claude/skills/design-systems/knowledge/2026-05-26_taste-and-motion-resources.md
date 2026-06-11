# Taste & Motion Resources — Anti-Slop Frontend Intelligence (2026-05-26)

**Source:** Integration of five design resources into the Energy design harness — two OSS agent-skill frameworks (tasteskill, Impeccable), one copy-paste motion library (motionsites.ai), and two existing Claude design skills (anthropic-frontend-design, ui-ux-pro-max). Read this alongside `frontend-bible-2026.md`, `anti-patterns.md`, and `scroll-interactions-2026.md`.

**Why this exists:** Our harness already had strong opinions (warm-black, Instrument Serif + Poppins, OKLCH, 200-500ms motion). These five resources sharpen the _anti-slop_ edge — the specific reflexes an LLM has toward generic UI, and the concrete countermeasures. The single highest-leverage idea across all five: **AI design slop is a set of statistical defaults (Inter, purple gradients, centered hero, 3-equal-cards, pure black, bounce easing). Name every default, then ban it.**

---

## What Each Resource Contributes

| Resource                                 | What it is                                                                                                                                                                    | Key contribution to our harness                                                                                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tasteskill** (`tasteskill/tasteskill`) | "The Anti-Slop Frontend Framework for AI Agents." Portable agent skills with three tunable dials.                                                                             | The **3-dial model** (variance/motion/density) + the most concrete "AI tells" forbidden-pattern list in existence + the **Double-Bezel** nested-card technique.                                                                    |
| **Impeccable** (`pbakaus/impeccable`)    | "The design language that makes your AI harness better at design." 7 domain references + 27 deterministic anti-pattern checks + 12 LLM critiques. Built on Anthropic's skill. | The **numeric backbone**: 4pt spacing, 100/300/500 motion durations, exact easing curves, OKLCH tinted-neutral recipe, modular type scale. Plus a shared **command vocabulary** (`/polish`, `/audit`, `/quieter`).                 |
| **motionsites.ai**                       | Copy-paste pre-built animated landing components (heroes, reveals, footers, cursors). React/Tailwind/Motion.                                                                  | A **motion-component pointer library** — named patterns to reach for (Reveal Hero, Cursor Follow, staggered footers) instead of inventing from scratch. Copy → paste → adapt to our tokens.                                        |
| **anthropic-frontend-design**            | Existing Claude skill (`.claude/skills/anthropic-frontend-design/`). Anthropic's official anti-slop frontend skill.                                                           | The **commit-to-a-bold-direction** mandate + the canonical "NEVER generic AI aesthetics" list (Inter/Roboto, purple-on-white, predictable layouts). Impeccable extends this — treat them as one lineage.                           |
| **ui-ux-pro-max**                        | Existing Claude skill (`.claude/skills/ui-ux-pro-max/`). 50+ styles, 161 palettes, 57 font pairings, 99 UX rules across 10 stacks.                                            | The **accessibility + interaction-state floor** (contrast 4.5:1, 44×44 touch, focus rings, loading/empty/error states, reduced-motion) and a priority-ordered review matrix. This is the QA gate; the others are the taste engine. |

**The lineage:** anthropic-frontend-design is the seed → Impeccable is the rigorous, numeric extension of it → tasteskill is the aggressive, archetype-driven sibling → ui-ux-pro-max is the accessibility/UX floor → motionsites.ai is the parts bin. Use Impeccable + tasteskill for _taste decisions_, ui-ux-pro-max for _the audit gate_, motionsites.ai for _motion parts_.

---

## Concrete Rules to Adopt (Net-New or Sharpened)

### Typography (from Impeccable + tasteskill)

- **Fewer sizes, more contrast.** A 5-size system (xs/sm/base/lg/xl+) beats 8 sizes 2px apart. Pick ONE modular ratio (1.25 major-third, 1.333 perfect-fourth, or 1.5 perfect-fifth) and commit. Muddy hierarchy = too many close sizes.
- **Vertical rhythm = line-height as base unit.** If body is 16px/1.5 (=24px), spacing values are multiples of 24px. Text and space share one math.
- **Light-on-dark needs 3-axis compensation** (this is new and important for our warm-black default): bump `line-height` +0.05–0.1, add `letter-spacing` 0.01–0.02em, AND step body weight up one notch (regular→medium, or 400→350 in true dark). Perceived weight drops on all three axes — fix all three.
- **You often don't need a second font.** One family in multiple weights = cleaner hierarchy than two competing typefaces. Only add a second when you need genuine _contrast_ (display serif + body sans = our Instrument Serif + Poppins, which is correct).
- **Serif is BANNED on dashboards/software UI** (tasteskill). Serif is for editorial/marketing/brand registers only. Control hierarchy with weight + color, not just massive scale — "the first heading should not scream."
- **Fluid type (`clamp()`) for marketing headings; fixed `rem` for app UI.** No major design system uses fluid type in product UI. Bound clamp so `max ≤ 2.5× min`.
- **OpenType polish** (underused): `font-variant-numeric: tabular-nums` for data, `diagonal-fractions` for fractions, `all-small-caps` for abbreviations, `font-variant-ligatures: none` for code.

### Color (from Impeccable + tasteskill)

- **OKLCH only, never HSL.** `oklch(L C H)`. Reduce chroma as you approach white/black (high chroma at extreme lightness = garish).
- **Pure gray is dead. Tint every neutral** toward the brand hue with chroma 0.005–0.015 — subconscious cohesion, not consciously "tinted." Tint toward THIS project's hue, never reflexively warm-orange or cool-blue (those are the two laziest defaults and form their own monoculture).
- **One accent. Saturation < 80%.** "The LILA Ban" (tasteskill): AI-purple/blue glows + neon gradients are banned. Neutral base (zinc/slate, tinted) + ONE high-contrast accent (emerald, electric blue, deep rose). Accent works _because_ it's rare — 60/30/10 by visual weight, not pixel count.
- **Dark mode is NOT inverted light mode.** Depth from surface lightness, not shadow. Build a 3-step surface scale (e.g. 15%/20%/25% L), same hue+chroma as brand, vary only lightness. Desaturate accents slightly. Never pure black for large areas (oklch 12–18% L).
- **Alpha is a design smell.** Heavy rgba/hsla usually means an incomplete palette → unpredictable contrast. Define explicit overlay colors per context. Exception: focus rings + interactive see-through states.
- **Placeholder text still needs 4.5:1.** The light-gray placeholder everyone ships usually fails WCAG.

### Spacing & Layout (from Impeccable + tasteskill)

- **4pt base, not 8pt.** 8pt is too coarse (you constantly need 12px). Scale: `4, 8, 12, 16, 24, 32, 48, 64, 96`. Name tokens semantically (`--space-sm`), not by value. Use `gap` not margins for siblings.
- **The self-adjusting grid:** `repeat(auto-fit, minmax(280px, 1fr))` — responsive without breakpoints. **Container queries for components**, viewport queries for page layouts.
- **Cards are not required, and never nest cards in cards.** Spacing + alignment + subtle dividers create grouping. Use cards only when elevation communicates real hierarchy. For dense data, group via `border-t`/`divide-y`/negative space.
- **Anti-center bias:** centered hero/H1 is banned when variance > 4. Force split-screen (50/50), left-content/right-asset, or asymmetric whitespace.
- **The 3-equal-cards feature row is BANNED.** Use 2-column zig-zag, asymmetric bento, or horizontal scroll.
- **Optical adjustments:** text at `margin-left:0` looks indented → use `-0.05em`. Play icons shift right, arrows shift toward their direction. Touch target 44px via padding/pseudo-element even when visual is 24px.
- **Squint test for hierarchy:** blur the screen — can you still rank the top 3 elements? Use 2-3 dimensions at once (size 3:1 + weight + space), never size alone.

### Motion (from Impeccable + tasteskill — refines our 200-500ms rule)

- **The 100/300/500 rule** (more precise than our blanket "200-500ms"):

| Duration  | Use case                                       |
| --------- | ---------------------------------------------- |
| 100-150ms | Instant feedback (button press, toggle, color) |
| 200-300ms | State changes (menu, tooltip, hover)           |
| 300-500ms | Layout changes (accordion, modal, drawer)      |
| 500-800ms | Entrance animations (page load, hero reveal)   |

- **Exit ≈ 75% of enter duration.**
- **Don't use `ease`.** Use exponential curves: `--ease-out-quart: cubic-bezier(0.25,1,0.5,1)` (default), `--ease-out-expo: cubic-bezier(0.16,1,0.3,1)` (snappy). For long premium reveals tasteskill favors `cubic-bezier(0.32,0.72,0,1)`.
- **Bounce/elastic easing is BANNED** — trendy in 2015, now reads tacky/amateurish. Real objects decelerate, they don't bounce.
- **80ms threshold:** the brain buffers ~80ms; under 80ms feels instant. Target for micro-interactions.
- **Premium motion materials beyond transform/opacity:** blur reveals, `backdrop-filter` panels, clip-path/mask wipes, shadow bloom, gradient-position movement. The real rule isn't "transform+opacity only" — it's "never animate layout-driving props casually (`width`/`height`/`top`/`left`/margin), keep expensive effects bounded to small areas, verify smoothness in-browser." If blur makes it feel premium AND stays smooth, use it.
- **Stagger via CSS custom prop:** `animation-delay: calc(var(--i) * 50ms)`. Cap total stagger ≤500ms (10 items × 50ms).
- **Never `window.addEventListener('scroll')`** — continuous reflows kill mobile. Use IntersectionObserver / Motion `whileInView`, unobserve after first fire.
- **`will-change` only when animation is imminent** (`:hover`, `.animating`), never preemptively.

### Interaction & Output Completeness (from tasteskill + ui-ux-pro-max)

- **Generate ALL interaction states**, not just the happy path: skeleton loaders (matching layout, not generic spinners), composed empty states, inline error states, and tactile `:active` feedback (`-translate-y-[1px]` or `scale-[0.98]`).
- **Anti-emoji policy (CRITICAL):** never emoji as functional icons/alt-text. Use Phosphor (6 weights) or Radix icons; standardize stroke width globally (1.5 or 2.0).
- **Realistic content, not "Jane Doe" slop:** no "John Doe"/"Acme"/"Nexus"/"SmartFlow", no `99.99%`/`50%` round fake numbers (use messy `47.2%`), no filler verbs ("Elevate"/"Seamless"/"Unleash"/"Next-Gen"). No Unsplash links (use `picsum.photos/seed/<x>/800/600`). No SVG "egg" avatars.
- **`min-h-[100dvh]` not `h-screen`** for full-height heroes (iOS Safari viewport jump).
- **Grid over flex-math:** never `w-[calc(33%-1rem)]`; use `grid grid-cols-1 md:grid-cols-3 gap-6`.

### Premium Component Techniques (from tasteskill soft-skill — for "expensive" feel)

- **The Double-Bezel (Doppelrand):** premium cards/inputs look like machined hardware. Outer shell = wrapper with hairline border (`ring-1 ring-white/10`), small padding (`p-1.5`), large radius (`rounded-[2rem]`). Inner core = own background + inner highlight (`shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)]`) + concentric smaller radius (`rounded-[calc(2rem-0.375rem)]`).
- **Button-in-button trailing icon:** an arrow never sits naked next to text — nest it in its own circle (`w-8 h-8 rounded-full bg-white/10 flex items-center justify-center`), flush to the button's right padding.
- **Eyebrow tags before major headings:** `rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]`.
- **Macro-whitespace:** double standard section padding — `py-24` to `py-40`.
- **The 3 tunable dials** (adopt as a mental model for every build):
  - `DESIGN_VARIANCE` 1-10 (symmetry → asymmetric/bento)
  - `MOTION_INTENSITY` 1-10 (hover-only → scroll/magnetic/cinematic)
  - `VISUAL_DENSITY` 1-10 (art-gallery airy → cockpit dense)

---

## The 12-Point Anti-AI-Slop Checklist

Distilled from tasteskill's "AI Tells" + Impeccable's 27 deterministic checks + anthropic-frontend-design's banned list. Run before shipping any UI. Every box must honestly pass.

1. **No banned fonts.** Zero Inter / Roboto / Arial / Open Sans / Helvetica / system-default as the brand face. Distinctive display + refined body, contrasting on a real axis.
2. **No AI-purple.** No purple/blue glow, no neon gradient, no rainbow text-fill on large headings. ONE accent, saturation < 80%, used at ~10% visual weight.
3. **No pure black or pure gray.** `#000` and `oklch(L 0 H)` are banned for large areas. Tint all neutrals (chroma 0.005–0.015) toward the brand hue.
4. **No centered-hero default.** Asymmetric / split-screen / left-aligned-content unless density is genuinely low and centering is a deliberate editorial choice.
5. **No 3-equal-card feature row.** Asymmetric bento, zig-zag, or horizontal scroll instead.
6. **No card-in-card nesting, no card-everything.** Group with spacing/dividers/negative space; cards only when elevation means something.
7. **No bounce/elastic easing, no `linear`, no default `ease`.** Exponential ease-out curves; durations on the 100/300/500 scale; exit ≈ 75% of enter.
8. **No layout-property animation.** Never animate `width`/`height`/`top`/`left`/margin. Transform/opacity (+ bounded blur/filter when it earns premium feel).
9. **No emoji as icons.** Phosphor/Radix only, one global stroke width. No "egg" avatars, no thick default Lucide where precision is wanted.
10. **No happy-path-only UI.** Skeleton + empty + error + tactile `:active` states all present.
11. **No slop content.** No "John Doe"/"Acme"/"Lorem", no round fake numbers, no "Elevate/Seamless/Unleash" filler, no Unsplash hotlinks.
12. **Accessibility floor holds.** Contrast ≥4.5:1 (incl. placeholders), focus rings visible, touch ≥44px, `prefers-reduced-motion` honored (crossfade fallback, keep functional motion), text ≥11px, hierarchy passes the squint test.

---

## Motion-Component Library Pointer (motionsites.ai)

motionsites.ai is a **copy-paste parts bin** — when a section needs motion, reach for a named pattern, copy it, then re-skin to our tokens (warm-black, OKLCH accent, Instrument Serif, exponential easing). Do NOT ship their default colors/fonts — that reintroduces slop. Categories worth pulling from:

| motionsites category | Named patterns                                  | Map to our knowledge                                                                                                         |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Hero sections**    | Reveal Hero, Synapse Dark Hero, Aetheris Voyage | Pair with `scroll-interactions-2026.md` §7 text char-split + asymmetric (not centered) layout                                |
| **Interactive**      | Cursor Follow, Scroll Landing Page              | Magnetic button (§10) + custom cursor — but anthropic-skill/tasteskill caution: custom cursors hurt a11y/perf, use sparingly |
| **Footer/CTA**       | Lumina, Kresna, Zenith footers                  | Staggered reveal (§5) on enter                                                                                               |
| **Feature sections** | bento/feature grids                             | Asymmetric bento (never 3-equal), container-query cards                                                                      |

**Workflow:** (1) identify the section's job, (2) find the closest motionsites pattern, (3) copy the structure, (4) strip its palette/fonts/easing, (5) reapply our tokens + the 100/300/500 + exponential curves, (6) run the 12-point checklist. The library saves _structure_, not _taste_ — taste comes from this harness.

**Other copy-paste sources already in `frontend-bible-2026.md`:** Magic UI (bento, shine borders, meteors), Aceternity (3D cards, aurora, parallax heroes). motionsites.ai joins them as a peer parts bin.

---

## How This Updates the Harness

- **`anti-patterns.md`** — the 12-point checklist above is the canonical short-form; anti-patterns.md remains the long-form catalog. Cross-reference.
- **`scroll-interactions-2026.md`** — adopt the 100/300/500 durations and exponential easing tokens as the precise version of its timing rules; the Double-Bezel and stagger-via-custom-prop are new techniques to fold into card/list sections.
- **`color-theory.md` / `oklch-color-system.md`** — adopt the tinted-neutral chroma recipe (0.005–0.015) and the "tint toward THIS brand, never reflexive warm/cool" rule, and the 3-step dark-mode surface scale.
- **`typography-systems.md`** — adopt the 3-axis light-on-dark compensation and "you often don't need a second font."
- **The 3 dials** (variance/motion/density) — adopt as the opening question for every design brief: "where do we sit on each dial for THIS surface?"

**`.claude/rules/design.md` already encodes** warm-black `#141312`, Instrument Serif + Poppins, no-emoji, no-AI-purple, bento, Radix 12-step, Phosphor, prefers-reduced-motion. These five resources _validate and sharpen_ that rule file — no contradictions, only more precision.
