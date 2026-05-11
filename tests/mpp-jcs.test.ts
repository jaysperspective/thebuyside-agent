/**
 * JCS canonicalizer tests — exercises key ordering, escape handling, and
 * the base64url roundtrip used by `Authorization: Payment <b64url>` payloads.
 */

import { describe, expect, it } from 'vitest';
import { decodeJcsBase64Url, jcsBase64Url, jcsStringify } from '../src/mpp/jcs.js';

describe('jcsStringify', () => {
  it('sorts object keys lexicographically', () => {
    expect(jcsStringify({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it('sorts nested object keys recursively', () => {
    const v = { z: { d: 1, b: 2 }, a: { y: 3, x: 4 } };
    expect(jcsStringify(v)).toBe('{"a":{"x":4,"y":3},"z":{"b":2,"d":1}}');
  });

  it('preserves array order', () => {
    expect(jcsStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles primitives and null', () => {
    expect(jcsStringify('hello')).toBe('"hello"');
    expect(jcsStringify(42)).toBe('42');
    expect(jcsStringify(true)).toBe('true');
    expect(jcsStringify(false)).toBe('false');
    expect(jcsStringify(null)).toBe('null');
  });

  it('emits integers without trailing decimal point', () => {
    expect(jcsStringify(1.0)).toBe('1');
    expect(jcsStringify({ n: 10000 })).toBe('{"n":10000}');
  });

  it('escapes control characters in strings', () => {
    expect(jcsStringify('a\tb\nc')).toBe('"a\\tb\\nc"');
  });

  it('skips undefined values (matching JSON.stringify)', () => {
    expect(jcsStringify({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('throws on BigInt', () => {
    expect(() => jcsStringify({ n: 1n })).toThrow(/BigInt/);
  });

  it('throws on non-finite numbers', () => {
    expect(() => jcsStringify(NaN)).toThrow(/non-finite/);
    expect(() => jcsStringify(Infinity)).toThrow(/non-finite/);
  });

  it('produces byte-identical output regardless of input key order', () => {
    const a = jcsStringify({ x: 1, y: 2, z: 3 });
    const b = jcsStringify({ z: 3, x: 1, y: 2 });
    const c = jcsStringify({ y: 2, z: 3, x: 1 });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('jcsBase64Url + decodeJcsBase64Url', () => {
  it('roundtrips an MPP-shaped charge request', () => {
    const charge = {
      amount: '10000',
      currency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      recipient: '6edCkdUnCfCtVnai7eCNmWjjYUp2dWonqWxr8gEUzRTo',
      methodDetails: {
        decimals: 6,
        feePayer: true,
        feePayerKey: '6edCkdUnCfCtVnai7eCNmWjjYUp2dWonqWxr8gEUzRTo',
        network: 'mainnet',
        recentBlockhash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      },
    };
    const encoded = jcsBase64Url(charge);
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(decodeJcsBase64Url(encoded)).toEqual(charge);
  });

  it('decodes the captured pay.sh debugger request payload verbatim', () => {
    // Real wire data from `curl -i https://debugger.pay.sh/mpp/quote/AAPL`
    // on 2026-05-10. Encoded value is what the WWW-Authenticate `request`
    // auth-param actually carried.
    const captured =
      'eyJhbW91bnQiOiIxMDAwMCIsImN1cnJlbmN5IjoiRVBqRldkZDVBdWZxU1NxZU0ycU4xeHp5YmFwQzhHNHdFR0drWnd5VER0MXYiLCJtZXRob2REZXRhaWxzIjp7ImRlY2ltYWxzIjo2LCJmZWVQYXllciI6dHJ1ZSwiZmVlUGF5ZXJLZXkiOiI2ZWRDa2RVbkNmQ3RWbmFpN2VDTm1XampZVXAyZFdvbnFXeHI4Z0VVelJUbyIsIm5ldHdvcmsiOiJsb2NhbG5ldCIsInJlY2VudEJsb2NraGFzaCI6IlNVUkZORVR4U0FGRUhBU0h4eHh4eHh4eHh4eHh4eHh4eHh4MThmNmFieGIiLCJ0b2tlblByb2dyYW0iOiJUb2tlbmtlZ1FmZVp5aU53QUpiTmJHS1BGWENXdUJ2ZjlTczYyM1ZRNURBIn0sInJlY2lwaWVudCI6IjZlZENrZFVuQ2ZDdFZuYWk3ZUNObVdqallVcDJkV29ucVd4cjhnRVV6UlRvIn0';
    const decoded = decodeJcsBase64Url(captured) as Record<string, unknown>;
    expect(decoded.amount).toBe('10000');
    expect(decoded.currency).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(decoded.recipient).toBe('6edCkdUnCfCtVnai7eCNmWjjYUp2dWonqWxr8gEUzRTo');
    const md = decoded.methodDetails as Record<string, unknown>;
    expect(md.feePayer).toBe(true);
    expect(md.network).toBe('localnet');
    expect(md.decimals).toBe(6);
    expect(md.tokenProgram).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  });
});
