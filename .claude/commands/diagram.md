---
description: Create or update a draw.io diagram and export SVG and PNG
argument-hint: <diagram name> <what it should show>
---

Create or update `docs/diagrams/<name>.drawio` for: $ARGUMENTS

Use the docs-diagrammer subagent and the `drawio-diagrams` skill. Then run `pnpm diagrams` to export
`<name>.drawio.svg` and `<name>.png`, and commit the source and both exports together.
