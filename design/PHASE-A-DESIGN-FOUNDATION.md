# Phase A — Design Foundation and Dual App Shell

## Status

Started on branch `feat/phase-a-design-foundation` from the post-R0 `master` baseline.

## Objective

Introduce the Phoenix Daylight Cinematic presentation foundation progressively, while preserving all existing application contracts.

## Non-negotiable boundaries

This phase does **not** change:

- database migrations or schema;
- inventory, transfer, custody, FEFO, procurement, or reporting writers;
- authentication, RLS, RBAC, role landing, or screen authorization;
- public QR route separation or authenticated bundle boundaries;
- legal document numbering, audit behavior, or service APIs.

## First implementation slice

1. Add a document-level `data-phoenix-ui-phase="a"` marker before the first React paint.
2. Add an isolated `phase-a-foundation.css` presentation layer.
3. Establish one consistent responsive content stage for all existing screens without wrapping or rewriting feature components.
4. Preserve the permanent desktop rail and the current mobile drawer/bottom-navigation model.
5. Add safe-area, reduced-motion, hidden-tab animation, overscroll, and wide-screen behavior.

## Dual-shell contract

### Desktop

- permanent navigation rail;
- sticky top command bar;
- bounded single scroll owner;
- centered operational canvas that can expand for dense tables and reports;
- stable visual seams between rail, topbar, and content.

### Mobile

- one vertical scroll owner;
- safe-area-aware topbar and bottom navigation;
- full-width operational surfaces;
- reduced ambient complexity and shorter page-entry motion;
- no overlay may cover the final screen control.

## Rollout order

1. Foundation and shell contract.
2. Authentication and welcome surfaces.
3. Executive/reporting shell.
4. Inventory and transfer workspaces.
5. Institution and outlet operations.
6. Administration, QR, health, and secondary screens.
7. Visual regression, accessibility, performance, and cleanup.

## Acceptance gate for this slice

- TypeScript build and lint remain green.
- Existing tests remain unchanged and passing.
- No production-only QA code enters the production bundle.
- Desktop and mobile retain the existing navigation and authorization behavior.
- Reduced-motion mode removes nonessential motion.
- The change can be disabled by removing one import and one data attribute.
