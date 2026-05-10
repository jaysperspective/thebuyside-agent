import { describe, expect, it } from 'vitest';
import { Allowlist } from '../src/policy/allowlist.js';

describe('Allowlist', () => {
  it('allows the default news-ep host', () => {
    const al = new Allowlist();
    expect(al.check('https://news-ep.com/api/v1/stories').ok).toBe(true);
  });

  it('rejects an unlisted host with a useful error', () => {
    const al = new Allowlist({ hosts: ['known.test'] });
    const decision = al.check('https://unknown.test/api');
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/unknown\.test/);
      expect(decision.reason).toMatch(/known\.test/); // shows allowed list
      expect(decision.reason).toMatch(/X402_ALLOW_UNVERIFIED/);
    }
  });

  it('rejects an invalid URL', () => {
    const al = new Allowlist();
    const decision = al.check('not-a-url');
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/invalid URL/);
  });

  it('matches by hostname only (ignores path, port, scheme)', () => {
    const al = new Allowlist({ hosts: ['example.test'] });
    expect(al.check('https://example.test:8080/some/path?q=1').ok).toBe(true);
    expect(al.check('http://example.test').ok).toBe(true);
    expect(al.check('https://other.example.test').ok).toBe(false); // subdomain match must be exact
  });

  it('allowAny bypasses the host check', () => {
    const al = new Allowlist({ hosts: ['known.test'], allowAny: true });
    expect(al.check('https://random.example.com/any/path').ok).toBe(true);
    expect(al.isUnrestricted).toBe(true);
  });

  it('allowedHosts returns the configured list, sorted', () => {
    const al = new Allowlist({ hosts: ['c.test', 'a.test', 'b.test'] });
    expect(al.allowedHosts).toEqual(['a.test', 'b.test', 'c.test']);
  });
});
