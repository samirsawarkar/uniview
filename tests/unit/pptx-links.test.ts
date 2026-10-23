import { describe, it, expect } from 'vitest';
import { safePptxLink } from '../../src/viewers/pptx-links';

describe('safePptxLink', () => {
  it('accepts valid http, https, and mailto URLs', () => {
    expect(safePptxLink('http://example.com')).toBe('http://example.com');
    expect(safePptxLink('https://example.com/path?foo=bar#hash')).toBe('https://example.com/path?foo=bar#hash');
    expect(safePptxLink('mailto:user@example.com')).toBe('mailto:user@example.com');
    expect(safePptxLink('mailto:user@example.com?subject=Hello')).toBe('mailto:user@example.com?subject=Hello');
    expect(safePptxLink('  https://example.com  ')).toBe('https://example.com');
  });

  it('rejects URLs with trailing CRLF on https and raw control characters', () => {
    expect(safePptxLink('https://example.com\r\n')).toBeUndefined();
    expect(safePptxLink('https://example.com\n')).toBeUndefined();
    expect(safePptxLink('https://example.com\r')).toBeUndefined();
    expect(safePptxLink('https://example.com\t')).toBeUndefined();
    expect(safePptxLink('https://exa\x00mple.com')).toBeUndefined();
    expect(safePptxLink('\x1bhttps://example.com')).toBeUndefined();
    expect(safePptxLink('https://example.com\x7f')).toBeUndefined();
  });

  it('rejects disallowed protocols: javascript, data, file, ppaction', () => {
    expect(safePptxLink('javascript:alert(1)')).toBeUndefined();
    expect(safePptxLink('JAVASCRIPT:alert(1)')).toBeUndefined();
    expect(safePptxLink('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(safePptxLink('file:///etc/passwd')).toBeUndefined();
    expect(safePptxLink('file://C:/boot.ini')).toBeUndefined();
    expect(safePptxLink('ppaction://hlinksldjump')).toBeUndefined();
    expect(safePptxLink('ftp://example.com/file')).toBeUndefined();
  });

  it('rejects relative, malformed, or empty inputs', () => {
    expect(safePptxLink('relative/path')).toBeUndefined();
    expect(safePptxLink('/absolute/path')).toBeUndefined();
    expect(safePptxLink('../slide1.xml')).toBeUndefined();
    expect(safePptxLink('not a url')).toBeUndefined();
    expect(safePptxLink('http://')).toBeUndefined();
    expect(safePptxLink('')).toBeUndefined();
    expect(safePptxLink('   ')).toBeUndefined();
    expect(safePptxLink(undefined)).toBeUndefined();
  });
});
