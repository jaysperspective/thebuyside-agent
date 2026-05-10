/**
 * Host allowlist — the gateway only pays hosts in this set, unless the
 * caller explicitly overrides with X402_ALLOW_UNVERIFIED=1.
 *
 * v0 default is hardcoded to {news-ep.com}. M3 swaps the hardcoded list for
 * a read of `src/registry/seed.json` so the allowlist auto-tracks the
 * curated registry.
 *
 * Override via env:
 *   X402_ALLOWLIST=news-ep.com,api.example.com  (comma-separated hostnames)
 *   X402_ALLOW_UNVERIFIED=1                      (bypass — for dev/testing)
 */

const DEFAULT_HOSTS = ['news-ep.com'];

export type AllowDecision = { ok: true } | { ok: false; reason: string };

export class Allowlist {
  private readonly hosts: Set<string>;
  private readonly allowAny: boolean;

  constructor(opts: { hosts?: string[]; allowAny?: boolean } = {}) {
    this.hosts = new Set(opts.hosts ?? DEFAULT_HOSTS);
    this.allowAny = opts.allowAny ?? false;
  }

  static fromEnv(): Allowlist {
    const fromEnv = process.env.X402_ALLOWLIST?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return new Allowlist({
      hosts: fromEnv && fromEnv.length > 0 ? fromEnv : undefined,
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
