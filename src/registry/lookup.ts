/**
 * Registry — load curated x402-priced API entries from `seed.json` and
 * provide simple search/lookup over them.
 *
 * v0 search is intentionally crude: lowercase substring matching across
 * name + description + tags + category, scored by count of matched query
 * terms. Good enough for hundreds of entries; we'll switch to something
 * smarter (lunr / minisearch) when the registry crosses ~1k entries.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../log.js';
import type { RegistryEntry, RegistryFile } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SEED_PATH = resolve(here, 'seed.json');

export class Registry {
  constructor(public readonly entries: ReadonlyArray<RegistryEntry>) {}

  static async load(path: string = DEFAULT_SEED_PATH): Promise<Registry> {
    try {
      const text = await readFile(path, 'utf8');
      const parsed = JSON.parse(text) as RegistryFile;
      if (!Array.isArray(parsed.entries)) {
        throw new Error('registry file: `entries` must be an array');
      }
      return new Registry(parsed.entries);
    } catch (err: unknown) {
      logger.warn('registry: failed to load, falling back to empty', {
        path,
        err: err instanceof Error ? err.message : String(err),
      });
      return new Registry([]);
    }
  }

  /** Unique set of hostnames across all entries' endpoints. */
  hosts(): string[] {
    const set = new Set<string>();
    for (const e of this.entries) {
      try {
        // strip {placeholder} segments so URL parsing doesn't choke on them
        const cleanedUrl = e.endpoint.replace(/\{[^}]+\}/g, 'placeholder');
        set.add(new URL(cleanedUrl).hostname);
      } catch {
        // skip entries with unparseable endpoints
      }
    }
    return [...set].sort();
  }

  byId(id: string): RegistryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Search entries by free-text query. Lowercase substring match across
   * name + description + tags + category, scored by count of matched terms.
   * Empty query returns all entries (capped by `limit`).
   */
  search(query: string, opts: { limit?: number } = {}): RegistryEntry[] {
    const limit = opts.limit ?? 10;
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (terms.length === 0) {
      return this.entries.slice(0, limit);
    }

    const scored = this.entries
      .map((entry) => {
        const haystack = (
          entry.name +
          ' ' +
          entry.description +
          ' ' +
          entry.tags.join(' ') +
          ' ' +
          entry.category
        ).toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (haystack.includes(t)) score += 1;
        }
        return { entry, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((x) => x.entry);
  }
}
