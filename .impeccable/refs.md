# Utuh redesign — visual references

Research window: 25 min, 2026-09-13. Screenshots in this folder where the site allowed one.

## 1. Oracle Fusion — Document Number Audit Report
URL: https://docs.oracle.com/en/cloud/saas/financials/24b/faofc/document-number-audit-report.html (also https://docs.oracle.com/cd/A60725_05/html/comnls/us/ar/invaud.htm)
What: an ERP audit report whose entire output is the list of numbers MISSING from a sequence, each with a status (Entered / Not Entered / Deleted).
take: the report is the gap, not the set. Two columns: the missing number and what happened to it. A Utuh "refutation" row is exactly this — omitted event id + status + who found it. Also the parameter block (sequence name, from, to) printed above the table so the scope of the claim is stated before the result.
reject: ERP chrome, ten-column parameter forms, the grey-on-grey report header.
screenshot: none (doc page, text only)

## 2. U.S. Graphics Company — Berkeley Mono product page
URL: https://usgraphics.com/products/berkeley-mono
What: a type foundry product page laid out like a catalog data sheet — bracketed button nav, a colour-bar strip, dotted rules between sections, tagged labels (TYPEFACE / TX-02), a "Datasheet (PDF)" as the main CTA, no hero image.
take: persuasion by specification. Every fact sits under a ruled heading; the CTA is a datasheet, not "Get started"; rules and small caps labels carry hierarchy instead of colour or size. Fits "plain, exact, unhyped" exactly.
reject: the retro-terminal cosplay (CRT green, ASCII borders as decoration). Utuh should borrow the discipline, not the costume.
screenshot: refs-01-usgraphics-berkeley-mono.png

## 3. The Monospace Web (Oskar Wickström)
URL: https://owickstrom.github.io/the-monospace-web/
What: a design essay/stylesheet where text, tables, lists and diagrams all sit on one character grid; tables let only one column grow.
take: the one-growing-column rule for data tables (ids and amounts fixed-width, description takes the slack). Box-drawing diagrams that align with text — a cheap way to draw "set with a gap" inline in the whitepaper.
reject: everything monospace. Use mono for identifiers, hashes, amounts, counts; keep body copy proportional.
screenshot: none

## 4. AO 187 — US District Court Exhibit and Witness List
URL: https://www.uscourts.gov/sites/default/files/ao187.pdf
What: the federal one-page form clerks use to log every exhibit — number, date offered, marked, admitted, description.
take: a numbered set where blank cells are the information. "Offered" vs "Admitted" columns are two stages of standing; an exhibit that is marked but never admitted is visibly a gap in the row. Model the claim register on this: one row per event, sparse status columns, the eye reads the gaps.
reject: form-filling chrome (case caption box, ruled boxes for handwriting).
screenshot: none (PDF)

## 5. EAS Explorer (Ethereum Attestation Service)
URL: https://easscan.org/
What: the closest existing product — an explorer for on-chain attestations: schemas, attestations, attester/recipient, revoked flag.
take: the object model on the page mirrors the protocol nouns one-to-one (Schema, Attestation, Attester, Recipient, Revoked). Every row links to the chain transaction. Utuh should do the same with claim / bond / refute / window / standing and never invent a UI-only noun.
reject: the generic-explorer chrome — search bar hero, stat tiles ("Total attestations"), tabs, a light SaaS palette that says nothing about evidence. Also: "revoked" is a boolean badge; Utuh's standing needs a stage, not a badge.
screenshot: refs-02-easscan-attestation-explorer.png

## 6. Dribbble — "fintech dashboard" tag page (the rut, captured on purpose)
URL: https://dribbble.com/tags/fintech-dashboard  (login-walled for detail; the tag grid itself renders)
What: hundreds of near-identical dark dashboards: sidebar, four KPI cards, an area chart with a purple gradient, a card-shaped table.
take: nothing directly; keep it as the control sample. If a Utuh screen would fit into this grid unnoticed, it has failed.
reject: sidebar + KPI-card + gradient-chart triad; glassmorphism cards; mock balances with $ and sparkline; rounded 16px everything.
screenshot: refs-03-dribbble-fintech-dashboard-tag.png

## 7. Flashbots — protocol/research org landing
URL: https://flashbots.net/
What: an infrastructure org landing that opens with one plain sentence of purpose, then lists work, engines and a dated timeline. No product screenshots, no hero art.
take: lead with the definition sentence, not a slogan. A chronological "journey" list reads as a ledger of shipped things — evidence, not promise. Headings as section numbers.
reject: the wall-of-links density on the lower page; low contrast footer.
screenshot: refs-04-flashbots-landing.png

## 8. L2BEAT — scaling summary table
URL: https://l2beat.com/scaling/summary
What: the reference dense table in crypto: every L2 as one row, with a "Stage 0/1/2" maturity column, risk pie, TVS, and a fixed methodology behind every cell.
take: STAGE as a first-class column. Standing in Utuh (posted / in window / unrefuted / refuted / drawn against) is a stage, and L2BEAT shows how to make a stage legible in one glyph plus a word, with the criteria one click away. Also: sticky header, right-aligned numerals, tabular figures, sort on every column, and a public "how we assess" page so the table is accountable.
reject: the risk pie-slice glyph (cute, unreadable at row size), the marketing purple, and the logo column dominating each row.
screenshot: refs-05-l2beat-summary-table.png

