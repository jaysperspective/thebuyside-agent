/**
 * RFC 7235 WWW-Authenticate parser tests, scoped to the `Payment` scheme used
 * by MPP. The captured pay.sh debugger header doubles as the realistic fixture.
 */

import { describe, expect, it } from 'vitest';
import {
  buildAuthorizationHeader,
  isMppChallengeHeader,
  parsePaymentChallenge,
} from '../src/mpp/auth-header.js';

// Real header captured 2026-05-10 from
// `curl -i https://debugger.pay.sh/mpp/quote/AAPL`.
const REAL_HEADER =
  'Payment id="gw8ITRWkbgJNVpa40EvQBWlPr43qoVc8rvnDykUXJfE", ' +
  'realm="payment-debugger-dytj4kvoi-solana-foundation.vercel.app", ' +
  'method="solana", intent="charge", ' +
  'request="eyJhbW91bnQiOiIxMDAwMCJ9", ' +
  'description="Stock quote: AAPL", ' +
  'expires="2026-05-10T22:41:44.758Z"';

describe('parsePaymentChallenge', () => {
  it('parses the captured pay.sh debugger header', () => {
    const c = parsePaymentChallenge(REAL_HEADER);
    expect(c.scheme).toBe('Payment');
    expect(c.id).toBe('gw8ITRWkbgJNVpa40EvQBWlPr43qoVc8rvnDykUXJfE');
    expect(c.realm).toBe('payment-debugger-dytj4kvoi-solana-foundation.vercel.app');
    expect(c.method).toBe('solana');
    expect(c.intent).toBe('charge');
    expect(c.request).toBe('eyJhbW91bnQiOiIxMDAwMCJ9');
    expect(c.expires).toBe('2026-05-10T22:41:44.758Z');
    expect(c.description).toBe('Stock quote: AAPL');
  });

  it('is case-insensitive on the scheme name', () => {
    const lower = REAL_HEADER.replace(/^Payment/, 'payment');
    const upper = REAL_HEADER.replace(/^Payment/, 'PAYMENT');
    expect(parsePaymentChallenge(lower).id).toBe(parsePaymentChallenge(upper).id);
  });

  it('rejects a non-Payment scheme', () => {
    const bearer = 'Bearer realm="x"';
    expect(() => parsePaymentChallenge(bearer)).toThrow(/expected "Payment"/);
  });

  it('rejects when a required auth-param is missing', () => {
    const missingExpires = REAL_HEADER.replace(/, expires="[^"]+"$/, '');
    expect(() => parsePaymentChallenge(missingExpires)).toThrow(/expires/);
  });

  it('handles quoted-string escape sequences', () => {
    const h =
      'Payment id="abc", realm="he said \\"hi\\"", method="solana", ' +
      'intent="charge", request="r", expires="t"';
    const c = parsePaymentChallenge(h);
    expect(c.realm).toBe('he said "hi"');
  });

  it('tolerates extra whitespace around tokens', () => {
    const h =
      'Payment    id = "a",  realm = "b",  method="solana",  ' +
      'intent="charge", request="r", expires="t"';
    const c = parsePaymentChallenge(h);
    expect(c.id).toBe('a');
    expect(c.realm).toBe('b');
  });

  it('captures unrecognized auth-params into extras', () => {
    const h =
      'Payment id="a", realm="b", method="solana", intent="charge", ' +
      'request="r", expires="t", futureflag="on"';
    const c = parsePaymentChallenge(h);
    expect(c.extras).toEqual({ futureflag: 'on' });
  });
});

describe('isMppChallengeHeader', () => {
  it('returns true for the Payment scheme regardless of case', () => {
    expect(isMppChallengeHeader('Payment id="a"')).toBe(true);
    expect(isMppChallengeHeader('payment id="a"')).toBe(true);
    expect(isMppChallengeHeader('  PAYMENT id="a"')).toBe(true);
  });

  it('returns false for x402 / Bearer / Basic / null', () => {
    expect(isMppChallengeHeader('Bearer realm="x"')).toBe(false);
    expect(isMppChallengeHeader('Basic realm="x"')).toBe(false);
    expect(isMppChallengeHeader(null)).toBe(false);
    expect(isMppChallengeHeader(undefined)).toBe(false);
    expect(isMppChallengeHeader('')).toBe(false);
  });
});

describe('buildAuthorizationHeader', () => {
  it('formats Payment scheme with the base64url credential', () => {
    expect(buildAuthorizationHeader('abc123')).toBe('Payment abc123');
  });
});
