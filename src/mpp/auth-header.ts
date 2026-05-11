/**
 * RFC 7235 HTTP Authentication header parser/builder, scoped to the
 * `Payment` auth-scheme used by MPP (paymentauth.org/draft-solana-charge-00).
 *
 * Servers emit:
 *   WWW-Authenticate: Payment id="...", realm="...", method="solana",
 *     intent="charge", request="<b64url-JCS>", expires="<ISO-8601>",
 *     description="<optional human label>"
 *
 * Buyers reply with:
 *   Authorization: Payment <b64url-JCS credential>
 *
 * The `Payment` scheme does not use auth-params on the request side — the
 * value after the scheme name is a single base64url token (the credential).
 *
 * Multi-challenge headers (RFC 7235 §4.1 allows several comma-separated
 * challenges) are not handled here — we accept the first `Payment` challenge
 * and throw if a non-Payment scheme appears before it. In practice MPP
 * sellers emit a single-challenge header.
 */

export type ParsedPaymentChallenge = {
  scheme: 'Payment';
  id: string;
  realm: string;
  /** Always `"solana"` in this spec, but parsed verbatim. */
  method: string;
  /** Always `"charge"` in this spec, but parsed verbatim. */
  intent: string;
  /** base64url(JCS(ChargeRequest)) — still encoded; decode separately. */
  request: string;
  /** ISO-8601 datetime string. Caller compares against current time. */
  expires: string;
  /** Optional human-readable label some sellers include. */
  description?: string;
  /** Any auth-params we don't recognize, lowercased. Surfaced for forward-compat. */
  extras: Record<string, string>;
};

const TOKEN_CHAR_RE = /[A-Za-z0-9!#$%&'*+\-.^_`|~]/;
/** Token + `/` (for slash-bearing base64url values used as bare tokens by some sellers). */
const TOKEN_VALUE_CHAR_RE = /[A-Za-z0-9!#$%&'*+\-.^_`|~/]/;

export function parsePaymentChallenge(header: string): ParsedPaymentChallenge {
  let i = 0;
  const len = header.length;

  const skipWs = (): void => {
    while (i < len && (header[i] === ' ' || header[i] === '\t')) i++;
  };

  skipWs();
  const schemeStart = i;
  while (i < len && header[i] !== ' ' && header[i] !== '\t') i++;
  const scheme = header.slice(schemeStart, i);
  if (scheme.toLowerCase() !== 'payment') {
    throw new Error(`unexpected WWW-Authenticate scheme: "${scheme}" (expected "Payment")`);
  }
  skipWs();

  const params = new Map<string, string>();
  while (i < len) {
    const nameStart = i;
    while (i < len && TOKEN_CHAR_RE.test(header[i])) i++;
    if (i === nameStart) {
      throw new Error(`expected auth-param name at index ${i} of WWW-Authenticate header`);
    }
    const name = header.slice(nameStart, i).toLowerCase();

    skipWs();
    if (header[i] !== '=') {
      throw new Error(`expected "=" after auth-param "${name}" at index ${i}`);
    }
    i++;
    skipWs();

    let value: string;
    if (header[i] === '"') {
      i++;
      let v = '';
      while (i < len && header[i] !== '"') {
        if (header[i] === '\\') {
          i++;
          if (i >= len) throw new Error('unterminated escape inside quoted-string');
          v += header[i];
          i++;
        } else {
          v += header[i];
          i++;
        }
      }
      if (header[i] !== '"') {
        throw new Error(`unterminated quoted-string for auth-param "${name}"`);
      }
      i++;
      value = v;
    } else {
      const valStart = i;
      while (i < len && TOKEN_VALUE_CHAR_RE.test(header[i])) i++;
      if (i === valStart) {
        throw new Error(`expected value for auth-param "${name}" at index ${i}`);
      }
      value = header.slice(valStart, i);
    }
    params.set(name, value);

    skipWs();
    if (i < len) {
      if (header[i] !== ',') {
        throw new Error(
          `expected "," between auth-params at index ${i}, found "${header[i]}"`,
        );
      }
      i++;
      skipWs();
    }
  }

  const required = ['id', 'realm', 'method', 'intent', 'request', 'expires'] as const;
  for (const k of required) {
    if (!params.has(k)) {
      throw new Error(`MPP challenge missing required auth-param "${k}"`);
    }
  }

  const known = new Set<string>([...required, 'description']);
  const extras: Record<string, string> = {};
  for (const [k, v] of params) {
    if (!known.has(k)) extras[k] = v;
  }

  return {
    scheme: 'Payment',
    id: params.get('id') as string,
    realm: params.get('realm') as string,
    method: params.get('method') as string,
    intent: params.get('intent') as string,
    request: params.get('request') as string,
    expires: params.get('expires') as string,
    description: params.get('description'),
    extras,
  };
}

/** Build the value of the `Authorization` header for an MPP credential. */
export function buildAuthorizationHeader(credentialBase64Url: string): string {
  return `Payment ${credentialBase64Url}`;
}

/**
 * Test whether a `WWW-Authenticate` header value advertises an MPP challenge.
 * Used by the unified fetch handler to decide between x402 and MPP routing.
 * Cheap shape check only — full parsing happens in `parsePaymentChallenge`.
 */
export function isMppChallengeHeader(header: string | null | undefined): boolean {
  if (!header) return false;
  return /^\s*payment\b/i.test(header);
}
