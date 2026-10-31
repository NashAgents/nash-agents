import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const forbiddenNames = new Set(["AGENTS.md", "CLAUDE.md", "CODEX.md", ".env", "settings.json", "credentials.json", "id_rsa", "id_ed25519"]);
const ignoredContent = /(?:^|\/)(?:node_modules|dist|\.git)\//;
const forbiddenDirectories = /(?:^|\/)(?:\.claude|\.codex|\.codegraph|\.vscode|\.nash|node_modules)(?:\/|$)|^docs\/reports\/|^scripts\/runtime-truth\//;
const networkFixtureFiles = new Set(["test/cluster-phase3-router.test.ts", "test/mcp-natural-language-and-audit.test.ts"]);
// Reviewed regression inputs, bound to an exact test path and value digest.
// This list is deliberately static: a new literal requires review rather than automatic enrollment.
const syntheticCredentialApprovals = new Set([
  "test/cluster-phase4-taskgraph.test.ts:literal-credential:24626cb1dc15eb7572c6a321d5663592c60f7926c9386e8a464e75178e4e9215",
  "test/cluster-phase5-web-api.test.ts:literal-credential:6786324d71483a9ddfa6e2125490379f9f0ebac3d84e880d4a7bca4d4cbc8ac0",
  "test/cluster-runtime-truth.test.ts:literal-credential:4218638739c44bf8204ae61b4a63975c645657439fdb979325b4c26b090467db",
  "test/cluster-service-preflight-and-resilience.test.ts:credential-in-url:795d8df7156c7387d772fc57cb9481c59efa9157740eaad8602821d2dede93a8",
  "test/cluster-service-preflight-and-resilience.test.ts:credential-in-url:afdbe82accb8fa57b6fda378ad912adff042c63d0cbc7c991abe749089b2a783",
  "test/cluster-service-preflight-and-resilience.test.ts:credential-in-url:ffccf62d0ceef4a09803914c996fb8082af0daead263fbbb268158991523fe09",
  "test/cluster-web-security-regressions.test.ts:literal-credential:18b7abeab1127eeb2e723768928e486b89c0cb052fca6f5dd1b74c38abfd3f30",
  "test/linux-sandbox-integration.test.ts:literal-credential:f875c2213d7ad711a101bd4f277cc691fe8a90ffc1e39b8a9592fc1ecafa6f70",
  "test/linux-sandbox-security-e2e.test.ts:literal-credential:81cd93668699a6b6bb233a81678aa70811dcd16aa7b316eb704bba4a1cde6bfa",
  "test/mcp-unit.test.ts:literal-credential:3ac09f631d5f5a5bb72d3e4a71abfc9203e5c96f12c100659cd9522914a76099",
  "test/mcp-unit.test.ts:literal-credential:78f959ef63dbc0c3ab1bbef066fbd16d5ff1c983fa4a9039a6d7bf2aa45d298a",
  "test/memory-unit.test.ts:literal-credential:94aefb8be78b2b7c344d11d1ba8a79ef087eceb19150881f69460b8772753263",
  "test/nash-config.test.ts:literal-credential:586c33c5fafdd4caccf600c6df3ccf992bac5d12cac8665c37fd408e0e89f872",
  "test/observability.test.ts:literal-credential:59a682f79f58d40057c6cb2304f2703b141e4f3ecba3a7ecb087123bbfc4192b",
  "test/project-audit-fixes.test.ts:literal-credential:bd54f38f1e6b06a5800371ce8b7d50ed08b69910142e8def3e2dbde46e430ac3",
  "test/sandbox.test.ts:literal-credential:0a98a6e60b1b97f918d2a73ba090fecccae3660a84f8095df713417f4110ef85",
  "test/security-audit-persistence.test.ts:literal-credential:ac36e8d26bd00b068bf0c3558eac748402d14f469f908eb7ff92b0ead9700dda",
  "test/security-audit-persistence.test.ts:literal-credential:c84f50304a6ca0c8d6cae650c7a3965c18fd411d221568a1953536e51b27c353",
  "test/windows-sandbox.test.ts:literal-credential:cfee437b09715a340dd07accc20e09efada97c0d6608e1baa2cbf42f0a14a60e",
  "test/worker-cold-start.test.ts:credential-in-url:ec25b8fa54a9d7a878a86e6f38233af24d5d27d184b396136d6d7f0251d33c19"
]);
const isApprovedSynthetic = (file, category, value) => syntheticCredentialApprovals.has(`${file}:${category}:${crypto.createHash("sha256").update(value).digest("hex")}`);
// Node ids are `<hostname>-<random hex>`, not hardware fingerprints. The public release history
// contains no reviewed exceptions: any persistent machine id literal is reported.

