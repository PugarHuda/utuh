---
name: Utuh Console
description: A contact sheet for claims — every frame printed and numbered, so the missing one shows.
colors:
  ground: "#100e0c"
  sheet: "#17140f"
  frame: "#201c17"
  raise: "#272219"
  rebate: "#342d24"
  ink: "#efe8dc"
  dim: "#a2968a"
  accent: "#ff6a2c"
  accent-quiet: "#b8471a"
  on-accent: "{colors.ground}"
  good: "#8fbf6f"
  bad: "#ff5f52"
  light-ground: "#ddd7cc"
  light-sheet: "#ebe6db"
  light-frame: "#f7f4ed"
  light-raise: "#fffdf8"
  light-rebate: "#cdc4b4"
  light-ink: "#17130f"
  light-dim: "#635a4e"
  light-accent: "#bc3f08"
  light-accent-quiet: "#98330a"
  light-on-accent: "#fffdf8"
  light-good: "#3f6b28"
  light-bad: "#b3271b"
typography:
  title:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    fontStretch: "84%"
    lineHeight: 1
    letterSpacing: "0.02em"
  frame-heading:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.188rem"
    fontWeight: 700
    fontStretch: "88%"
    letterSpacing: "0.005em"
  lead:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.063rem"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.938rem"
    fontWeight: 400
    lineHeight: 1.55
  edge:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.688rem"
    fontWeight: 600
    fontStretch: "68%"
    letterSpacing: "0.13em"
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.844rem"
    fontWeight: 400
rounded:
  sharp: "2px"
  default: "3px"
  pill: "999px"
spacing:
  rail: "2.75rem"
  gap: "1.5rem"
  frame-pad: "1.25rem 1.4rem 1.4rem"
components:
  button-act:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.edge}"
    rounded: "{rounded.default}"
    padding: "0.45rem 0.85rem"
  button-act-hover:
    backgroundColor: "{colors.raise}"
    textColor: "{colors.accent}"
  button-act-active:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
  chip:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.dim}"
    typography: "{typography.edge}"
    rounded: "{rounded.default}"
    padding: "0.3rem 0.6rem"
  frame:
    backgroundColor: "{colors.frame}"
    textColor: "{colors.ink}"
    rounded: "{rounded.default}"
    padding: "1.25rem 1.4rem 1.4rem"
  frame-hover:
    backgroundColor: "{colors.raise}"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.data}"
    rounded: "{rounded.default}"
    padding: "0.45rem 0.85rem"
---

## Overview

The console is a **contact sheet**. A proof sheet prints every frame a roll holds, in order, each
numbered along the film's edge; you read it to find what is *not* there, because an unprinted frame
leaves a numbered gap. That is Utuh's mechanism — a claim is only worth what someone can break, and
what breaks it is the event that was left out — so the page is built as a strip: a perforated film
edge down the side, panes as frames carrying rebate numbers, and one chinagraph accent for the marks
an editor makes.

This is an **Operate** surface. There is no hero and no pitch; the tool is the argument. One family,
a fixed rem scale, restrained colour, density wherever the data wants it. The world lives in the
strip, the numbering, the edge printing and the mark — never in ornament laid over the data.

## Colors

Restrained: neutrals plus a single accent. The scene picks the mode rather than the category — a
contact sheet is read under a loupe with the room down, and this page's own reader is a watcher
scanning block ranges at night, so the dark palette is the authored default and the light one is
the same sheet moved to a light box.

### Primary

`accent` **#ff6a2c** (light **#bc3f08**) — chinagraph orange, the grease pencil. Reserved for
primary actions, links, current selection, focus rings, and the caret. Never decorative.

### Neutral

Warm photographic blacks, not blue-blacks. `ground` is the darkroom, `sheet` the paper stock,
`frame` a printed frame, `raise` a frame in play, `rebate` the film edge and every rule on the page.
`ink` and `dim` are the two text weights.

### Named Rules

- **`on-accent`, never `ground`, for text on the accent.** In dark the ground is the right ink for
  it at 6.7:1; in light the paper is only 3.8:1 against the chinagraph, so text there goes
  near-white. Any new accent-filled surface uses this token.
- **Two state colours only.** `good` and `bad` exist for status, not emphasis.
- **A refuted claim uses `bad` as a rule struck through the row**, never as a row fill.

