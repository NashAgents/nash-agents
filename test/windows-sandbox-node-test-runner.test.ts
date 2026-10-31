import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SandboxService } from '../src/sandbox/sandbox-service.js';
import { createDefaultSandboxPolicy } from '../src/sandbox/policy.js';

test('REAL_SANDBOX: Windows runs Node test assertions within AppContainer without test-runner process IPC', { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'nash-test-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'sample.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('real assertion',()=>assert.equal(Number(process.versions.node.split('.')[0]),24));\n");
  const policy = createDefaultSandboxPolicy();
  const service = new SandboxService({ policy, cwd: root });
  assert.equal(service.getBackend().name, 'windows-sandbox');
  const result = await service.runProcess({ command: process.execPath, args: ['--test-isolation=none', '--test', 'sample.test.mjs'], cwd: root, policy, timeout: 10000 });
  assert.equal(result.exitCode, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /pass 1/);
  assert.match(result.stdout, /fail 0/);
});
