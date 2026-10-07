import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Code must never depend on the machine's zone; every time function takes an explicit IANA zone.
    env: { TZ: 'Pacific/Kiritimati' },
  },
});
