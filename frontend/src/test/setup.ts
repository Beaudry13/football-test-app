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
