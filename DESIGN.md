---
name: Utuh
description: The auditor's working paper — every member traced, the omitted event printed as a row, in red pencil.
colors:
  paper: "#dfe7d5"
  sheet: "#ebf0e3"
  well: "#d1dbc6"
  rule: "#b3c4ab"
  rule-strong: "#5f7a5e"
  margin: "#c43a2b"
  ink: "#16201a"
  ink-soft: "#445244"
  red: "#b52d1d"
  red-soft: "#e9c7c1"
  blue: "#234f9e"
  blue-soft: "#cbd7ec"
  on-blue: "#f4f7ee"
  on-red: "#f8efec"
  bad: "{colors.red}"
  dark-paper: "#0f1512"
  dark-sheet: "#151d18"
  dark-well: "#0a0f0c"
  dark-rule: "#28372d"
  dark-rule-strong: "#6e8a72"
  dark-margin: "#e25a49"
  dark-ink: "#e6ede3"
  dark-ink-soft: "#a3b4a5"
  dark-red: "#ff7a68"
  dark-red-soft: "#3d1d18"
  dark-blue: "#8fb3ff"
  dark-blue-soft: "#1a2a48"
  dark-on-blue: "#0f1512"
  dark-on-red: "#0f1512"
typography:
  display:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.25rem, 1.4rem + 2.8vw, 4rem)"
    fontWeight: 600
    fontStretch: "90%"
    lineHeight: 1.02
    letterSpacing: "-0.015em"
  section:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    fontStretch: "92%"
    lineHeight: 1.2
  h1:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    fontStretch: "92%"
    lineHeight: 1.15
  h2:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    fontStretch: "92%"
    lineHeight: 1.2
  lead:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.938rem"
    fontWeight: 400
    lineHeight: 1.55
  small:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.813rem"
    fontWeight: 400
    lineHeight: 1.45
  print:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.688rem"
    fontWeight: 600
    fontStretch: "84%"
    letterSpacing: "0.1em"
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.844rem"
    fontWeight: 400
  total:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "1.75rem"
    fontWeight: 500
    lineHeight: 1.1
rounded:
  default: "2px"
  pill: "999px"
spacing:
  gap: "1.5rem"
  pad: "1.25rem"
  margin-rule: "1.25rem"
components:
  stamp:
    backgroundColor: "transparent"
    textColor: "{colors.blue}"
    borderColor: "{colors.blue}"
    typography: "{typography.small}"
    rounded: "{rounded.default}"
    padding: "0.45rem 0.85rem"
  stamp-primary:
    backgroundColor: "transparent"
    textColor: "{colors.blue}"
    borderColor: "{colors.blue}"
  stamp-danger:
    backgroundColor: "transparent"
    textColor: "{colors.red}"
    borderColor: "{colors.red}"
  chip:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.print}"
    rounded: "{rounded.default}"
    padding: "0.3rem 0.6rem"
  schedule:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    borderColor: "{colors.rule}"
    rounded: "{rounded.default}"
    padding: "1.25rem 1.4rem 1.4rem"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    borderColor: "{colors.rule-strong}"
    typography: "{typography.data}"
    rounded: "{rounded.default}"
    padding: "0.45rem 0.85rem"
  log:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    borderColor: "{colors.rule}"
    typography: "{typography.data}"
    padding: "0.75rem 0.9rem"
---

## Overview

Auditing is the one discipline with a formal name for what this product does. An auditor tests
*existence* by vouching — pick an entry in the ledger, find the source document — and tests
*completeness* by tracing the other way: pick a source event, find it in the ledger. An inclusion
proof vouches. Utuh traces. So both pages are the auditor's **working paper**: the ruled schedule
on eye-ease green stock, typed figures, two pencils, a footed total under a double rule, a
sign-off block, working-paper references on the margin, and a legend that says what every mark
means. The finding on a working paper is the row that did not tick. Here that row is the event a
claim left out, and it is printed as a row, in red, in its place among the members — never as a
blank.

Two surfaces, one world. The landing is **Persuade**: the thesis in two sentences, then claim 5
laid out as a schedule read from the chain. The console is **Operate**: the same paper, denser,
with the Watch schedule first so a deep-linked claim states its standing in words above the fold.

### How the direction was chosen

