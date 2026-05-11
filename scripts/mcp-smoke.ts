/**
 * MCP smoke test — spawns our server, exercises the three tools, and asserts
 * that the wiring (tool registration, schema validation, allowlist enforcement,
 * wallet_status data shape) works end-to-end.
 *
 * Does NOT make real x402 payments — that's covered by `pay-newsep` and the
 * M2c live test from a Claude Code session. This script is safe to run in CI.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXPECTED_TOOLS = [
  'pay.discover',
  'pay.fetch',
  'pay.wallet_status',
] as const;

type ToolContent = { type: string; text?: string };

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return (content as ToolContent[])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'tsx',
    args: ['src/index.ts'],
    stderr: 'inherit',
  });

  const client = new Client(
    { name: 'thebuyside-smoke', version: '0.0.1' },
    { capabilities: {} },
  );

  await client.connect(transport);

  // 1) Tools list — all three present
  const { tools } = await client.listTools();
  console.log(`\n[smoke] server returned ${tools.length} tools:`);
  for (const t of tools) {
    console.log(`  - ${t.name}  —  ${t.title ?? '(no title)'}`);
  }
  const names = new Set(tools.map((t) => t.name));
  const missing = EXPECTED_TOOLS.filter((e) => !names.has(e));
  if (missing.length > 0) {
    console.error(`\n[smoke] ✗ missing tools: ${missing.join(', ')}`);
    await client.close();
    process.exit(1);
  }

  // 2) wallet_status — verify shape
  const ws = await client.callTool({
    name: 'pay.wallet_status',
    arguments: {},
  });
  const wsBody = JSON.parse(textOf(ws.content));
  console.log('\n[smoke] pay.wallet_status returned:');
  console.log(JSON.stringify(wsBody, null, 2).replace(/^/gm, '  '));
  const requiredKeys = [
    'address',
    'spent_today_usdc',
    'daily_limit_usdc',
    'remaining_usdc',
    'per_call_limit_usdc',
    'allowlist',
  ];
  for (const k of requiredKeys) {
    if (!(k in wsBody)) {
      console.error(`\n[smoke] ✗ wallet_status missing key: ${k}`);
      await client.close();
      process.exit(1);
    }
  }

  // 3) pay.fetch against an unallowed host — verify allowlist rejection
  console.log('\n[smoke] testing allowlist enforcement…');
  const denied = await client.callTool({
    name: 'pay.fetch',
    arguments: { url: 'https://example.com/anything' },
  });
  const deniedBody = JSON.parse(textOf(denied.content));
  if (!deniedBody.error || !/not in the allowlist/i.test(deniedBody.error)) {
    console.error(
      '\n[smoke] ✗ expected allowlist rejection, got:',
      JSON.stringify(deniedBody, null, 2),
    );
    await client.close();
    process.exit(1);
  }
  console.log(`  ✓ unallowed host rejected: ${deniedBody.error.slice(0, 80)}…`);

  await client.close();
  console.log('\n[smoke] ✓ all checks passed');
}

main().catch((err: unknown) => {
  console.error('\n[smoke] failed:', err);
  process.exit(1);
});
