import { describe, it, expect } from 'vitest';

describe('integration smoke', () => {
  it('the test runner is alive', () => {
    expect(1 + 1).toBe(2);
  });
});
