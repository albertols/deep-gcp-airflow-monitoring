---
name: drawio-diagrams
description: Create, update and export draw.io diagrams for DCAM documentation and the in-app wiki, such as architecture, data flow and the concurrency stack. Use when a task mentions a diagram, a .drawio file, or an illustration for the docs or the wiki.
---

# draw.io diagrams

## Conventions
- One diagram per file: `docs/diagrams/<kebab-name>.drawio` (uncompressed XML, so diffs are readable).
  Use one page per C4 level when needed.
- Exports sit next to the source: `<name>.drawio.svg` (diagram embedded, stays editable) and `<name>.png`
  (2× scale). Documentation and wiki pages embed the SVG.
- Colours come from the DCAM design tokens (`packages/ui-kit/src/tokens.ts`, spec §12.5): canvas `#0B1320`,
  surface `#111B2B`, raised `#16233A`, border `#22324D`, text `#E3E8F0`, secondary `#9AA9BF`,
  accent `#8AB4F8`, ok `#81C995`, warning `#FDD663`, error `#F28B82`. Airflow state colours only for
  task and run states. Never rely on colour alone: label everything.
- Use the official Google Cloud icons and the Apache Airflow logo as published; never redraw or recolour them.
- Every Composer diagram shows the boundary between the customer project and the Google-managed tenant project.
- Flow left to right. Label arrows with what flows and how often, for example "metrics, 60 s".
- Fictitious identifiers only (`acme-*`).

## Export
- `pnpm diagrams` runs `scripts/export-all.mjs`: it exports every diagram whose SVG or PNG is missing or
  older than the source. `pnpm diagrams --check` only verifies (used in CI).
- The draw.io binary is found in this order: `$DRAWIO_BIN`, `drawio` on PATH,
  `/Applications/draw.io.app/Contents/MacOS/draw.io`. draw.io desktop needs macOS 13 or later; on older
  macOS and in CI the script falls back to the headless Docker image
  `rlespinasse/drawio-desktop-headless:v1.77.0` (override with `$DRAWIO_DOCKER_IMAGE`). Diagrams never
  leave the machine: the hosted draw.io MCP server is not used.
- Flags: SVG `-x -f svg -e --embed-svg-images -b 10`; PNG `-x -f png -e -s 2 -b 10`. Never group a value
  flag (`-xf png`). Multi-page files: `-p <index>` (1-based from draw.io 27.0.2).

## Checklist
- [ ] Source and both exports committed together
- [ ] Every shape and arrow labelled; a legend if more than three colours are used
- [ ] Contrast at least 3:1 for shapes and 4.5:1 for text
- [ ] Customer and tenant project boundary shown (Composer diagrams)
- [ ] Embedded in its page with alt text
