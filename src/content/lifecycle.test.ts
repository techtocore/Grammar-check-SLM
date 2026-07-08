import { describe, it, expect } from 'vitest';
import { isContextInvalidationError } from './lifecycle';

describe('isContextInvalidationError', () => {
  it('matches the standard Chrome invalidation error', () => {
    expect(isContextInvalidationError(new Error('Extension context invalidated.'))).toBe(true);
    expect(isContextInvalidationError(new Error('Extension context was invalidated.'))).toBe(true);
  });

  it('matches regardless of case and for string errors', () => {
    expect(isContextInvalidationError('extension context invalidated')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isContextInvalidationError(new Error('Network request failed'))).toBe(false);
    expect(isContextInvalidationError(new Error('The message port closed before a response'))).toBe(
      false,
    );
  });
});
