import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmPolicy } from '../src/policy/confirm.js';

type FakeServer = {
  getClientCapabilities: ReturnType<typeof vi.fn>;
  elicitInput: ReturnType<typeof vi.fn>;
};

function makeServer(opts: {
  elicitationSupported: boolean;
  elicitResult?: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
  elicitError?: Error;
}): { mcp: McpServer; fake: FakeServer } {
  const fake: FakeServer = {
    getClientCapabilities: vi.fn(() =>
      opts.elicitationSupported ? { elicitation: {} } : {},
    ),
    elicitInput: vi.fn(async () => {
      if (opts.elicitError) throw opts.elicitError;
      return opts.elicitResult ?? { action: 'accept', content: { approve: true } };
    }),
  };
  // Cast: we only exercise `.server.getClientCapabilities` and `.server.elicitInput`.
  const mcp = { server: fake } as unknown as McpServer;
  return { mcp, fake };
}

const askArgs = {
  amountAtomic: 5000n,
  host: 'news-ep.com',
  method: 'GET',
  url: 'https://news-ep.com/api/v1/stories?market=houston',
  todaySpentAtomic: 12_000n,
  dailyCapAtomic: 1_000_000n,
};

describe('ConfirmPolicy.fromEnv', () => {
  const ENV_KEYS = ['X402_REQUIRE_CONFIRM', 'X402_CONFIRM_STRICT'];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to 'always' when no env is set", () => {
    const p = ConfirmPolicy.fromEnv();
    expect(p.config.mode.type).toBe('always');
    expect(p.config.strict).toBe(false);
  });

  it("parses 'always'", () => {
    process.env.X402_REQUIRE_CONFIRM = 'always';
    expect(ConfirmPolicy.fromEnv().config.mode.type).toBe('always');
  });

  it("parses 'never' and 'off' as never", () => {
    process.env.X402_REQUIRE_CONFIRM = 'never';
    expect(ConfirmPolicy.fromEnv().config.mode.type).toBe('never');
    process.env.X402_REQUIRE_CONFIRM = 'off';
    expect(ConfirmPolicy.fromEnv().config.mode.type).toBe('never');
  });

  it("parses a decimal USDC threshold", () => {
    process.env.X402_REQUIRE_CONFIRM = '0.01';
    const m = ConfirmPolicy.fromEnv().config.mode;
    expect(m.type).toBe('threshold');
    if (m.type === 'threshold') expect(m.minAtomic).toBe(10_000n);
  });

  it("parses an atomic threshold", () => {
    process.env.X402_REQUIRE_CONFIRM = '50000';
    const m = ConfirmPolicy.fromEnv().config.mode;
    expect(m.type).toBe('threshold');
    if (m.type === 'threshold') expect(m.minAtomic).toBe(50_000n);
  });

  it('rejects garbage', () => {
    process.env.X402_REQUIRE_CONFIRM = 'sometimes';
    expect(() => ConfirmPolicy.fromEnv()).toThrow(/'always', 'never', or a USDC amount/);
  });

  it('honors strict flag', () => {
    process.env.X402_CONFIRM_STRICT = '1';
    expect(ConfirmPolicy.fromEnv().config.strict).toBe(true);
  });
});

describe('ConfirmPolicy.shouldConfirm', () => {
  it("'always' confirms every amount", () => {
    const p = new ConfirmPolicy({ mode: { type: 'always' }, strict: false });
    expect(p.shouldConfirm(1n)).toBe(true);
    expect(p.shouldConfirm(10_000_000_000n)).toBe(true);
  });

  it("'never' confirms nothing", () => {
    const p = new ConfirmPolicy({ mode: { type: 'never' }, strict: false });
    expect(p.shouldConfirm(1n)).toBe(false);
    expect(p.shouldConfirm(10_000_000_000n)).toBe(false);
  });

  it("'threshold' confirms at or above only", () => {
    const p = new ConfirmPolicy({
      mode: { type: 'threshold', minAtomic: 10_000n },
      strict: false,
    });
    expect(p.shouldConfirm(9_999n)).toBe(false);
    expect(p.shouldConfirm(10_000n)).toBe(true);
    expect(p.shouldConfirm(10_001n)).toBe(true);
  });
});