## Typography

**Archivo, self-hosted, variable on both axes** — one 88 KB file. A page whose argument is that it
needs no server does not open a connection to a font CDN to render its own name.

The width axis is what earns the file: **68%** is the condensed voice of film-edge printing, **84–88%**
carries headings, **100%** is the interface. Monospace is reserved for chain data — hashes, block
numbers, addresses, gas — which is measurement, not costume.

### Hierarchy

| Role | Size | Treatment |
| --- | --- | --- |
| Title | 2rem | 700, width 84%, uppercase |
| Frame heading | 1.188rem | 700, width 88% |
| Lead | 1.063rem | 400, 62ch measure |
| Body | 0.938rem | 400, 74ch measure |
| Edge printing | 0.688rem | 600, width 68%, uppercase, 0.13em tracking |
| Data | 0.844rem | monospace, tabular numerals |

Steps are fixed rem at roughly 1.16. Nothing is fluid: the page is read at a desk.

### Named Rules

- **Edge printing is a marking, never a sentence.** Table headers, chips and the roll marking take
  it. Prose never does.
- **Tabular numerals are set on `body`**, so every column of chain data aligns without asking.

## Layout

A two-column grid: the rail at 2.75rem, then the strip. Max width 1180px.

The rail is **positioned, not grid-placed** — `grid-row: 1 / -1` counts lines of the *explicit*
grid, and these rows are implicit, so a grid-placed rail collapses to the height of one frame.

Below 720px the rail is dropped, frames return to `grid-column: 1` (leaving them on column 2 conjures
an implicit column and pushes the strip off the right edge), and the rebate number moves to the
frame's own top-right corner. Wide tables scroll inside `.body`; the page itself never scrolls
sideways at any width.

## Elevation & Depth

There is no shadow vocabulary. Depth is material: the ground is behind, the frame sits on it, and a
frame in play lifts by changing to `raise` and taking an `accent-quiet` border. A contact sheet is
flat stock and the design keeps it flat.

## Shapes

3px radius throughout, 2px on focus rings. Sharp enough to read as printed stock rather than as
soft product-UI cards. Perforations are punched from the rail in the ground's own colour, so the
edge reads as material with something taken out of it rather than as a dotted border.

## Components

### Buttons

`.act` is edge printing on a sheet ground: condensed, uppercase, tracked. Hover takes the accent as
border and text; active inverts to accent fill with `on-accent` text. `.danger` is the same shape
with `bad`. Disabled drops to 0.45 opacity.

### Chips

Header status carriers. Edge-printed label, monospace value, sheet ground, 3px radius.

### Frames (`section`)

The signature component. Frame ground, rebate border, and a rebate number printed on the film edge
beside it, offset by rail plus gap so it lands on the edge rather than bulging off its inner side.
Numbering runs 12, 12A, 13, 13A, 14, 14A — film convention, and the sequence carries information
here because a numbered gap is the whole point.

### Inputs / Fields

Monospace, sheet ground, accent caret, accent border on hover.

### Tables

Rules in `rebate`, header rule in `dim`, last row unruled, tabular numerals, row hover at 8% accent.
`tr.struck` draws a `bad` rule through a refuted claim and keeps its id unstruck and bold — the
frame stays on the sheet, visibly rejected.

## Do's and Don'ts

### Do:

- Theme the surfaces nobody draws: selection, caret, scrollbar, focus ring, underline offset.
- Keep the accent for action, link, selection and state. Nothing else.
- Let the mechanism carry the ornament — numbering, perforation, the struck rule are all load-bearing.
- Say what is not proven. The interface repeats that completeness here is economic, not cryptographic.

### Don't:

- Add a hero, an eyebrow, or a kicker. This surface has no pitch.
- Use monospace for anything that is not data or measurement.
- Introduce a second accent or a gradient. The palette is restrained on purpose.
- Reach for card-in-card. A frame holds content, not more frames.
- Soften protocol vocabulary — claim, member, bond, challenge window, refute, standing — into
  friendlier words.

<!-- The `repeating-stripes-gradient` detector rule is ignored for this project, recorded in
     .impeccable/config.json. The rail's perforations are the committed world's central device, not
     a decorative stripe; every other detector rule runs. -->
