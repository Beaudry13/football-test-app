# Peira theming architecture

How the design system is layered today, and exactly how per-organization
branding will plug into it later.

**Nothing in this document is implemented as a feature yet.** There are no
settings, no migrations, no API fields, and no UI for organization
branding. This describes the architecture that the current token system
was built to support, so that adding branding later is a configuration
change rather than a second redesign.

---

## 1. Layers

| Layer | File | Scope |
|---|---|---|
| Canonical tokens | `frontend/src/styles/tokens.css` | `:root` — the Peira default theme |
| Coach theme aliases | `frontend/src/styles/notebook.module.css` (`.page`) | every coach-facing page |
| Player theme | `frontend/src/index.css` (`:root`) | the player quiz-taking flow |
| PDF theme | `backend/app/services/export.py` (`PDF_THEME`) | generated exports |

The coach and player themes are deliberately separate palettes — dark and
information-dense for the sideline/office, light and simple for a player's
phone. That split is a product decision, not an accident, and per-org
branding must not collapse it.

### Naming rule (important)

`index.css` already owned generic names (`--color-bg`, `--color-text`,
`--radius-sm`, …). `tokens.css` therefore prefixes every token whose bare
name would collide: `--peira-bg`, `--peira-surface`, `--peira-text`,
`--peira-danger`, `--peira-radius-sm`, and so on. Two `:root` blocks
declaring the same custom property is a silent, global, load-order-dependent
override — we hit exactly that bug during this work. Any new token added to
`tokens.css` must either use a name `index.css` doesn't use, or take the
`--peira-` prefix.

---

## 2. Tokens that could safely become organization-overridable

These carry brand identity and nothing else. Overriding them changes how a
school's Peira *looks* without changing how it *works*.

| Token | Role | Notes |
|---|---|---|
| `--color-accent` | Primary brand color | School primary. Drives buttons, active nav, focus accents. |
| `--color-accent-bright` | Hover/emphasis tint of the accent | Should be derived from the primary, not chosen independently. |
| `--color-accent-contrast` | Text/icon color on top of the accent | **Must be computed, never supplied** — see §4. |
| `--color-accent-bg` | Low-opacity accent wash | Derived from the accent at fixed opacity. |
| `--color-text-secondary` | Secondary brand color, where used as text | Optional; contrast-gated. |
| `--peira-surface` | Card fill | Narrow range only — must stay a dark neutral on the coach theme. |
| `--peira-bg` | Page background | Narrow range only, same reason. |
| Logo / wordmark | Brand mark | See §5. |

A school's "secondary" and "accent" colors map onto
`--color-accent-bright` and `--color-accent-bg` respectively, or onto a
future `--color-accent-secondary` if a genuinely third color is needed.

---

## 3. Tokens that must stay Peira-controlled

Overriding these would break usability, accessibility, or the shared
product vocabulary — the things that should still feel like Peira no
matter whose colors are on top.

- **All status colors**: `--peira-success`, `--peira-danger`,
  `--color-warning`, and their `-bg` variants. Green-means-correct and
  red-means-destructive are product semantics. A school whose colors are
  red and green must not end up with a red "Correct" badge or a green
  "Delete" button.
- **Destructive-action styling**: `--color-danger-border`, `.btnDanger`.
  Delete must always read as delete.
- **Player-result semantics**: correct / incorrect / not-graded /
  unanswered coloring, shared with `PDF_THEME` and
  `services/player_analytics.py`. These must agree across the web UI, the
  PDF, and the analytics numbers.
- **Typography**: `--font-heading`, `--font-body`. Custom fonts are listed
  as a "maybe later" in the brief; if they ever land, they'd be
  size/weight-constrained, never free-form.
- **All spacing, radius, and layout tokens**: `--space-*`, `--radius-*`.
  These carry the information density coaches rely on.
- **All motion tokens**: `--duration-*`, `--ease-standard`, and the
  `prefers-reduced-motion` block.