Seven grounded candidates from the audience's world, ranked: shadow board, customs bond, Bates
numbering, **the auditor's working paper**, Mendeleev's gapped table, the Swiss timetable, the
stamp album. The Impeccable roll (seed `99d9d82d`, `--scope direction --mode persuade`) assigned
index 4. Six catalog challengers were fused and weighed on audience identification and product
clarity; none won, one (the oscilloscope bench) was competitive on identification. There was no
human at the decision page, so the assigned direction was built and raised by what the hand it
beat had that it lacked:

- **One line ink** (from the glazier's partition): every rule on the page is one weight; hierarchy
  comes from size and position, never from heavier borders.
- **A ticket of origin on every number** (from the shadow bazaar): every figure carries what
  produced it — the contract, the block, the transaction — as a link.
- **Two inks at full strength** (from the risograph): red and blue commit; no tints stand in for
  either. A tinted surface (`blue-soft`, `red-soft`) exists only as a hover or an error ground.
- **Marks that read at 11px** (from the menhera sheet): ticks and exceptions are drawn SVG at a
  set stroke, with a legend, never a unicode glyph left to font fallback.
- **The graticule** (from the oscilloscope): the claim's block range is drawn to scale on a ruled
  axis; members and the omitted event are plotted, not listed only.

Reference research (twelve refs, in the session scratchpad) confirmed the family: the Oracle
document-number audit report and the physical-inventory missing-tag listing, the AO 187 exhibit
list, the Kursbuch's typeset absence, L2BEAT's stage column, the Statuspage incident ledger. The
rut kept out: the dark crypto console with a neon accent and glass cards; the cream editorial
fintech page with a serif; the contact sheet the previous world was built on.

## Colors

Strategy: **Committed** — the green paper carries the whole surface; two pencil inks do all the
work. Light is the authored default: a working paper is read at a desk. Dark is the same schedule
under a banker's green-shaded lamp: the ground goes to bottle-black with the green still in it.

### Paper

`paper` is the page, `sheet` a schedule laid on it, `well` a recessed field (the log, calldata,
the snippet). `rule` is every hairline; `rule-strong` the header rule and the borders that hold a
block; `margin` the ledger's red margin rule, and nothing else.

### The two pencils

`blue` is the auditor's tick and every action: links, the stamp, focus, selection, the caret.
`red` is a finding: an exception, a struck row, a refutation, `.bad`, the danger stamp, and the
one emphasised phrase in the display line. A confirmed state (`.good`, a borrow step that went
through) is blue — the same ink as a tick. There is no third pencil.

### Named Rules

- **Red is a finding, never emphasis.** If a red element is not an exception, an error, or a
  refutation, it is wrong.
- **`on-blue` and `on-red` exist for the pressed state only.** A stamp at rest is an outline; only
  `:active` and the skip link fill, and the near-white tokens hold 7:1 on both inks in both scenes.
- **The margin rule is one device pixel.** It is a rule, not a border-left accent.
- **Body background:** light `#dfe7d5` (rgb 223,231,213), dark `#0f1512` (rgb 15,21,18).

## Typography

**Archivo, self-hosted, variable on both axes** — one 88 KB file, the only face the page loads.
The width axis does the form's work: **84%** is the stationer's pre-printed label (small caps,
tracked), **90–92%** carries headings and the display line, **100%** is prose. Monospace is the
typed figure: hashes, blocks, addresses, amounts, the log, the footed totals — data and
measurement, never costume.

### Hierarchy

| Role | Size | Treatment |
| --- | --- | --- |
| Display (landing h1) | clamp(2.25rem, 1.4rem + 2.8vw, 4rem) | 600, width 90%, -0.015em, 18ch max |
| Section (landing h2) | 1.5rem | 700, width 92% |
| Console h1 | 1.5rem | 700, width 92%, balanced |
| Schedule heading (h2) | 1.25rem | 700, width 92% |
| Lead | 1.125rem | 400, 58ch |
| Body | 0.938rem | 400, 66ch |
| Small | 0.813rem | notes in schedules, footers |
| Print | 0.688rem | 600, width 84%, uppercase, 0.1em |
| Data | 0.844rem | monospace, tabular |
| Total | 1.75rem | monospace 500 — the footed figures only |

Fixed rem steps; only the display line is fluid, because it is the one line read from across a
room.

### Named Rules

- **Print is a marking, never a sentence.** Table headers, chips, form labels, the wordmark's
  gloss. Prose never takes it.
- **Tabular numerals on `body`**, so every column of chain data aligns without asking.
- **A status is a word with a drawn mark in front.** `standing()` in `main.ts` is the only place
  the mark is chosen.

## Layout

Console: one column, max 1180px, with a 1.25rem gutter to the right of the red margin rule;
working-paper references (`W/P n`) print on the rule beside each schedule. Below 720px the rule is
dropped and the reference moves into the schedule's top-right corner. Landing: max 1240px, the
hero a 7:6 grid (thesis / schedule) collapsing at 900px; the footed totals directly beneath, then
plain sections separated by a header rule, not by cards.

The Watch schedule is first on the console: the two links every document hands out open a claim,
and the claim's standing must be on screen on arrival. A deep link below the fold scrolls the
detail into view once the page is ready.

## Elevation & Depth

None. Paper on a desk is flat; a schedule sits on the page by its rule and its lighter stock, a
recessed field by its darker one. No shadows anywhere.

## Shapes

2px radius throughout — printed stationery, not product cards. Marks are round-capped strokes at
2.4 units in a 16-unit box.

## Components

### Stamps (`.act`)

A rubber stamp: an impression in one ink, never a filled block. 1.5px border, uppercase, width
88%, tracked. `.primary` is the same impression struck harder — a 3px double rule in the same
blue; `.danger` is the shape in red. Hover tints with `blue-soft`/`red-soft`; active fills with
`on-blue`/`on-red` text. Disabled drops to 0.5 opacity.

### Schedules (`section[data-frame]`, `article.schedule`)

The signature component. Sheet stock, hairline rule, the W/P reference on the margin. On the
landing a schedule has an identification header (title, reference, scope line in print), the
range strip, the members table with the omitted event as a struck row, and a finding paragraph.

### Range strip (`svg.strip`)

The claim's block range on a ruled axis, drawn from `keyAt` and `ClaimRefuted`: nine grid
divisions, one blue tick per member, one red circle at the omitted block with its label. The
circle is drawn once — the page's one authored motion — from an already-visible default under
`prefers-reduced-motion`.

### Footed totals (`.tally`)

Four figures across, header rule above, double rule beneath. The refuted count is in red. Until
the chain answers the figures are `ink-soft`, so a placeholder never reads as data.

### Tables

Ruled both ways in `rule`; header rule in `rule-strong`; first and last columns flush to the
schedule's padding; hover at 7% blue. `tr.struck` draws a red line through every cell and leaves
the id legible in red — a finding stays on the schedule.

### Log

`well` ground, monospace, empty-state text in `ink-soft`. Live region.

### Sign-off block (`.signoff`)

Three columns for claimants, watchers, lenders. The heading comes first; the field line —
"Prepared by", "Traced by", "Reviewed by" — sits under it as a rule with print beneath, the way
an initials line does. Never a label above the heading: that is a kicker.

### Legend (`.legend`)

Every mark defined once per page: at the foot of the landing, and under the claims register on
the console (tick, wait, exception, the struck row, W/P).

### Range strip labels

The strip's labels are HTML beside the SVG, not `<text>` inside it, so they keep the page's own
size on a phone instead of scaling down with the viewBox.

## Do's and Don'ts

### Do:

- Print an absence as a row. A gap nobody can point at is not a finding.
- State scope before data: range, emitter, claimant, bond, standing — then the members.
- Link every number to what produced it.
- Say what is not proven: economic, not cryptographic; a bond, not a guarantee; "nobody has audited
  these contracts; this page audits claims."

### Don't:

- Use red for anything but a finding, or a third ink for anything at all.
- Add a kicker, an eyebrow, a stat tile, a card grid, a gradient, a shadow, or a glyph typed from a
  font where a mark should be drawn.
- Soften the protocol's words — claim, scope, member, bond, challenge window, refute, finalize,
  standing, line, draw, settle.
- Imply an audit of the contracts. The working paper is the watcher's, and it audits claims.

<!-- The `repeating-stripes-gradient` detector rule stays ignored in .impeccable/config.json from
     the previous world; nothing in this world uses a repeating gradient, and the ignore is inert. -->