describe('ConfirmPolicy.ask', () => {
  it('skips elicitation when shouldConfirm is false', async () => {
    const { mcp, fake } = makeServer({ elicitationSupported: true });
    const p = new ConfirmPolicy({ mode: { type: 'never' }, strict: false });
    const result = await p.ask(mcp, askArgs);
    expect(result).toEqual({ ok: true });
    expect(fake.elicitInput).not.toHaveBeenCalled();
  });

  it('returns ok when client accepts and approves', async () => {
    const { mcp, fake } = makeServer({
      elicitationSupported: true,
      elicitResult: { action: 'accept', content: { approve: true } },
    });
    const p = new ConfirmPolicy({ mode: { type: 'always' }, strict: false });
    expect(await p.ask(mcp, askArgs)).toEqual({ ok: true });
    expect(fake.elicitInput).toHaveBeenCalledOnce();
    const call = fake.elicitInput.mock.calls[0]![0];
    expect(call.message).toMatch(/news-ep\.com/);
    expect(call.message).toMatch(/0\.005000/);
    expect(call.requestedSchema.required).toEqual(['approve']);
  });

  it('rejects when accept but approve=false', async () => {
    const { mcp } = makeServer({
      elicitationSupported: true,
      elicitResult: { action: 'accept', content: { approve: false } },
    });
    const p = new ConfirmPolicy({ mode: { type: 'always' }, strict: false });
    const r = await p.ask(mcp, askArgs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/declined/);
  });

  it('rejects on action=decline', async () => {
    const { mcp } = makeServer({
      elicitationSupported: true,
      elicitResult: { action: 'decline' },
    });
    const p = new ConfirmPolicy({ mode: { type: 'always' }, strict: false });
    const r = await p.ask(mcp, askArgs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/declined/);
  });

  it('rejects on action=cancel', async () => {
    const { mcp } = makeServer({
      elicitationSupported: true,
      elicitResult: { action: 'cancel' },
    });
    const p = new ConfirmPolicy({ mode: { type: 'always' }, strict: false });
    const r = await p.ask(mcp, askArgs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cancelled/);
  });

  it('rejects when elicitInput throws', async () => {
    const { mcp } = makeServer({
      elicitationSupported: true,
      elicitError: new Error('transport closed'),
    });
    const p = new ConfirmPolicy({ mode: { type: 'always' }, strict: false });
    const r = await p.ask(mcp, askArgs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/transport closed/);
  });

  it('proceeds with warning when client lacks elicitation (non-strict)', async () => {
    const { mcp, fake } = makeServer({ elicitationSupported: false });
    const p = new ConfirmPolicy({ mode: { type: 'always' }, strict: false });
    expect(await p.ask(mcp, askArgs)).toEqual({ ok: true });
    expect(await p.ask(mcp, askArgs)).toEqual({ ok: true });
    expect(fake.elicitInput).not.toHaveBeenCalled();
  });

  it('rejects when client lacks elicitation in strict mode', async () => {
    const { mcp, fake } = makeServer({ elicitationSupported: false });
    const p = new ConfirmPolicy({ mode: { type: 'always' }, strict: true });
    const r = await p.ask(mcp, askArgs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/X402_CONFIRM_STRICT=1/);
    expect(fake.elicitInput).not.toHaveBeenCalled();
  });

  it('renders Bazaar metadata in the prompt when extensions.bazaar is present', async () => {
    const { mcp, fake } = makeServer({ elicitationSupported: true });
    const p = new ConfirmPolicy({ mode: { type: 'always' }, strict: false });
    await p.ask(mcp, {
      ...askArgs,
      extensions: {
        bazaar: {
          name: 'EP News',
          category: 'news',
          listingId: 'bz_abc123',
        },
      },
    });
    const message = fake.elicitInput.mock.calls[0]![0].message as string;
    expect(message).toMatch(/Bazaar:/);
    expect(message).toMatch(/EP News/);
    expect(message).toMatch(/category: news/);
    expect(message).toMatch(/listing: bz_abc123/);
  });

  it('falls back to a generic flat key list for unknown extension namespaces', async () => {
    const { mcp, fake } = makeServer({ elicitationSupported: true });
    const p = new ConfirmPolicy({ mode: { type: 'always' }, strict: false });
    await p.ask(mcp, {
      ...askArgs,
      extensions: { custom_field: 'hello', custom_count: 42 },
    });
    const message = fake.elicitInput.mock.calls[0]![0].message as string;
    expect(message).toMatch(/Meta:/);
    expect(message).toMatch(/custom_field=hello/);
    expect(message).toMatch(/custom_count=42/);
  });

  it('does not render an extension line when extensions is undefined or empty', async () => {
    const { mcp, fake } = makeServer({ elicitationSupported: true });
    const p = new ConfirmPolicy({ mode: { type: 'always' }, strict: false });

    await p.ask(mcp, askArgs);
    const m1 = fake.elicitInput.mock.calls[0]![0].message as string;
    expect(m1).not.toMatch(/Bazaar:|Meta:/);

    await p.ask(mcp, { ...askArgs, extensions: {} });
    const m2 = fake.elicitInput.mock.calls[1]![0].message as string;
    expect(m2).not.toMatch(/Bazaar:|Meta:/);
  });

  it('ignores nested-object values in the generic fallback (anti-spam)', async () => {
    const { mcp, fake } = makeServer({ elicitationSupported: true });
    const p = new ConfirmPolicy({ mode: { type: 'always' }, strict: false });
    await p.ask(mcp, {
      ...askArgs,
      extensions: {
        nested: { huge: 'x'.repeat(10_000) },
        ok_field: 'visible',
      },
    });
    const message = fake.elicitInput.mock.calls[0]![0].message as string;
    expect(message).toMatch(/ok_field=visible/);
    expect(message).not.toMatch(/x{50}/);
  });
});
