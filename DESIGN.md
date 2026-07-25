# DESIGN.md

Design system for the Unraid Docker Folders Modern frontend.

This document is **normative**. When existing code disagrees with it, the code is
wrong — fix the code, don't amend the doc. New UI must follow it.

Source of truth for tokens and global rules:
`src/frontend/src/assets/styles/main.css`.
Reference implementations: `FolderEditModal.vue`, `ConfirmModal.vue`,
`ComposeFileEditor.vue`.

---

## 1. Theming

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
| `--color-text-secondary` | `text-text-secondary` | `--text-color-secondary` (see limitations) |
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
| `--color-muted` | `text-muted` | fixed `#757575` |

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

## 2. The Unraid CSS reset — read this before styling a button

Unraid's webgui sets `html { font-size: 62.5% }` (10px base), which breaks
Tailwind's rem-based scale, and applies heavy global styles to `button`,
`input`, `p`, `a` and `table`. `main.css` counters this:

- `#unraid-docker-folders-modern { font-size: 16px }` restores the rem base.
- The `.unapi` class on the app root opts out of Unraid's button/input styles
  (Unraid guards them with `:where(:not(.unapi *))`).
- `#unraid-docker-folders-modern button:not(.nav-btn)` zeroes `padding`,
  `border`, `border-radius`, `background`, `font-size`, `font-weight`,
  `letter-spacing`, `text-transform`, `min-width` and `margin`.

**Consequence:** a button styled only with Tailwind utilities silently loses its
type scale — `text-sm` survives (utility specificity wins) but inherited
`font-weight` and `letter-spacing` do not, and any property you forget to set
falls back to the reset. A button must therefore either:

1. carry `.nav-btn` (and get the full house style), or
2. be an icon-only button where the reset is what you want.

Do not hand-roll a third option. The same applies to inputs: everything that
isn't `.styled-input` gets its border, background and padding zeroed.

---

## 3. Buttons

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
<button class="p-1.5 rounded cursor-pointer text-text-secondary hover:text-text transition" title="…">
  <svg width="14" height="14" …/>
</button>
```

Swap the hover token for intent: `hover:text-primary` (run/activate),
`hover:text-error` (delete). Round close buttons in modal headers use
`w-8 h-8 rounded-full … hover:bg-border`. Every icon-only button needs an
`aria-label`; add `title` as well when a hover tooltip is useful.

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

## 4. Modals

### Two surfaces

Every modal exists twice:

1. **In-iframe** — `BaseModal.vue`, guarded by `v-if="!inIframe"`.
2. **Parent document** — described declaratively through `useParentModal.ts` and
   rendered by `DockerFoldersMain.page` into `#dfm-modal-card`.

On a real Unraid box the parent surface is what users see; the in-iframe one is
the dev-server fallback. **Prefer `useParentModal` for new modals.** Fall back to
`BaseModal`-only when the form is too dynamic for the descriptor's field types
(no repeatable-list field exists) — the schedules modals are the current
exception, and they are documented as such.

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

## 5. Forms

Standard field:

```html
<div class="mb-6">
  <label for="x" class="block mb-1 font-medium text-text">Label *</label>
  <input
    id="x"
    class="w-full py-2 px-4 border border-input-border rounded bg-input-bg
           focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
  />
</div>
```

Compact fields inside a grouped/nested block may use `py-1.5 px-3 text-sm`.

`.styled-input` is the **monospace / code** variant — YAML, log panes, file
paths, cron expressions. It is not the default text input. Add `font-mono` to a
standard field when the value is a path but the field is otherwise ordinary.

Helper and caption text: `text-xs text-text-secondary`. Validation errors:
`text-sm text-error`.

---

## 6. Scale reference

**Radius** — `rounded` (4px) is the default for buttons, inputs, badges and
rows; `rounded-lg` (8px) for modal cards and dropdown menus; `rounded-full` for
pills, status dots, progress bars and round icon buttons.

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

## 7. Known limitations

Recorded deliberately — do not "fix" these without evidence.

- **`--text-color-secondary` is never bridged.** `main.css` maps
  `--color-text-secondary: var(--text-color-secondary, #666666)`, but that
  variable is not in `DockerFoldersMain.page`'s bridge list, so
  `text-text-secondary` always resolves to the hardcoded `#666666` on every
  theme. Adding it is speculative: Unraid may not define it, and the bridge
  silently drops empty values. It still beats every alternative in use, so keep
  using `text-text-secondary`.
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
  lose their separation. Only affects browsers without `color-mix` support.
- **Dev is light-only.** `npm run dev` never passes `?theme=`, so theme
  regressions are invisible there. To check dark, append a URL-encoded theme
  param, e.g.
  `?theme={"--text-color":"#f2f2f2","--background-color":"#1a1a1a","--border-color":"#333","--header-background":"#ff8c2f","--header-text-color":"#fff"}`.
- **The `.page` files are a parallel system.** `DockerFoldersMain.page` and
  `DockerFoldersSettings.page` hand-roll inline styles with dark fallbacks
  (`#333`, `#1a1a1a`), while `main.css` uses light ones (`#e0e0e0`, `#f2f2f2`).
  The two halves disagree about what "no theme" means.
