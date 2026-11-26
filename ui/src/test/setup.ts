import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/** What every way out to the network gives in the frontend's tests (call 7): the tests stub the API object instead. */
export class NetworkBlockedError extends Error {
  constructor() {
    super('The network is blocked in tests.');
    this.name = 'NetworkBlockedError';
  }
}

class Blocked {
  constructor() {
    throw new NetworkBlockedError();
  }
}

Object.assign(globalThis, {
  fetch: () => Promise.reject(new NetworkBlockedError()),
  XMLHttpRequest: Blocked,
  WebSocket: Blocked,
  EventSource: Blocked,
});

// jsdom has no matchMedia: the system's theme reads as light.
Object.assign(window, {
  matchMedia: (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }),
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.className = '';
});
