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

// jsdom implements neither `play()` nor `pause()` on HTMLMediaElement: calling
// either logs "Not implemented: HTMLMediaElement's play() method" through the
// virtual console. ClipPlayer legitimately calls play() on mount - autoplay is
// a request the browser may refuse, and catching that refusal is what gives a
// player a way to start a clip iOS declined to start - so every test that
// renders a clip would print that line without this.
//
// A resolved promise, because that is what a browser that ACCEPTS the request
// returns. Tests that need a refusal override these locally and restore them.
// `paused` is deliberately left alone: jsdom's own getter is correct enough
// for tests that never toggle playback, and the ones that do define their own.
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  writable: true,
  value: () => Promise.resolve(),
});
Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  writable: true,
  value: () => {},
});
