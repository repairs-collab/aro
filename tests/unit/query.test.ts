import { describe, expect, it } from 'vitest';
import { encodePairs } from '../../src/aroflo/query.js';

describe('encodePairs', () => {
  it('preserves pair order and encodes spaces and reserved characters exactly once', () => {
    const varString = encodePairs([
      ['first key', 'value with space'],
      ['reserved', 'a&b=c%?']
    ]);

    expect(varString).toBe('first%20key=value%20with%20space&reserved=a%26b%3Dc%25%3F');
    expect(varString).not.toContain('+');
  });

  it('returns the exact encoded value for use as a wire query or signing input', () => {
    const varString = encodePairs([
      ['zone', 'tasks'],
      ['page', 1],
      ['includeArchived', false]
    ]);

    expect(varString).toBe('zone=tasks&page=1&includeArchived=false');
  });
});
