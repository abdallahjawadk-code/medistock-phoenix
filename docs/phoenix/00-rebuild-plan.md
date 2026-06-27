# MediStock Phoenix V2 — Rebuild Plan

**Created:** 2026-06-27  
**Branch:** phoenix-v2-clean-core  
**Design source:** `design-source/MediStock-Babil.dc.html` (single source of truth)

---

## Goals

1. Clean, production-safe rebuild — no destructive actions on old project
2. New design only — old project used for business logic reference only
3. Mobile-first RTL/LTR SPA, 10 screens
4. Supabase backend with RLS + RPC-only writes
5. Safe lifecycle (QR-first, parent-last, allowlist-only purge)

---

## Phase Map

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Workspace creation + planning docs | ✓ Complete |
| 1 | Design inspection + component extraction | ✓ Complete |
| 2 | Legacy audit (keep/remove/rewrite/freeze) | Pending |
| 3 | Core SQL schema (10 tables) | Pending |
| 4 | RLS policies (5 roles) | Pending |
| 5 | RPC lifecycle (6 RPCs, allowlist purge) | Pending |
| 6 | Frontend ↔ Supabase wiring | Pending |
| 7 | Data migration preview + scripts | Pending |
| 8 | Test suite | Pending |
| 9 | Staging deployment doc | Pending |
| 10 | Production cutover doc | Pending |
| 11 | Final delivery report | Pending |

---

## Absolute Safety Rules

- DO NOT mutate or delete the current production project
- DO NOT delete the old Supabase database
- DO NOT run destructive production actions
- DO NOT use `npx supabase db push`
- DO NOT use `npm audit fix --force`
- DO NOT use `service_role` in frontend
- DO NOT expose secrets in frontend
- DO NOT bring back Data Reset Center
- DO NOT re-enable old Intake / OCR / DocIntel modules
- DO NOT create generic delete screens
- DO NOT use frontend `.delete()` on protected lifecycle tables
- All SQL: manual-review migrations only, applied via Supabase SQL Editor after approval
- Destructive actions require: impact preview + exact confirmation phrase + scoped entity ID + audit log + QR cleanup first + parent delete last
- QR-only actions NEVER delete/archive/disable/mutate the parent entity

---

## Stack

| Layer | Choice |
|-------|--------|
| Frontend | React 18 + Vite 5 + TypeScript |
| Styling | CSS Custom Properties (tokens.css) |
| i18n | `t(key, lang)` with `strings.ts` bilingual dict |
| Routing | `screen` state (1–10), no react-router |
| Backend | Supabase (PostgreSQL + RLS + RPC) |
| QR | `qrcode` npm package, lazy chunk |
| Build | Vite manual chunks: vendor / supabase / qr |

---

## Directory Layout

```
phoenix/
├── design-source/          # MediStock-Babil.dc.html (read-only reference)
├── docs/phoenix/           # Planning docs (this directory)
├── src/
│   ├── app/                # App.tsx, AppContext.tsx, main.tsx
│   ├── features/           # One dir per screen
│   │   ├── auth/
│   │   ├── dashboard/
│   │   ├── editor/
│   │   ├── registry/
│   │   ├── mesh/
│   │   ├── qr/
│   │   ├── health/
│   │   └── reports/
│   └── shared/
│       ├── i18n/strings.ts
│       ├── lib/            # tokens.css, global.css, types.ts
│       └── ui/             # Phoenix* component library
├── supabase/
│   └── migrations/         # 001_* 002_* 003_* (pending)
└── package.json
```
