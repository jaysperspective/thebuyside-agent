/**
 * Host allowlist — the gateway only pays hosts in this set, unless the
 * caller explicitly overrides with X402_ALLOW_UNVERIFIED=1.
 *
 * The default allowlist is derived from the registry (`src/registry/seed.json`)
 * so it auto-tracks the curated set of x402-priced APIs we ship with.
 *
 * Override via env:
 *   X402_ALLOWLIST=news-ep.com,api.example.com  (comma-separated hostnames)
 *   X402_ALLOW_UNVERIFIED=1                      (bypass — for dev/testing)
 */

const FALLBACK_HOSTS = ['news-ep.com'];

export type AllowDecision = { ok: true } | { ok: false; reason: string };

export class Allowlist {
  private readonly hosts: Set<string>;
  private readonly allowAny: boolean;

  constructor(opts: { hosts?: string[]; allowAny?: boolean } = {}) {
    const hosts = opts.hosts && opts.hosts.length > 0 ? opts.hosts : FALLBACK_HOSTS;
    this.hosts = new Set(hosts);
    this.allowAny = opts.allowAny ?? false;
  }

  /**
   * Build an Allowlist from environment variables, with `defaultHosts`
   * (typically the registry's host list) used when X402_ALLOWLIST is unset.
   */
  static fromEnv(opts: { defaultHosts?: string[] } = {}): Allowlist {
    const fromEnv = process.env.X402_ALLOWLIST?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return new Allowlist({
      hosts: fromEnv && fromEnv.length > 0 ? fromEnv : opts.defaultHosts,
      allowAny: process.env.X402_ALLOW_UNVERIFIED === '1',
    });
  }

  check(url: string): AllowDecision {
    if (this.allowAny) return { ok: true };

    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return { ok: false, reason: `invalid URL: ${url}` };
    }

    if (this.hosts.has(host)) return { ok: true };

    const sorted = [...this.hosts].sort();
    return {
      ok: false,
      reason:
        `host "${host}" is not in the allowlist ` +
        `(allowed: ${sorted.length > 0 ? sorted.join(', ') : '(none)'}). ` +
        `Set X402_ALLOWLIST=<hosts> to permit, or X402_ALLOW_UNVERIFIED=1 to bypass.`,
    };
  }

  get allowedHosts(): string[] {
    return [...this.hosts].sort();
  }

  get isUnrestricted(): boolean {
    return this.allowAny;
  }
}
