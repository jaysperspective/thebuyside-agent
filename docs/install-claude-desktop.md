# Install in Claude Desktop

For Claude Code (CLI) install, see the [README quickstart](../README.md#claude-code-cli).

## 1. Find the config file

macOS:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Windows:

```
%APPDATA%\Claude\claude_desktop_config.json
```

Linux:

```
~/.config/Claude/claude_desktop_config.json
```

If the file doesn't exist, create it.

## 2. Add the gateway

Open the file and add (or merge into the existing `mcpServers` block):

```json
{
  "mcpServers": {
    "x402-pay": {
      "command": "/ABSOLUTE/PATH/TO/thebuyside-agent/node_modules/.bin/tsx",
      "args": ["/ABSOLUTE/PATH/TO/thebuyside-agent/src/index.ts"]
    }
  }
}
```

Replace `/ABSOLUTE/PATH/TO/` with the full path on your machine. From the project directory, run `pwd` to get it.

> **Why absolute paths?** Claude Desktop spawns the MCP server as a subprocess and may not run it from your project directory. Absolute paths remove the ambiguity.

## 3. Pass through environment variables (optional)

If you want a wallet other than what's in your `.env`, or want to override spend caps per-install, add an `env` block:

```json
{
  "mcpServers": {
    "x402-pay": {
      "command": "/ABSOLUTE/PATH/.../tsx",
      "args": ["/ABSOLUTE/PATH/.../src/index.ts"],
      "env": {
        "X402_PAYER_PRIVATE_KEY": "0x...",
        "X402_DAILY_LIMIT": "0.50"
      }
    }
  }
}
```

> Anything in the `env` block overrides the `.env` file.

## 4. Restart Claude Desktop

Fully quit (cmd+Q on macOS) and relaunch. The three tools — `x402.discover`, `x402.fetch`, `x402.wallet_status` — should appear in the tool picker.

## 5. Verify

Ask Claude:

> *"Use the x402.wallet_status tool."*

You should get JSON back with your wallet address and spend info. If you get an error like "tool not found," check the Claude Desktop MCP logs panel (in the developer menu) for startup errors from `thebuyside-agent`.

## Troubleshooting

**Server fails to start:**
- Run `pnpm smoke` from the project directory. If that works, the gateway is fine and the issue is in the Claude Desktop config (most often a path typo).
- Check that `tsx` exists at the path you wrote: `ls /ABSOLUTE/PATH/TO/thebuyside-agent/node_modules/.bin/tsx`.

**Tools appear but `x402.fetch` returns "no wallet configured":**
- The `.env` file isn't being read. The gateway resolves `.env` relative to the source path, so it should pick up `.env` in the project directory regardless of Claude Desktop's cwd. If it doesn't, set `X402_PAYER_PRIVATE_KEY` in the config's `env` block instead.

**Tools work but every call returns "host ... is not in the allowlist":**
- The host you're trying to fetch isn't in `src/registry/seed.json`. Either add it to the seed list (see [docs/adding-an-api.md](adding-an-api.md)) or set `X402_ALLOWLIST=that-host.com` in the `env` block.
