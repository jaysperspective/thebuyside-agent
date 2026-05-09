/**
 * MCP smoke test — spawns our server as a subprocess, talks to it over stdio
 * using the MCP client SDK, and verifies the three expected tools are listed
 * and that wallet_status responds.
 *
 * Run: pnpm smoke
 *
 * This catches the most common MCP server bugs:
 *   - stray stdout writes (would corrupt the JSON-RPC stream)
 *   - tool registration errors
 *   - schema-level zod validation issues
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXPECTED_TOOLS = [
  'x402.discover',
  'x402.fetch',
  'x402.wallet_status',
] as const;

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'tsx',
    args: ['src/index.ts'],
    stderr: 'inherit', // surface server logs in smoke test output
  });

  const client = new Client(
    { name: 'thebuyside-smoke', version: '0.0.1' },
    { capabilities: {} },
  );

  await client.connect(transport);

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

  // Round-trip a real tool call
  const ws = await client.callTool({
    name: 'x402.wallet_status',
    arguments: {},
  });
  console.log('\n[smoke] x402.wallet_status response:');
  for (const c of ws.content as Array<{ type: string; text?: string }>) {
    if (c.type === 'text' && c.text) {
      console.log(c.text.replace(/^/gm, '  '));
    }
  }

  await client.close();
  console.log('\n[smoke] ✓ all 3 expected tools registered and reachable');
}

main().catch((err: unknown) => {
  console.error('\n[smoke] failed:', err);
  process.exit(1);
});
