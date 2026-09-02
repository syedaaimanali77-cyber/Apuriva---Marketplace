import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Not using vitest's `globals: true`, so @testing-library/react's automatic afterEach
// detection never fires — register cleanup explicitly so DOM doesn't leak between tests.
afterEach(() => {
  cleanup();
});
