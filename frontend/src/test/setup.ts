import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// React Testing Library's own auto-cleanup only registers itself when it
// detects a global `afterEach` (Jest-style globals). We run Vitest without
// `globals: true` so test files import their own describe/it/expect, which
// means that detection never fires - wire it up explicitly instead, or
// every test in a file renders into the same accumulating DOM.
afterEach(() => {
  cleanup();
});

// There used to be a beforeEach here seeding `peira_onboarding_seen`, because
// a modal auto-opened on a first visit and stole focus in every test that
// rendered the header. Nothing auto-opens any more - help is opened from the
// Help menu on purpose - so the workaround, and the key, are both gone.
