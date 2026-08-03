# Peira — Frontend

Phase 2 of the project: a React + TypeScript SPA (Vite) for coaches to
build and grade Peiras, including the film-annotation drawing tool, plus
the public flow players use to take one. Talks to the Flask API in
`../backend`.

## Stack

- **React 19 + TypeScript**, routed with `react-router-dom`
- **Fabric.js** for the image annotation canvas (lines, curves, freehand,
  arrows, shapes with adjustable fill opacity, text callouts, layering,
  undo/redo)
- Plain CSS Modules for styling — no UI framework dependency
- A small typed `fetch` wrapper (`src/api/client.ts`) instead of a heavier
  HTTP client

## Project layout

```
src/
  api/            typed request functions + response types, one file per backend resource
  auth/           AuthContext (JWT storage) + ProtectedRoute
  components/     shared UI (Layout, ErrorBanner) and the annotation tool
    annotation/     Fabric.js canvas, toolbar, layers panel, history, shape factories
  pages/
    quiz-editor/    coach-facing quiz build/manage/grade screens (tabbed)
    play/           public, unauthenticated player flow (join → name → quiz → submitted)
```

## Running locally

1. Make sure the backend is running (see the root [`README.md`](../README.md))
   and copy `.env.example` to `.env`, pointing `VITE_API_URL` at it.
2. The backend's `CORS_ORIGINS` must include this app's origin — both
   `http://localhost:5173` and `http://127.0.0.1:5173`, since browsers
   treat them as different origins.

```bash
npm install
npm run dev
```

## Annotation data format

`QuestionImage.annotations` (from the backend) is a plain JSON array. This
app stores it as Fabric's own per-object serialization
(`canvas.toObject(['id']).objects`) rather than a hand-rolled shape schema
— Fabric's `loadFromJSON` can reconstruct the exact canvas state from it,
which is far more reliable than reimplementing serialization ourselves.
The backend only validates that it's a list of objects; it never
interprets the contents.

## Testing

Vitest + React Testing Library + jsdom. Tests live next to the code they
cover (`Foo.tsx` / `Foo.test.tsx`).

```bash
npm run test        # run once
npm run test:watch  # watch mode
```

Coverage focus is the core flows and logic most likely to break silently:
the API client's request/error handling, `AuthContext` (including a
regression test for treating a network failure differently from a
rejected token — see the backend/frontend history around that bug), the
question builder's validation rules, the annotation tool's undo/redo state
machine and curve math, and the login/dashboard/player-join page flows.
The annotation *canvas* itself (real Fabric.js rendering) isn't covered
here — jsdom has no real `<canvas>` — the undo/redo and curve-math tests
mock or isolate the Fabric dependency instead.

## Scripts

- `npm run dev` — dev server with HMR
- `npm run build` — type-check (`tsc -b`) and production build
- `npm run lint` — oxlint
- `npm run test` / `npm run test:watch` — Vitest
