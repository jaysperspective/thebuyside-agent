#!/usr/bin/env node
/**
 * thebuyside-x402-agent — MCP gateway for x402-priced APIs.
 * Entry point. See src/server.ts for the actual server.
 */

import { logger } from './log.js';
import { startServer } from './server.js';

startServer().catch((err: unknown) => {
  logger.error('fatal startup error', { err: String(err) });
  process.exit(1);
});
