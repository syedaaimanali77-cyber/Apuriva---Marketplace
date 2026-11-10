import { act } from '@testing-library/react';

/**
 * Spec 044 test support — puts jsdom's browser online or offline the way a real one reports it:
 * `navigator.onLine` plus the matching `online`/`offline` window event.
 */
export function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}
