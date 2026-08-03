import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// React Testing Library's own auto-cleanup only registers itself when it
// detects a global `afterEach` (Jest-style globals). We run Vitest without
// `globals: true` so test files import their own describe/it/expect, which
// means that detection never fires - wire it up explicitly instead, or
// every test in a file renders into the same accumulating DOM.
afterEach(() => {
  cleanup();
});

// Default every test to "onboarding already seen", so NotebookHeader's
// OnboardingModal doesn't auto-open (and steal focus into itself) in tests
// that have nothing to do with onboarding - jsdom's localStorage otherwise
// starts empty, matching a real first-ever visit. Tests that specifically
// exercise the onboarding flow (NotebookHeader.test.tsx) clear localStorage
// in their own beforeEach, which runs after this one and overrides it.
beforeEach(() => {
  localStorage.setItem('peira_onboarding_seen', 'true');
});
