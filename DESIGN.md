# Design Guardrails

Rules for any change that touches templates, CSS, or `.page` markup. These are
**hard constraints, not suggestions**. If a change requires breaking one, the
commit message must say which rule and why.

## North star

This plugin is a **native part of the Unraid webgui**, not an embedded app.
Test: a screenshot of this page next to Unraid's own Docker page must look like
one product. Unraid's webgui is dense, flat, functional, and themed by the
user — the plugin inherits all four properties.

The failure mode to avoid is the "AI-built dashboard" look: gradient heroes,
oversized rounded cards, purple accents, emoji icons, airy whitespace,
marketing-style empty states. None of that belongs here.

---

## 1. Color

- **Only theme tokens** from the `@theme` block in
  `src/frontend/src/assets/styles/main.css` (`text`, `text-secondary`, `bg`,
  `bg-card`, `bg-input`, `border`, `primary`, `button`, `success`, `error`,
  `warning`, `info`, `muted`). **Never** raw Tailwind palette classes
  (`bg-blue-500`, `text-slate-400`, …) and never hex values in components.
- Need a color that has no token? Add a token to `@theme` first — derived from
  an Unraid CSS variable where one exists — then use it. That's a deliberate,
  reviewable act; sprinkling palette classes is not.
- **One accent.** The accent is Unraid's `--header-background`
  (`primary`) — the user chose it in their theme. Never introduce a second
  accent hue for emphasis, branding, or variety.
- `success`/`error`/`warning`/`info` mean **state**, nothing else. Never use a
  status color decoratively.
- Subtle fills (hovers, tracks, chips) use
  `color-mix(in srgb, var(--text-color) N%, transparent)` with N ≤ 10 — this is
  the established pattern and works on every theme.

## 2. Surfaces

- **Flat.** Panels are separated by `border-border` (1px) and background
  tokens, exactly like Unraid's own tables.
- **No gradients. No glassmorphism / `backdrop-blur`. No glow shadows.**
  One sanctioned exception: the folder header's expanded-state tint — the
  folder's color at ~12% fading to transparent on the right. It encodes state
  (expanded) and identity (the folder's own color), not decoration. Do not add
  a second gradient.
- Shadows only on floating overlays (modals, dropdown menus: `shadow-lg`) and
  the existing `shadow-sm` on cards. Nothing else casts a shadow.
- Border radius: `rounded` (4px) is the default and the maximum for
  rectangles. `rounded-full` only for dots, pills, and circular buttons.
  **`rounded-lg` and above are banned** for panels/cards/inputs.
- Nesting: at most card-inside-panel. No card-in-card-in-card.

## 3. Typography

- Working scale is **`text-xs` and `text-sm`**; `text-base`/`text-lg` only for
  modal/section titles. Anything larger needs a rule-break note.
- No decorative headings, no `font-black`, no letter-spacing tricks outside the
  existing `.nav-btn` uppercase pattern.
- Fonts: inherit (`clear-sans` from Unraid) and the existing monospace stack
  for logs/inputs. Never add a webfont.

## 4. Spacing & density

- This is a **control panel — density is a feature**. Default paddings are
  `p-2`/`p-3`, gaps `gap-2`/`gap-3`; section separation ≤ `mb-4`
  (`sm:mb-8` max for the page header).
- No hero sections, no centered feature layouts, no `p-8`+ breathing room, no
  large empty-state panels. An empty state is one line of `text-text-secondary`
  text, optionally with one small icon — never an illustration with friendly
  copy.

## 5. Iconography

- Icons are **inline stroke SVGs** (feather style: `stroke-width="2"`,
  `stroke-linecap="round"`, `fill="none"`), 14–18px, `currentColor`.
- **No emoji anywhere in the UI.** No icon fonts inside the Vue app
  (FontAwesome names are only for Unraid `.page` headers / folder icons where
  Unraid renders them). No illustrations, mascots, or decorative graphics.

## 6. Motion

- Transitions ≤ **200ms**, `ease`, on opacity/transform/background/border
  only. Existing exceptions (600ms state pulse, 2s log-line fade) are the
  ceiling for attention effects.
- Animation must communicate a **state change** (started, connected, new line).
  No entrance choreography, staggered reveals, hover scale-ups, bounces, or
  shimmer skeletons.

## 7. Language

- Labels are terse and literal: "Stop", "Check for Updates", "3 containers".
  No exclamation marks, no marketing adjectives ("powerful", "seamless"), no
  cutesy empty-state copy, no "✨".

## 8. Reuse before invention

- New UI must be assembled from the established patterns first: `nav-btn`,
  kebab menu, `styled-input`, stats bar, folder header, container card/row,
  `BaseModal`. A new visual pattern is only justified when no existing one
  fits — and it must be indistinguishable in family (color tokens, 4px radius,
  border-separated, dense).

## 9. Theming

- Every change must work on **both dark and light Unraid themes**. All the
  theme tokens resolve from Unraid CSS variables — if a style only looks right
  on one theme, it's wrong. Never assume a dark background.

---

## Review checklist (the "AI tells" deny-list)

Before committing UI work, grep yourself against this list. Any hit is a bug:

- [ ] Gradient backgrounds or gradient text
- [ ] `rounded-lg`/`xl`/`2xl` on panels, `shadow-md`+ on non-overlays
- [ ] Tailwind palette color classes (`*-blue-*`, `*-slate-*`, `*-purple-*`, …)
- [ ] A second accent color; purple/indigo anything
- [ ] Emoji in templates or UI strings
- [ ] `backdrop-blur`, glassmorphism, glow effects
- [ ] Headings above `text-lg`; marketing-style hero/empty states
- [ ] Hover `scale-*` transforms, entrance animations, shimmer skeletons
- [ ] Whitespace padding `p-6`+ on ordinary panels
- [ ] A new component that duplicates an existing pattern with different styling
