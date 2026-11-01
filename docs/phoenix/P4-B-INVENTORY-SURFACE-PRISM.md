# P4-B — inventory surface palette and control bridge

The successor to the selected-batch workbench converts the existing inventory page header, warehouse context, tabs, cards and locally mounted form controls to the approved PRISM palette. The six existing render roots retain their original elements and classes; all branches, labels, fields, scope/permission checks, errors, operation handlers and ledger quantities remain with their current owners.

On narrow selection, the detail panel scrolls into the visible workspace without animation. A breakpoint change preserves visible keyboard focus when a selected row or narrow-only Back control becomes hidden. Focus owned by another control, including search, is preserved. The breakpoint listener is removed with its owner. No data operation is associated with focus or scrolling.

`inventory-prism.css` is confined to screen 3 and the existing inventory root classes. It bridges established component tokens to the accepted shell palette, removes the inherited green/gold page paint, keeps existing semantic status colors, uses local Changa/Noto Sans Arabic/Sora fonts, and preserves the current tab scroll owner and all tab entries. Primary actions and selected tabs use theme-appropriate foreground/accent pairs. The dark batch-detail panel retains its own readable colors.

There is no SQL, API, new permission, stock calculation, quantity conversion, document action or global token replacement. Portaled dialogs and other screens require their own surface review; no complete reference parity is claimed here. This batch depends on acceptance and merge of the direct-detail workbench.

Acceptance requires existing inventory preservation/selection tests, current-head TypeScript/lint/build and pg-rig, the real 16-combination authenticated matrix with live surface/font/contrast checks, manual before/after reference comparison and the existing 251-assertion functional suite. Fixtures stay in the disposable local stack; Production receives no test rows.
