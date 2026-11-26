---
title: Development
description: Requires Node 26 or later.
---

Requires Node 26 or later. TypeScript files run directly; there is no build step.

```bash
npm ci
npm test
npm run typecheck
npm run lint
```

Tests never reach the network. The test setup blocks sockets and `fetch`, and clears credential variables, so a test that tries to reach GitHub or a model fails.

The web UI is a package of its own, `ui/` (React, TypeScript, Vite, Tailwind CSS, with Vitest and Testing Library), with its own exact versions and lock file, its own lint config and its own `node_modules`; the root lint ignores it, and nothing in `src/` imports from it. It needs its own install, which reaches the network once:

```bash
npm --prefix ui ci
npm --prefix ui run lint
npm --prefix ui run typecheck
npm --prefix ui test
npm --prefix ui run build
```

Its tests stub the API and block `fetch`, `XMLHttpRequest`, `WebSocket` and `EventSource`. `build` writes `ui/dist`, which git ignores. CI runs the root checks and these.