- **Focus indication**: the global `:focus-visible` ring.
- **Minimum contrast and target sizes**: not tokens, but invariants (32px
  coach / 44px player controls, 4.5:1 text).

---

## 4. Handling invalid or low-contrast school colors

Brand colors arrive from humans and are frequently unusable as-is (a navy
so dark it disappears on the dark theme, a yellow so light that white text
on it fails contrast). The plan is to **correct rather than reject**, and
to reject only what can't be corrected:

1. **Parse and validate.** Reject anything that isn't a valid color. Store
   the raw value so the school sees what they entered.
2. **Never accept a supplied on-accent text color.** Compute
   `--color-accent-contrast` by measuring the WCAG contrast of the
   school's accent against both the light and dark candidates and picking
   the winner. This is the exact calculation that caught the real bug in
   this pass: the player theme shipped white-on-gold at 2.40:1, and the
   computed choice (`#121212`) scores 7.81:1.
3. **Clamp the accent into a usable luminance band** for the surface it
   lands on. If a school's primary can't reach 4.5:1 against
   `--peira-surface` for text use, keep the true color for large fills and
   substitute a lightened/darkened derivative for text — the same
   "accessibility outranks the exact brand hex" call already made for
   `--color-text-muted-2` in `tokens.css`.
4. **Surface the adjustment.** Show a preview plus a plain note ("we
   lightened your primary for small text so it stays readable") rather
   than silently changing it or silently failing.
5. **Only hard-reject** a color that would collide with status semantics
   in a way clamping can't fix, and offer the nearest safe alternative.

None of this is built. The point is that the token layer is the only place
it would need to run: one function producing a validated set of custom
properties.

---

## 5. How it would attach at runtime

Because every component reads a custom-property *name* and never a literal
value, an org theme is one scoped style block:

```html
<!-- Emitted once, after the org's branding is fetched -->
<style>
  :root[data-org-theme="uc"] {
    --color-accent: #E00122;
    --color-accent-bright: #FF3D52;
    --color-accent-contrast: #FFFFFF; /* computed, per §4 */
    --color-accent-bg: rgba(224, 1, 34, 0.12);
  }
</style>
```

No component, page, or CSS module changes. The logo follows the same shape
as `PDF_THEME`'s existing `_brand_mark()` fallback: one value
(`org.logoUrl`) with a text-wordmark fallback when unset or unreadable —
`components/brand/PeiraLogo.tsx` would read that value instead of its
hardcoded import.

---

## 6. PDF integration

`backend/app/services/export.py` already implements this pattern. Every
builder takes `theme: dict | None = None` and defaults to `PDF_THEME`;
no layout code contains a literal color. So the PDF side needs no
refactor — only a translation step:

```python
def org_pdf_theme(org) -> dict:
    """Map an organization's stored branding onto PDF_THEME's keys.
    Only the brand-carrying keys are overridable - status colors, fonts,
    spacing, and the print-friendly white background stay Peira's."""
    return {
        **PDF_THEME,
        "accent": HexColor(org.primary_color),
        "secondary_accent": HexColor(org.secondary_color),
        "logo_path": org.logo_path,          # _brand_mark() already falls back
        "wordmark_text": org.short_name or "Peira",
    }

# then, at the one call site:
build_detailed_results_pdf(..., theme=org_pdf_theme(quiz.organization))
```

The print-first constraints (white background, dark text, small accent
areas, thin borders) stay Peira-controlled for the same reason the web
status colors do: a school color used as a full-page fill would make the
export unprintable.

---

## 7. What stays recognizably Peira

After branding lands, a school changes: accent colors, logo, wordmark.
Everything that makes the product *itself* — layout, density, spacing
rhythm, typography, interaction patterns, status vocabulary, destructive
semantics, focus behavior, the coach-dark/player-light split — is
Peira-controlled and identical across every organization.
