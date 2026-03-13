#!/usr/bin/env node
/**
 * Kill the process listening on CREDENTIAL_PROXY_PORT (from .env or default 3001).
 * Used by `npm stop` so `npm restart` actually frees the port before starting again.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const envPath = path.join(process.cwd(), '.env');
let port = '3001';
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  const m = content.match(/CREDENTIAL_PROXY_PORT\s*=\s*(\d+)/);
  if (m) port = m[1].trim();
}

try {
  const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim();
  if (pids) {
    execSync(`kill ${pids.split(/\s+/).join(' ')}`, { stdio: 'inherit' });
    console.log(`Killed process(es) on port ${port}: ${pids}`);
  }
} catch (e) {
  // lsof exits 1 when no process listens on the port
  if (e.status === 1) process.exit(0);
  throw e;
}
