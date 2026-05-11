/**
 * JCS — JSON Canonicalization Scheme (RFC 8785).
 *
 * MPP credentials and challenges are base64url-encoded over a JCS-canonical
 * JSON form so that buyer and seller derive byte-identical bytes from
 * equivalent JSON values. Used inside `src/mpp/auth-header.ts` and
 * `src/mpp/client.ts` only.
 *
 * Strategy:
 *  - Primitives (string, finite number, boolean, null) delegate to
 *    `JSON.stringify`, whose output is already ECMA-262 7.1.13 — which JCS
 *    accepts unchanged.
 *  - Containers are walked manually so object keys can be sorted in UTF-16
 *    code-unit order (the JCS requirement and JS's default `Array.sort`
 *    comparator for strings).
 *  - `undefined` values are skipped (mirroring `JSON.stringify`).
 *  - BigInt, function, symbol, and non-finite numbers throw — JCS has no
 *    representation for them.
 */
export function jcsStringify(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('JCS: non-finite numbers (NaN/Infinity) are not allowed');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw new Error('JCS: BigInt is not representable; serialize as a string first');
    case 'function':
    case 'symbol':
    case 'undefined':
      throw new Error(`JCS: cannot serialize ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(jcsStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + jcsStringify(v));
  }
  return '{' + parts.join(',') + '}';
}

/** Encode a value as JCS-canonical JSON then base64url (no padding). */
export function jcsBase64Url(value: unknown): string {
  return base64UrlEncode(Buffer.from(jcsStringify(value), 'utf8'));
}

/** Decode a base64url (with or without padding) JCS string back into a JS value. */
export function decodeJcsBase64Url(s: string): unknown {
  const buf = base64UrlDecode(s);
  return JSON.parse(buf.toString('utf8'));
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