const syntheticTokenPrefix = /^(?:sk-|gh[pousr]_|github_pat_)(?:test|fake|mock|dummy|example|synthetic|fixture|redact)/i;
const allowedSecretFixtures = /test|fake|mock|dummy|example|synthetic|fixture|redact|not-a-real|placeholder/i;

export function auditText(relativePath, text, options = {}) {
  const findings = [];
  const testFile = /^test\//.test(relativePath);
  const report = (line, category) => findings.push({ path: relativePath, line, category });
  for (const [offset, line] of text.split(/\r?\n/).entries()) {
    const lineNumber = offset + 1;
    const tokens = line.match(/(?<![\w-])(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})/g) ?? [];
    for (const token of tokens) if (!testFile || !syntheticTokenPrefix.test(token)) report(lineNumber, "credential-token");
    const assignments = [...line.matchAll(/(?:api[_-]?key|password|secret|(?:auth|node|access|refresh)[_-]?token)\s*[=:]\s*["']([^"'\r\n]{8,})["']/gi)];
    for (const match of assignments) {
      const value = match[1];
      if (!value.includes("${") && !allowedSecretFixtures.test(value) && !isApprovedSynthetic(relativePath, "literal-credential", value) && !/[\s(){}]/.test(value)) report(lineNumber, "literal-credential");
    }
    for (const url of line.match(/\b(?:postgres(?:ql)?|https?|redis|mongodb(?:\+srv)?)\:\/\/[^\s/]+:[^\s/@]+@/g) ?? []) {
      if (!/\$(?:\{)?[a-z_]/i.test(url) && !allowedSecretFixtures.test(url.slice(url.indexOf("://") + 3, -1).split(":").slice(1).join(":")) && !url.includes("***") && !isApprovedSynthetic(relativePath, "credential-in-url", url)) report(lineNumber, "credential-in-url");
    }
    if (/(?:\/Users\/|\/home\/)(?!test(?:\/|\b)|normal\.txt\b|example(?:\/|\b)|username(?:\/|\b)|\$\{|<)[^\s/"'`]+/.test(line) || /[a-z]:\\{1,2}Users\\{1,2}(?!test\b|normal\.txt\b|example\b|username\b|\$\{|<)[^\s\\"'`]+/i.test(line)) report(lineNumber, "personal-directory");
    for (const _nodeId of line.match(/\bnode-[a-z0-9_-]{3,}-[a-f0-9]{8}\b/gi) ?? []) {
      if (relativePath.endsWith("product-audit.js")) break;
      report(lineNumber, "persistent-machine-id");
    }
    const addresses = line.match(/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g) ?? [];
    if (addresses.length && !networkFixtureFiles.has(relativePath) && relativePath !== "src/mcp/mcp-security.ts" && !/10\.0\.0\.0\/8|172\.16\.0\.0\/12|192\.168\.0\.0\/16/.test(line)) report(lineNumber, "private-network-address");
    if (options.scanEndpoints !== false && !testFile && !relativePath.endsWith("package-lock.json") && !relativePath.endsWith("THIRD_PARTY_NOTICES.md")) {
      for (const match of line.matchAll(/https?:\/\/([a-z0-9.-]+)(?=[:/\s"'`]|$)/gi)) {
        const host = match[1].toLowerCase();
        if (host === "...") continue;
        if (!/^(?:http|https|localhost|127\.0\.0\.1|(?:[a-z0-9-]+\.)*example\.(?:com|org|net)|(?:api\.)?deepseek\.com|api\.openai\.com|api\.anthropic\.com|dashscope\.aliyuncs\.com|generativelanguage\.googleapis\.com|openrouter\.ai|api\.moonshot\.cn|api\.zhipuai\.cn|api\.siliconflow\.cn|api\.minimax\.chat|api\.minimax\.io|api\.mistral\.ai|api\.groq\.com|api\.x\.ai|api\.together\.xyz|api\.perplexity\.ai|nodejs\.org|raw\.githubusercontent\.com|(?:www\.)?apache\.org|www\.npmjs\.com|opensource\.org|github\.com|registry\.npmjs\.org|www\.w3\.org|api\.deepseek\.com)$/.test(host)) report(lineNumber, "nonportable-service-endpoint");
      }
    }
  }
  for (const match of text.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g)) {
    let valid = true;
    try { crypto.createPrivateKey(match[0]); } catch { valid = false; }
    if (valid || !testFile || (!allowedSecretFixtures.test(match[0]) && !match[0].includes("..."))) report(text.slice(0, match.index).split("\n").length, "private-key");
  }
  for (const marker of text.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g)) {
    const tail = text.slice(marker.index);
    if (!/-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(tail)) report(text.slice(0, marker.index).split("\n").length, "incomplete-private-key");
  }
  return findings;
}

export function auditPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (forbiddenDirectories.test(normalized) || forbiddenNames.has(path.posix.basename(normalized)) || (/^\.env(?:$|\.)/.test(path.posix.basename(normalized)) && path.posix.basename(normalized) !== ".env.example") || /\.(?:pem|key|p12|pfx|log|dump|sqlite|db)$/i.test(normalized)) return [{ path: normalized, line: 1, category: "private-or-generated-path" }];
  if (/^native\/bin\//.test(normalized) || /\.(?:exe|dll|dylib|so|tgz|zip)$/i.test(normalized)) return [{ path: normalized, line: 1, category: "prebuilt-binary" }];
  return [];
}

export function auditRepository(root, { staged = false, history = false } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const files = staged ? git("ls-files", "--cached", "-z") : git("ls-files", "--cached", "--others", "--exclude-standard", "-z");
  const findings = [];
  for (const file of new Set(files.split("\0").filter(Boolean))) {
    findings.push(...auditPath(file));
    let bytes;
    if (staged) {
      const mode = git("ls-files", "--stage", "--", file).slice(0, 6);
      if (mode === "120000" || mode === "160000") { findings.push({ path: file, line: 1, category: "symlink-or-submodule" }); continue; }
      bytes = execFileSync("git", ["show", `:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    } else {
      const fullPath = path.join(root, file);
      if (!fs.existsSync(fullPath)) continue;
      if (fs.lstatSync(fullPath).isSymbolicLink()) { findings.push({ path: file, line: 1, category: "symlink" }); continue; }
      bytes = fs.readFileSync(fullPath);
    }
    if (ignoredContent.test(file)) continue;
    if (bytes.length > 2 * 1024 * 1024) findings.push({ path: file, line: 1, category: "oversized-source-file" });
    if (!bytes.includes(0)) findings.push(...auditText(file, bytes.toString("utf8")));
    else findings.push({ path: file, line: 1, category: "binary-in-source-tree" });
  }
  if (history) {
    const objects = git("rev-list", "--objects", "--all").trim().split("\n").filter(Boolean);
    for (const object of objects) {
      const split = object.indexOf(" ");
      if (split < 0) continue;
      const oid = object.slice(0, split), file = object.slice(split + 1);
      if (git("cat-file", "-t", oid).trim() !== "blob") continue;
      findings.push(...auditPath(file));
      if (ignoredContent.test(file)) continue;
      const bytes = execFileSync("git", ["cat-file", "blob", oid], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      if (!bytes.includes(0)) findings.push(...auditText(file, bytes.toString("utf8")));
    }
  }
  return [...new Map(findings.map(item => [JSON.stringify(item), item])).values()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const findings = auditRepository(process.cwd(), { staged: process.argv.includes("--staged"), history: process.argv.includes("--history") });
    for (const finding of findings) console.log(JSON.stringify(finding));
    console.log(JSON.stringify({ audit: "product", status: findings.length ? "FAILED" : "PASSED", findings: findings.length }));
    process.exitCode = findings.length ? 1 : 0;
  } catch { console.error(JSON.stringify({ path: ".", line: 1, category: "audit-execution-failed" })); process.exitCode = 1; }
}
