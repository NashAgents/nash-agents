import { readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const category = name => {
  if (/^(mcp-bilibili-e2e|cluster-real-llm-.*|windows-sandbox-agentloop-e2e|live-e2e|real-model-orchestration-e2e)\.test\.ts$/.test(name)) return 'live';
  if (/^(browser.*|web-workbench-browser)\.test\.ts$/.test(name)) return 'browser';
  if (/^(cluster-postgres.*|runtime-observability-storage)\.test\.ts$/.test(name)) return 'database';
  if (/^(linux-.*|windows-sandbox.*|sandbox|sandbox-runtime-environment|posix-capability-verification|cluster-sandbox-policy-and-cross-platform|cli-e2e)\.test\.ts$/.test(name)) return 'platform';
  return 'unit';
};
const group = process.argv[2] ?? 'unit';
if (!['all','unit','platform','database','browser','live'].includes(group)) throw new Error('Unknown test group');
if (group === 'database' && !process.env.NASH_TEST_DATABASE_URL) { console.error('Set an isolated NASH_TEST_DATABASE_URL before running database tests.'); process.exit(78); }
const browserCandidates = [
  process.env.NASH_CHROME_PATH,
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
];
if (group === 'browser' && !browserCandidates.some(p => p && existsSync(p))) { console.error('No Chrome executable found.'); process.exit(78); }
const files = readdirSync(new URL('../test/', import.meta.url)).filter(name => name.endsWith('.test.ts') && (group === 'all' || category(name) === group)).sort().map(name => `test/${name}`);
console.log(`Running ${group}: ${files.length} files (other environment groups excluded)`);
const env = { ...process.env };
const testHome = mkdtempSync(path.join(os.tmpdir(), 'nash-test-home-'));
env.NASH_HOME = testHome;
const cleanup = () => rmSync(testHome, { recursive: true, force: true });
process.once('exit', cleanup);
delete env.DISPLAY;
if (group === 'live') { env.NASH_RUN_LIVE_TESTS = '1'; env.NASH_RUN_REAL_LLM_TESTS = '1'; }
else { delete env.NASH_RUN_LIVE_TESTS; delete env.NASH_RUN_REAL_LLM_TESTS; delete env.NASH_TEST_DATABASE_URL; if (group === 'database') env.NASH_TEST_DATABASE_URL = process.env.NASH_TEST_DATABASE_URL; }
const child = spawn(process.execPath, ['--import','tsx','--test','--test-concurrency=1','--test-timeout=120000', ...files], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); cleanup(); process.exitCode = 1; });
child.on('exit', (code, signal) => { cleanup(); process.exitCode = code ?? (signal ? 1 : 0); });
