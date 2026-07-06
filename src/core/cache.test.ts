import { describe, it, expect } from 'vitest';
import { LRUCache } from './cache';

describe('LRUCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.has('a')).toBe(true);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry when full', () => {
    const cache = new LRUCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts 'a'
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('refreshes recency on get', () => {
    const cache = new LRUCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // 'a' now most-recent
    cache.set('c', 3); // evicts 'b'
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('clears all entries', () => {
    const cache = new LRUCache<string, number>(2);
    cache.set('a', 1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
