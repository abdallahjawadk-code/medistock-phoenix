# P4-D — statistics and reporting surfaces

The existing statistics panel composition and canonical report tabs retain their data, permissions, headings, lifecycle, tab keyboard owner and export contracts. A presentation-only bridge, confined to their known screen ids and existing root classes, maps local panel/font/control tokens to PRISM. Semantic stock status colors remain unchanged. Report tables keep their existing horizontal-scroll owners and all columns; the tablist gains one horizontal scroll owner while retaining every authorized tab and its roving focus.

This batch does not replace report content or restructure the existing panel model. No data request, quantity, legal identity, calculation, export, permission, SQL or role default changes. Portaled dialogs, non-reporting screens and full concept-reference parity remain separate acceptance surfaces.

Acceptance requires current-head statistics/report/keyboard isolation tests, typecheck/lint/build/pg-rig, the real authenticated language/theme/width matrix for statistics and reporting, live contrast/font/palette/scroll checks and the existing functional suite. Production smoke remains read-only; no synthetic record or real annual workbook is hosted.
