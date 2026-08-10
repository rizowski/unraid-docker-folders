# DESIGN.md

The design system for the Unraid Docker Folders Modern frontend.

This document is **normative**. When existing code disagrees with it, the code is
wrong — fix the code, don't amend the doc. If a change genuinely requires
breaking a rule, the commit message must say which rule and why.

It has two parts:

- **Part I — Guardrails** (§1–9): the hard constraints. What the plugin must
  look like, and the failure modes to avoid. Read before any UI change.
- **Part II — System reference** (§10–16): the mechanics. Theme bridge, the
  Unraid CSS reset, button vocabulary, modal contracts, forms, scale.

The **review checklist** at the end is the last thing to run before committing.

Source of truth for tokens and global rules:
`src/frontend/src/assets/styles/main.css`.
Reference implementations: `FolderEditModal.vue`, `ConfirmModal.vue`,
`ComposeFileEditor.vue`.

---

# Part I — Guardrails

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
  The full token table is in §10.
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
  Two sanctioned exceptions, both encoding state rather than decoration:
  1. The folder header's expanded-state tint — the folder's color at ~12%
     fading to transparent on the right. It encodes state (expanded) and
     identity (the folder's own color). Do not add a second gradient.
  2. `.status-halo` — a feathered `box-shadow` around a container icon
     carrying run/health state (`-success` / `-info` / `-error` / `-muted`).
     It replaced a separate status dot and bar, so it removes chrome rather
     than adding it, and it is the *only* glow in the plugin. Do not give it a
     second meaning (hover, selection, drag) and do not add another glow.
- Shadows only on floating overlays (modals, dropdown menus: `shadow-lg`) and
  the existing `shadow-sm` on cards. Nothing else casts a shadow.
- Border radius: `rounded` (4px) is the default and the maximum for
  rectangles. `rounded-full` only for dots, pills, and circular buttons.
  **`rounded-lg` and above are banned** for panels, cards and inputs — with one
  carve-out: floating overlays (modal cards and dropdown menus) use
  `rounded-lg` (8px). See the radius scale in §15.
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
  ceiling for attention effects. The full motion scale is in §15.
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
- `yarn dev` is light-only; see the dark-theme recipe in §16.

---

# Part II — System reference

## 10. Theming internals

There are **two distinct CSS variable namespaces**. Don't conflate them.

### Unraid-provided variables (upstream)

The Vue app runs in an iframe, which isolates it from Unraid's global CSS — but
also from Unraid's theme variables. `DockerFoldersMain.page` reads them off the
parent `documentElement` and passes them as a URL-encoded JSON `?theme=` param;
`src/frontend/src/main.ts` applies them back onto `document.documentElement`.

Ten variables cross the bridge:

```
--text-color          --background-color    --border-color
--header-background   --header-text-color
--button-background   --button-hover        --button-text-color
--input-background    --input-border
```

Always consume these with a fallback: `var(--text-color, #1a1a1a)`.

### Derived tokens (ours)

`main.css` maps the above into Tailwind v4 `@theme` tokens, which generate the
utility classes we actually write:

| Token | Utility | Source |
|---|---|---|
| `--color-text` | `text-text` | `--text-color` |
| `--color-text-secondary` | `text-text-secondary` | text 65% → background (see §16) |
| `--color-bg` | `bg-bg` | `--background-color` |
| `--color-bg-card` | `bg-bg-card` | background + 3% text |
| `--color-bg-input` | `bg-bg-input` | background + 8% text |
| `--color-border` | `border-border` | `--border-color` |
| `--color-primary` | `bg-primary` / `text-primary` | `--header-background` |
| `--color-primary-text` | `text-primary-text` | `--header-text-color` |
| `--color-input-bg` | `bg-input-bg` | `--input-background` |
| `--color-input-border` | `border-input-border` | `--input-border` |
| `--color-success` | `text-success` | fixed `#4caf50` |
| `--color-error` | `text-error` | fixed `#f44336` |
| `--color-warning` | `text-warning` | fixed `#ff9800` |
| `--color-muted` | `text-muted` | text 58% → background (see §16) |

The four semantic colors are intentionally **not** themeable — success is green
on every Unraid theme.

### Rules

- **Never use raw Tailwind palette classes.** `text-green-400`, `bg-yellow-500`,
  `bg-red-100 text-red-800` — all wrong. Use the semantic tokens. Light-only
  pairs like `bg-green-100 text-green-800` look broken on dark themes.
- **Never use `text-white`.** Use `text-primary-text` (`--header-text-color`).
  A theme with a light header background renders white-on-white.
- **Hover and surface tints must be theme-agnostic.** Mix the *text* color into
  transparent so the tint works on light and dark alike:
  ```css
  background: color-mix(in srgb, var(--text-color, #1a1a1a) 8%, transparent);
  ```
  Established steps: 5% (row hover), 6% (button rest), 8% (button hover, menu
  item hover), 10% (stats bar track).
- Alpha modifiers on tokens are fine for chips and banners:
  `bg-error/15`, `bg-primary/15`, `bg-warning/20`, `bg-error/10`.

---

## 11. The Unraid CSS reset — read this before styling a button

Unraid's webgui sets `html { font-size: 62.5% }` (10px base), which breaks
Tailwind's rem-based scale, and applies heavy global styles to `button`,
`input`, `p`, `a` and `table`. `main.css` counters this:

- `#unraid-docker-folders-modern { font-size: 16px }` restores the rem base.
- The `.unapi` class on the app root opts out of Unraid's button/input styles
  (Unraid guards them with `:where(:not(.unapi *))`).
- `#unraid-docker-folders-modern button:not(.nav-btn)` zeroes `padding`,
  `border`, `border-radius`, `background`, `font-size`, `font-weight`,
  `letter-spacing`, `text-transform`, `min-width` and `margin`.

**The reset is unlayered; Tailwind utilities live in `@layer utilities`.**
Unlayered rules beat *every* layered rule regardless of specificity, so this is
not a specificity contest a utility can win. On a plain `<button>`, `p-1.5`,
`rounded`, `bg-*` and `hover:bg-*` are **dead** — the reset's `padding: 0`,
`border-radius: 0` and `background: none` always apply. On a plain `<input>`,
`w-full`, `py-2 px-4`, `border`, `bg-input-bg` are dead the same way, and the
field renders as bare text with no box at all. Utilities that set a property the
reset never touches (`text-sm`, `w-8`, `color`, `box-shadow`) do survive.

A control must therefore carry one of the sanctioned opt-in classes, each
written unlayered in `main.css` with `#id + element + class` specificity. The
input reset **excludes** `.styled-input` and `.form-input` by name rather than
relying on those classes to out-specify it: `:not()` contributes its argument's
specificity, so `#id input:not(.styled-input)` and `#id input.form-input` both
compute to (1,1,1) and the winner would come down to source order.

| Control | Class |
|---|---|
| Text button | `.nav-btn` (§12) |
| Icon-only button | `.icon-btn`, `+ .icon-btn-round` for modal close × |
| Text input / select / textarea | `.form-input` (§14) |
| Monospace editor / log pane | `.styled-input` |
| Dropdown menu item | `.kebab-menu-item` |

Do not hand-roll a sixth option, and do not try to override a reset property
with a utility — put it on a wrapper element instead.

Parent-document modals (`useParentModal`) never hit any of this: Unraid styles
them natively. It only bites **in-iframe `BaseModal` content**, which is why the
schedules components are where it surfaced.

---

## 12. Buttons

| Use | Class |
|---|---|
| Secondary / Cancel / Close | `nav-btn` |
| Primary / Confirm / Save | `nav-btn active` |
| Destructive (in-iframe) | `nav-btn warning` |
| Toggle-on state | `nav-btn` + `:class="{ active: on }"` |
| Disabled | `:disabled` **and** `:class="{ 'opacity-50 cursor-not-allowed': cond }"` |

`.nav-btn` is 12px uppercase bold with 1px letter-spacing, `6px 10px` padding
(`8px 14px` at `sm:`), 4px radius, 1px border, and a 6% text-tint background.
It is an `inline-flex` with `gap: 6px`, so an inline SVG + label just works.

`.nav-btn.active` resolves to `--header-background` / `--header-text-color` —
byte-for-byte the same spec the parent-document modal uses for its `primary`
variant. In-iframe and parent-rendered modals therefore agree.

### Icon buttons

```html
<button class="icon-btn text-text-secondary hover:text-text" aria-label="…" title="…">
  <svg width="14" height="14" …/>
</button>
```

`.icon-btn` supplies the parts the reset would strip: `inline-flex` centring,
6px padding, 4px radius, and an 8% text-tint hover background. **Colour stays in
the template** so intent is visible — swap the hover token: `hover:text-primary`
(run/activate), `hover:text-error` (delete). It matches `button.icon-btn` and
`a.icon-btn`, so an icon that navigates can be a real anchor.

Round close buttons in modal headers add `.icon-btn-round` (32×32,
`rounded-full`, no padding). Every icon-only button needs an `aria-label`; add
`title` as well when a hover tooltip is useful.

Don't reach for `p-*`, `rounded*`, `bg-*` or `hover:bg-*` on these — see §11 for
why they do nothing.

### Utilities that silently lose to `.nav-btn`

The `.nav-btn` rule is `#unraid-docker-folders-modern button.nav-btn` —
id + element + class. It beats any single-class Tailwind utility, so on a
`.nav-btn` these are **dead**: `m-*`/`ml-*`/`mt-*` (it sets `margin: 0`),
`p-*`/`px-*`/`py-*`, `border*`, `rounded*`, `bg-*`, `text-[size]`,
`font-*`, `tracking-*`, `min-w-*`. Put margins on a wrapper element instead.
`w-fit` is safe and usually wanted — `.nav-btn` is `inline-flex`, which would
otherwise stretch inside a `flex flex-col`.

Note `.nav-btn` matches only `button` and `a`. On an `<input>` the class does
nothing — style those with utilities.

---

## 13. Modals

### Two surfaces

Every modal exists twice:

1. **In-iframe** — `BaseModal.vue`, guarded by `v-if="!inIframe"`.
2. **Parent document** — described declaratively through `useParentModal.ts` and
   rendered by `DockerFoldersMain.page` into `#dfm-modal-card`.

On a real Unraid box the parent surface is what users see; the in-iframe one is
the dev-server fallback. **Prefer `useParentModal` for new modals.** Fall back to
`BaseModal`-only when the form is too dynamic for the descriptor's field types
(no repeatable-list field exists) — the schedules modals are the current
exception, and they are documented as such. In-iframe content must use the
opt-in control classes from §11; the parent surface does not.

**Never open a modal from inside another modal.** A second `BaseModal` teleports
to the app root so it *renders* correctly, but two stacked scrims over a card
the user was already reading is not the house style. Put the secondary content
inline in the first modal's body instead — `ScheduleList` renders its add/edit
form (`ScheduleForm.vue`) above the schedule rows and hides the "+ Add Schedule"
button while it is open. A sibling confirm (`ConfirmModal`) over a list is the
one accepted exception.

### Positioning contract

`BaseModal` positions its overlay with `position: absolute`, never `fixed`.
Inside an iframe with `scrolling="no"` the iframe is sized to its full content
height, so `fixed` resolves against that height rather than the user's visible
viewport. `useParentViewport.ts` reads `window.frameElement.getBoundingClientRect()`
to compute `visibleTop` / `visibleHeight`, and the overlay's inner wrapper is
placed at `top: visibleTop`.

That arithmetic is only correct when the overlay has **no positioned ancestor**,
so its containing block is the initial containing block at document y=0.
Therefore:

> **`BaseModal` teleports its overlay to `#unraid-docker-folders-modern`, and a
> `BaseModal` must never be nested inside another positioned overlay.**

Teleport to the app root, *not* `body` — `main.css` scopes `.nav-btn`,
`.styled-input`, `.kebab-menu-item` and the `box-sizing: border-box` reset under
that id, and all of them would silently vanish in `body`. The teleport uses
Vue's `defer` flag because the target isn't in the DOM during App's own render
(requires Vue ≥ 3.5).

### Chrome

```
header:  flex justify-between items-center p-4 sm:p-6 border-b border-border
         h2 (text-xl / text-2xl font-semibold)  +  round close ×
body:    p-4 sm:p-6            (or flex-1 overflow-auto … when fill-height)
footer:  flex justify-end gap-2 pt-6 border-t border-border
         <button class="nav-btn">Cancel</button>
         <button class="nav-btn active">Save</button>
```

Small confirm-style modals (`ConfirmModal`, `InputModal`) may drop the dividers
and the close ×, using `p-4 sm:p-6` blocks with a `pt-4`/`pt-2` footer. Anything
with a form gets the full chrome.

Widths — keep these aligned with the parent's `SIZE_MAP`:

| Size | `max-width` | Use |
|---|---|---|
| sm | 400–420px | confirm, single input |
| md | 500–560px | forms |
| lg | 640–760px | lists, editors |
| xl | 960px | — |

Card: `bg-bg-card rounded-lg shadow-lg`, `w-[90%]`, `max-height: 90%` with
`overflow: auto` (or `height: 85%` with `fill-height`). Scrim `bg-black/50`.
The card **must** keep the literal class `modal-content` — the fade/scale
transition in `main.css` targets it.

---

## 14. Forms

Standard field:

```html
<div class="flex flex-col gap-1">
  <label for="x" class="text-sm font-medium text-text">Label *</label>
  <input id="x" class="form-input" />
</div>
```

`.form-input` is the opt-in class for ordinary inputs, selects and textareas:
full width, `8px 12px` padding, 1px `--color-border`, 4px radius, and
`--color-bg-input` (background + 8% text) as the fill. Focus moves the border to
`--color-primary`. Modifiers, combinable:

| Modifier | Effect |
|---|---|
| `.compact` | `6px 10px` / 13px — fields inside a grouped or nested block |
| `.mono` | monospace face, standard chrome — paths, cron expressions |
| `.auto-width` | intrinsic width — time pickers, day selects |

Use `--color-bg-input`, **not** `--color-input-bg`: Unraid does not actually
define `--input-background`, so that token falls back to white and is unreadable
on dark themes. Same for `--color-border` over `--color-input-border`.

To constrain a field's width, put the width on a wrapper — `.form-input` sets
`width` from an unlayered rule, which a layered `w-*` utility cannot override
(§11).

`.styled-input` remains the **monospace editor** variant — YAML, log panes.
It carries its own 12px padding and is not the default text input; prefer
`.form-input.mono` for a single-line path or cron value.

Helper and caption text: `text-xs text-text-secondary`. Validation errors:
`text-sm text-error`.

---

## 15. Scale reference

**Radius** — `rounded` (4px) is the default for buttons, inputs, badges and
rows; `rounded-lg` (8px) for modal cards and dropdown menus (the §2 carve-out
for floating overlays); `rounded-full` for pills, status dots, progress bars and
round icon buttons.

**Spacing** — `gap-1` icon-button clusters · `gap-2` footer buttons and inline
chips · `gap-3` row content · `gap-4` form field stacks · `p-4 sm:p-6` modal
chrome · `px-3 py-2 sm:px-6 sm:py-4` app root.

**Type** — `text-[10px]`/`text-[11px]` corner badges · `text-xs` metadata and
captions · `text-sm` body, labels, list rows · `text-base` compact modal titles ·
`text-xl`/`text-2xl` full modal titles. Weights: `font-medium` labels,
`font-semibold` headings, `font-bold` micro-badges.

**Z-index** — `z-50` cards with an open menu · `z-[100]` kebab dropdowns ·
`z-[1000]` in-iframe modal overlays · `10000` the parent-document overlay.
In-iframe overlays are all at the same level and stack by DOM order.

**Motion** — `0.15s` hover/color transitions · `150ms` card enter · `200ms`
modal fade+scale, expand/collapse grid, view-mode slider · `300ms` progress
bars · `600ms` state-change pulse · `2s` new-log-line highlight. Prefer the
existing shared classes (`.expand-grid`, `.state-change-pulse`,
`.container-card-enter`) over new one-off keyframes.

---

## 16. Known limitations

Recorded deliberately — do not "fix" these without evidence.

- **`--text-color-secondary` is never bridged — resolved by deriving instead.**
  That variable is not in `DockerFoldersMain.page`'s bridge list, so
  `--color-text-secondary` used to fall back to a hardcoded `#666666` on every
  theme. On a dark theme that is **3.0:1** against `#1a1a1a` — below AA, and the
  log pane renders 11px monospace in it. `main.css` now derives both greys from
  the bridged `--text-color`, mixed **toward `--background-color`**:
  `color-mix(in srgb, var(--text-color, #1a1a1a) 65%, var(--background-color, #f2f2f2))`
  for `--color-text-secondary` and 58% for `--color-muted`. Mixing toward the
  background rather than `transparent` keeps the result opaque, so the
  `bg-text-secondary` / `border-text-secondary` usages don't turn translucent.
  The ratios reproduce the old light-theme values exactly (`#666666`,
  `≈#757575`), so only dark themes change. **Edge case, measured:** if
  `--text-color` fails to bridge while `--background-color` succeeds, the mix
  collapses to same-on-same. This is *not* a new failure — `--color-text` has
  always been `var(--text-color, #1a1a1a)`, so in that scenario 33 of 60 sampled
  text elements were already background-coloured before this change. The page is
  already unusable; secondary text simply stops being the accidental exception.
  Guarding it isn't worth the complexity. Keep using `text-text-secondary` /
  `text-muted` — do not reintroduce hardcoded greys.
- **Destructive buttons disagree across surfaces.** In-iframe, danger maps to
  `.nav-btn.warning` (amber `#ff9800`); the parent modal renders `danger` as red
  `#dc2626`. Don't repurpose `.warning` — `App.vue` uses it for the drag-lock
  toggle. Follow-up: add a `.nav-btn.danger` variant additively and point
  `ConfirmModal`'s danger path at it.
- **`useModalElevation.ts` is dead.** It posts a legacy
  `{ type: 'docker-folders-modal', open, minHeight }` message that
  `DockerFoldersMain.page` now explicitly ignores. Harmless; left in place.
- **`color-mix` degrades.** Tailwind emits a non-`color-mix` fallback in which
  `bg-bg-card` and `bg-bg-input` collapse to the plain page background — cards
  lose their separation. Secondary text now depends on `color-mix` too, but
  with higher stakes: an invalid `color:` value falls back to *inherited*,
  which can land same-on-same. That is why `--color-text-secondary` and
  `--color-muted` keep a hardcoded base in `@theme` and are only upgraded
  inside `@supports (color: color-mix(in srgb, red, blue))`. Don't move those
  declarations back into `@theme`. Only affects browsers without `color-mix`.
- **Dev is light-only.** `yarn dev` never passes `?theme=`, so theme
  regressions are invisible there. To check dark, append a URL-encoded theme
  param, e.g.
  `?theme={"--text-color":"#f2f2f2","--background-color":"#1a1a1a","--border-color":"#333","--header-background":"#ff8c2f","--header-text-color":"#fff"}`.
- **The `.page` files are a parallel system.** `DockerFoldersMain.page` and
  `DockerFoldersSettings.page` hand-roll inline styles with dark fallbacks
  (`#333`, `#1a1a1a`), while `main.css` uses light ones (`#e0e0e0`, `#f2f2f2`).
  The two halves disagree about what "no theme" means.

---

## Review checklist (the "AI tells" deny-list)

Before committing UI work, grep yourself against this list. Any hit is a bug:

- [ ] Gradient backgrounds or gradient text (except the folder-header
      expanded tint — §2)
- [ ] `rounded-lg`/`xl`/`2xl` on panels, `shadow-md`+ on non-overlays
- [ ] Tailwind palette color classes (`*-blue-*`, `*-slate-*`, `*-purple-*`, …)
- [ ] A second accent color; purple/indigo anything
- [ ] Emoji in templates or UI strings
- [ ] `backdrop-blur`, glassmorphism, glow effects (except `.status-halo` — §2)
- [ ] Headings above `text-lg`; marketing-style hero/empty states
- [ ] Hover `scale-*` transforms, entrance animations, shimmer skeletons
- [ ] Whitespace padding `p-6`+ on ordinary panels
- [ ] A new component that duplicates an existing pattern with different styling