## 9. Kursbuch (official railway timetable) — 1944 Reichsbahn field 201d Heiligenstadt–Eschwege, page scan
URL: https://commons.wikimedia.org/wiki/File:Kursbuch_1944_201d.jpg  (context: https://de.wikipedia.org/wiki/Offizielles_Kursbuch)
What: a timetable field: one numbered table per route, stations down the side, trains across, footnote glyphs for days-of-run, and a dash where a train does not stop.
take: the typeset absence. Cells where a train does not run are printed as "..." and non-stopping runs as a wavy rule, so absence is a value, not a blank; the km column numbers every station so a skipped one is visibly skipped. Utuh's set view should print the omitted event as a row with a mark, never as nothing. Also: every table carries its field number and validity dates in the header — scope and period stated before data.
reject: the eight-point type and the sheer density; a screen does not need to be paper-cheap.
screenshot: refs-06-kursbuch-1944-page-scan.jpg

## 10. Pinterest — "Contact sheet" idea page (photographic contact sheets)
URL: https://www.pinterest.com/ideas/contact-sheet/917821689091/  (login modal over the grid; thumbnails still visible behind it, including sheets with red X-outs)
What: grids of film contact sheets: every frame of a roll printed at thumbnail size, frame numbers from the film edge, grease-pencil circles on the chosen frames and crosses on rejects.
take: the whole-roll grid is the honest way to show a set: every frame present, numbered by the medium itself (the chain's block/tx index, not our counter), and the annotation sits ON the frame, not in a sidebar. A refuted event is a crossed frame; the missing frame in a numbered strip is the omission. This is the claim-detail view.
reject: darkroom nostalgia (film-edge borders, Kodak lettering, sepia). Take the grid and the marks, not the texture.
screenshot: refs-07-pinterest-contact-sheet.png

## 11. Blockscout — Ethereum transactions list (the explorer rut, captured on purpose)
URL: https://eth.blockscout.com/txs
What: the default open-source block explorer: tx hash, method pill, status pill, block, from/to with avatars, value, fee — infinite list.
take: one thing — status is a word in a pill ("Success"), left of the hash, and the row links to the verified thing. Hash truncation middle-out (0x1234…abcd) with copy affordance is the accepted convention; keep it.
reject: the noise: identicon avatars, coloured method pills, "Ad" slot, three-level tabs, 10-column rows nobody reads. Explorer UI shows every field because it has no opinion; Utuh has one (is the set complete?), so show only fields that bear on it.
screenshot: refs-08-blockscout-txs-explorer.png

## 12. GitHub Status — incident history
URL: https://www.githubstatus.com/history
What: a Statuspage incident ledger: months as sections, each incident a dated entry with a plain title, a severity colour on the title only, and a chronological update log (Investigating → Identified → Monitoring → Resolved) with timestamps.
take: the challenge log. A refutation is an incident: opened at T, evidence posted, resolved with an outcome, every step timestamped in UTC, newest at top, no charts. The four-word state vocabulary is the model for Utuh's window states. Also: "no incidents reported" months are printed, so absence is recorded.
reject: the friendly green "All systems operational" banner tone; Statuspage's card shadows.
screenshot: refs-09-githubstatus-incident-history.png

## Patterns across the set
The strong references are all registers, not dashboards: a numbered set, one row per item, a stage or status per row, and a blank, dash, or cross where something is missing or rejected. Scope is stated before the data (sequence range, timetable field and validity dates, case caption, physical inventory name), which is exactly what a Utuh claim header should do: "events N..M under schema S, window closes at T, bond B". Colour is reserved for one thing per surface (L2BEAT's stage, Statuspage's severity); everything else is black type on rules. Identifiers are monospace and right/left aligned in fixed-width columns; prose stays proportional. None of the good ones has a chart above the fold. The persuasion in the two good landings (Berkeley Mono, Flashbots) is a definition sentence and then evidence of work, not a slogan and a mock UI. The metaphor writes itself from the audit sources: the interesting report is the list of what is NOT there — Oracle's missing-number report, the missing-tag listing, the contact sheet with a frame crossed out — so the console's hero object should be the gap row, printed as a row, with who found it and what it paid.

## Ruts to avoid
- Sidebar + four KPI cards + purple-gradient area chart + card-shaped table (every Dribbble fintech shot, see ref 6).
- Dark mode with glassmorphism cards, glow borders, neon green "verified" ticks.
- Hero slogan ("Trust, verified.") over a floating 3D mock of the dashboard; three-column icon-feature grid; logo wall; gradient CTA button.
- Stat tiles with big rounded numbers and no denominator ("14,770 attestations" — of what set?).
- Status as a coloured pill on every row; identicons/avatars for addresses; method-name pills.
- Explorer completeness: showing all 12 fields because the UI has no opinion.
- Rounded-16px everything, 1px translucent borders, Inter at 13px grey-on-grey.
- "Shield" / "lock" / "checkmark-in-circle" iconography for proof; blockchain cube illustrations.
- Ledger cosplay: CRT green, ASCII borders, film-edge textures, corkboard-and-red-string evidence boards (ref search on "evidence board" returned only detective-game kits; skip the metaphor).
- Timeline-as-marketing (roadmap with glowing nodes) instead of a dated, timestamped log.
