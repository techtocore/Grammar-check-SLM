import { describe, expect, it } from 'vitest';
import { supportsContentUi } from './document-support';

describe('supportsContentUi', () => {
  it('accepts HTML and XHTML documents', () => {
    const xhtml = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>',
      'application/xhtml+xml',
    );

    expect(supportsContentUi(document)).toBe(true);
    expect(supportsContentUi(xhtml)).toBe(true);
  });

  it('rejects SVG and generic XML documents', () => {
    const svg = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'image/svg+xml',
    );
    const xml = new DOMParser().parseFromString('<root/>', 'application/xml');

    expect(supportsContentUi(svg)).toBe(false);
    expect(supportsContentUi(xml)).toBe(false);
  });
});
