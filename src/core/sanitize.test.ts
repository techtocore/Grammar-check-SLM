import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeRegExp } from './sanitize';

describe('escapeHtml', () => {
  it('escapes all dangerous HTML characters', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
    expect(escapeHtml("a & b < c > d ' e")).toBe('a &amp; b &lt; c &gt; d &#39; e');
  });

  it('leaves safe text unchanged', () => {
    expect(escapeHtml('Hello world')).toBe('Hello world');
  });
});

describe('escapeRegExp', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegExp('a.b*c+?')).toBe('a\\.b\\*c\\+\\?');
    expect(escapeRegExp('(x)[y]{z}')).toBe('\\(x\\)\\[y\\]\\{z\\}');
  });

  it('produces a pattern that matches the literal string', () => {
    const input = 'a.b(c)';
    const re = new RegExp(escapeRegExp(input));
    expect(re.test(input)).toBe(true);
    expect(re.test('axb_c_')).toBe(false);
  });
});
