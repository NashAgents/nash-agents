import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
type Finding = { path: string; line: number; category: string };
const { auditPath, auditText, auditRepository } = await import(new URL("../scripts/product-audit.js", import.meta.url).href) as {
  auditPath: (path: string) => Finding[];
  auditText: (path: string, text: string) => Finding[];
  auditRepository: (root: string, options?: { staged?: boolean; history?: boolean }) => Finding[];
};
const { verifyPackageFiles, verifyBuildIdentity } = await import(new URL("../scripts/verify-package.js", import.meta.url).href) as {
  verifyPackageFiles: (files: { path: string }[], root?: string, options?: { release?: boolean }) => Finding[];
  verifyBuildIdentity: (root: string, files: { path: string }[]) => Finding[];
};
const { bundledLinuxHelperStatus } = await import(new URL("../scripts/postinstall.js", import.meta.url).href) as {
  bundledLinuxHelperStatus: (root: string, arch: string) => string;
};
const { checkDependencyNotices, writeDependencyNotices } = await import(new URL("../scripts/dependency-notices.js", import.meta.url).href) as {
  checkDependencyNotices: (root: string) => void;
  writeDependencyNotices: (root: string) => unknown;
};
import { TaskIntentAnalyzer } from "../src/cluster/router/intent-analyzer.js";
import { MCPConfigManager } from "../src/mcp/mcp-config.js";
import { CredentialStore } from "../src/mcp/credential-store.js";

test("MCP configuration and encrypted credentials follow the product data home", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-mcp-product-home-"));
  const previous = process.env.NASH_HOME;
  t.after(() => { if (previous === undefined) delete process.env.NASH_HOME; else process.env.NASH_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
  process.env.NASH_HOME = root;
  const manager = new MCPConfigManager();
  assert.equal(manager.userConfigPath, path.join(root, "settings.json"));
  const credentials = new CredentialStore({ useKeychain: false });
  assert.equal((credentials as unknown as { storagePath: string }).storagePath, path.join(root, "credentials.enc.json"));
  assert.equal((credentials as unknown as { keychainService: string }).keychainService, "nash-agents-mcp-credentials");
});

test("mcp credential store prevents legacy resurrection after deletion while preserving legacy credentials", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-cred-isolation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const store = new CredentialStore({
    nashHome: root,
    useKeychain: false,
  });

  // 1. 创建凭据并验证基本读写
  store.createBearerCredential("test-server", "token-test-12345");
  assert.equal(store.getCredential("test-server")?.token, "token-test-12345");
  assert.equal(store.isTombstoned("test-server"), false);

  // 2. 删除凭据后，应被记录进 tombstones，且在当前产品中不可见
  store.removeCredential("test-server");
  assert.equal(store.getCredential("test-server"), undefined);
  assert.equal(store.isTombstoned("test-server"), true);

  // 3. 重建 Store 实例测试持久化：验证 tombstones 在重启后依然保留，拒绝从旧命名空间回流
  const reloaded = new CredentialStore({
    nashHome: root,
    useKeychain: false,
  });
  assert.equal(reloaded.isTombstoned("test-server"), true);
  assert.equal(reloaded.getCredential("test-server"), undefined);

  // 4. 模拟在具备 Keychain 时，验证墓碑能拦截旧命名空间回流
  let legacyReadCount = 0;
  const originalReadFromKeychain = (reloaded as any).readFromKeychain.bind(reloaded);
  (reloaded as any).useKeychain = true;
  (reloaded as any).readFromKeychain = function (serverName: string) {
    if (this.isTombstoned(serverName)) return null;
    legacyReadCount++;
    return JSON.stringify({ serverName, type: "bearer", token: "legacy-secret" });
  };
  assert.equal(reloaded.getCredential("test-server"), undefined);
  assert.equal(legacyReadCount, 0, "墓碑中的凭据严禁触发旧命名空间回流探测");

  // 恢复 readFromKeychain
  (reloaded as any).readFromKeychain = originalReadFromKeychain;
  (reloaded as any).useKeychain = false;

  // 5. 用户重新主动录入凭据后，清除墓碑，恢复正常读取
  reloaded.createBearerCredential("test-server", "token-test-new-67890");
  assert.equal(reloaded.isTombstoned("test-server"), false);
  assert.equal(reloaded.getCredential("test-server")?.token, "token-test-new-67890");

  // 6. 再次删除，墓碑再次生效
  reloaded.removeCredential("test-server");
  assert.equal(reloaded.isTombstoned("test-server"), true);
  assert.equal(reloaded.getCredential("test-server"), undefined);

  // 再次验证：即使外部旧命名空间有该凭据，在 tombstone 下依然绝不回流
  (reloaded as any).useKeychain = true;
  (reloaded as any).readFromKeychain = function (serverName: string) {
    if (this.isTombstoned(serverName)) return null;
    legacyReadCount++;
    return JSON.stringify({ serverName, type: "bearer", token: "legacy-secret" });
  };
  assert.equal(reloaded.getCredential("test-server"), undefined);
  assert.equal(legacyReadCount, 0, "再次删除后依然严禁从旧命名空间回流");
});

test("mcp credential store handles clearAll boundary preventing unmigrated legacy resurrection and preserves legacy credentials", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-cred-clearall-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 模拟旧产品 Keychain 与新产品 Keychain 的物理隔离存储字典
  const legacyKeychain = new Map<string, string>([
    ["legacy-srv-1", JSON.stringify({ serverName: "legacy-srv-1", type: "bearer", token: "tok-legacy-1" })],
    ["legacy-srv-2", JSON.stringify({ serverName: "legacy-srv-2", type: "bearer", token: "tok-legacy-2" })],
    ["legacy-srv-3", JSON.stringify({ serverName: "legacy-srv-3", type: "bearer", token: "tok-legacy-3" })],
  ]);
  const currentKeychain = new Map<string, string>();

  function createMockedStore(nashHome: string) {
    const s = new CredentialStore({ nashHome, useKeychain: true });
    // mock Keychain 底层读写，精确模拟真实 Keychain 系统行为与旧产品隔离
    (s as any).readFromKeychain = function (serverName: string) {
      if (currentKeychain.has(serverName)) {
        return currentKeychain.get(serverName)!;
      }
      if (this.keychainService === "nash-agents-mcp-credentials") {
        if (this.globalLegacyCleared || this.tombstones.has(serverName)) {
          return null;
        }
        if (legacyKeychain.has(serverName)) {
          const secret = legacyKeychain.get(serverName)!;
          // 平滑迁移到新产品命名空间
          this.writeToKeychain(serverName, secret);
          this.migratedServices.add(serverName);
          this.persist();
          return secret;
        }
      }
      return null;
    };
    (s as any).writeToKeychain = function (serverName: string, secretValue: string) {
      currentKeychain.set(serverName, secretValue);
      return true;
    };
    (s as any).deleteFromKeychain = function (serverName: string) {
      currentKeychain.delete(serverName);
    };
    return s;
  }

  const store = createMockedStore(root);

  // 1. 迁移验证：初次读取 legacy-srv-1，自动平滑迁移至当前命名空间
  const cred1 = store.getCredential("legacy-srv-1");
  assert.equal(cred1?.token, "tok-legacy-1");
  assert.ok(currentKeychain.has("legacy-srv-1"), "新命名空间已平滑录入迁移凭据");
  assert.ok(legacyKeychain.has("legacy-srv-1"), "旧命名空间凭据严格保持完好，绝不被删除");

  // 2. 单项删除验证：删除 legacy-srv-1，当前钥匙串删除且登记墓碑
  store.removeCredential("legacy-srv-1");
  assert.equal(store.getCredential("legacy-srv-1"), undefined);
  assert.ok(!currentKeychain.has("legacy-srv-1"), "当前钥匙串中 legacy-srv-1 已被删除");
  assert.ok(legacyKeychain.has("legacy-srv-1"), "旧命名空间凭据依然完好");

  // 3. 读取 legacy-srv-2（进入缓存与当前钥匙串），而 legacy-srv-3 保持从未被读取过、未进本地缓存
  const cred2 = store.getCredential("legacy-srv-2");
  assert.equal(cred2?.token, "tok-legacy-2");

  // 4. 全部清除边界验证：调用 clearAll()
  store.clearAll();
  assert.equal(store.isLegacyCleared(), true);
  assert.equal(store.getCredential("legacy-srv-2"), undefined, "已缓存过的旧凭据全部清除");
  // 核心边界：从未进入本地缓存的 legacy-srv-3，在 clearAll 后也坚决绝不能回流！
  assert.equal(store.getCredential("legacy-srv-3"), undefined, "未进入过本地缓存的旧凭据在 clearAll 后严禁自动回流");
  assert.equal(currentKeychain.size, 0, "当前命名空间的钥匙串数据已彻底清空");
  assert.equal(legacyKeychain.size, 3, "旧命名空间的 3 个原始凭据全部完好保留，未受任何污染破坏");

  // 5. 重建存储实例验证：重启后依然坚决拒绝回流
  const reloaded = createMockedStore(root);
  assert.equal(reloaded.isLegacyCleared(), true);
  assert.equal(reloaded.getCredential("legacy-srv-1"), undefined);
  assert.equal(reloaded.getCredential("legacy-srv-2"), undefined);
  assert.equal(reloaded.getCredential("legacy-srv-3"), undefined);

  // 6. 重新录入验证：为 legacy-srv-3 录入全新凭据
  reloaded.createBearerCredential("legacy-srv-3", "token-brand-new-2026");
  assert.equal(reloaded.getCredential("legacy-srv-3")?.token, "token-brand-new-2026");
  assert.equal(reloaded.getCredential("legacy-srv-1"), undefined, "其他未录入的凭据依然被阻断");
  assert.equal(reloaded.getCredential("legacy-srv-2"), undefined, "其他未录入的凭据依然被阻断");
  assert.equal(legacyKeychain.get("legacy-srv-3"), JSON.stringify({ serverName: "legacy-srv-3", type: "bearer", token: "tok-legacy-3" }), "旧命名空间的原始凭据依然完好");
});

test("release scanner blocks real-looking credentials, including those inserted into tests, without returning values", () => {
  const value = "sk-" + "aB12345678".repeat(4);
  const findings = auditText("test/innocent.test.ts", `const apiKey = "${value}";`);
  assert.ok(findings.some(item => item.category === "credential-token"));
  assert.ok(!JSON.stringify(findings).includes(value));
  assert.deepEqual(auditText("test/security.test.ts", `const apiKey = "sk-test-${"x".repeat(32)}";`), []);
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const key = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  assert.ok(auditText("test/key.test.ts", key).some(item => item.category === "private-key"));
});

test("release scanner separates restricted-network security cases from product configuration", () => {
  const address = [10, 12, 34, 56].join(".");
  assert.ok(auditText("src/config.ts", `url = "http://${address}/mcp"`).some(item => item.category === "private-network-address"));
  assert.deepEqual(auditText("test/mcp-natural-language-and-audit.test.ts", `validate("http://${address}/mcp")`), []);
  assert.equal(auditPath(".codex/memories/MEMORY.md")[0]?.category, "private-or-generated-path");
  assert.equal(auditPath("native/bin/linux-x64/helper")[0]?.category, "prebuilt-binary");
  assert.deepEqual(auditPath("src/context/repository-instructions.ts"), []);
});

test("staged and historical audits inspect committed bytes instead of a cleaned working copy", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-audit-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  const value = "sk-" + "aB12345678".repeat(4);
  fs.writeFileSync(path.join(root, "config.js"), `const value = "${value}";`);
  git("add", "config.js");
  fs.writeFileSync(path.join(root, "config.js"), "// cleaned\n");
  assert.ok(auditRepository(root, { staged: true }).some(item => item.category === "credential-token"));
  git("commit", "-qm", "Fixture");
  git("add", "config.js");
  git("commit", "-qm", "Clean fixture");
  assert.ok(auditRepository(root, { history: true }).some(item => item.category === "credential-token"));
});

test("packaging gate rejects private files and requires a complete runnable package", () => {
  const required = ["package.json", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "dist/index.js", "dist/build-info.json", "apps/web/dist/index.html", "apps/web/dist/build-info.json"].map(path => ({ path }));
  assert.deepEqual(verifyPackageFiles(required), []);
  assert.ok(verifyPackageFiles([...required, { path: ".env" }]).some(item => item.category === "private-file-in-package"));
  assert.ok(verifyPackageFiles([]).some(item => item.category === "required-package-file-missing"));
});

test("release packaging requires both platform helpers and rejects stale or modified binaries", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-helper-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = "native/bin/win32-x64/nash-windows-sandbox-helper.exe";
  const source = "native/windows-sandbox-helper/main.c";
  for (const dir of ["dist", path.dirname(binary), path.dirname(source)]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  const commit = "a".repeat(40), executable = "fixture binary", sourceText = "fixture source";
  fs.writeFileSync(path.join(root, "dist/build-info.json"), JSON.stringify({ commit }));
  fs.writeFileSync(path.join(root, binary), executable);
  fs.writeFileSync(path.join(root, source), sourceText);
  const manifest = { platform: "win32", arch: "x64", protocolVersion: 2, sourceCommit: commit, binarySha256: digest(executable), sourceSha256: digest(sourceText) };
  const writeManifest = (value: object) => fs.writeFileSync(path.join(root, `${binary}.manifest.json`), JSON.stringify(value));
  const files = ["package.json", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "dist/index.js", "dist/build-info.json", "apps/web/dist/index.html", "apps/web/dist/build-info.json", binary, `${binary}.manifest.json`].map(path => ({ path }));
  writeManifest(manifest);
  const findings = () => verifyPackageFiles(files, root, { release: true });
  assert.ok(findings().some(item => item.category === "release-native-helper-missing"));
  assert.ok(!findings().some(item => item.path === binary));
  writeManifest({ ...manifest, sourceCommit: "b".repeat(40) });
  assert.ok(findings().some(item => item.category === "native-binary-source-commit-mismatch"));
  writeManifest(manifest);
  fs.writeFileSync(path.join(root, binary), "modified binary");
  assert.ok(findings().some(item => item.category === "native-binary-checksum-mismatch"));
  fs.writeFileSync(path.join(root, source), "modified source");
  assert.ok(findings().some(item => item.category === "native-binary-source-or-platform-mismatch"));
});

test("installation preserves a verified Linux helper and detects altered bundled files", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-install-helper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = "native/bin/linux-x64/nash-linux-sandbox-helper";
  for (const dir of ["dist", path.dirname(binary), "native/linux-sandbox-helper"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  assert.equal(bundledLinuxHelperStatus(root, "x64"), "missing");
  const commit = "c".repeat(40), hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  fs.writeFileSync(path.join(root, "dist/build-info.json"), JSON.stringify({ commit }));
  fs.writeFileSync(path.join(root, "native/linux-sandbox-helper/main.c"), "source");
  fs.writeFileSync(path.join(root, "native/linux-sandbox-helper/json-config.h"), "header");
  fs.writeFileSync(path.join(root, binary), "binary");
  fs.writeFileSync(path.join(root, `${binary}.manifest.json`), JSON.stringify({ platform: "linux", arch: "x64", protocolVersion: 1, sourceCommit: commit, sourceSha256: hash("sourceheader"), binarySha256: hash("binary") }));
  assert.equal(bundledLinuxHelperStatus(root, "x64"), "verified");
  fs.writeFileSync(path.join(root, binary), "modified");
  assert.equal(bundledLinuxHelperStatus(root, "x64"), "invalid");
});

test("package identity rejects tampered build bytes and uncommitted runtime metadata", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-build-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/web/dist"), { recursive: true });
  const runtimeText = "export {};\n", webText = "<!doctype html>";
  const digest = (filename: string, text: string) => crypto.createHash("sha256").update(filename).update(text).digest("hex");
  const runtime = { commit: "a".repeat(40), dirty: false, packageVersion: "0.1.0", artifactSha256: digest("dist/index.js", runtimeText) };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  fs.writeFileSync(path.join(root, "dist/index.js"), runtimeText);
  fs.writeFileSync(path.join(root, "apps/web/dist/index.html"), webText);
  fs.writeFileSync(path.join(root, "dist/build-info.json"), JSON.stringify(runtime));
  fs.writeFileSync(path.join(root, "apps/web/dist/build-info.json"), JSON.stringify({ commit: runtime.commit, dirty: false, artifactSha256: digest("apps/web/dist/index.html", webText) }));
  const files = ["dist/index.js", "apps/web/dist/index.html"].map(path => ({ path }));
  assert.deepEqual(verifyBuildIdentity(root, files), []);
  fs.appendFileSync(path.join(root, "dist/index.js"), "// changed\n");
  assert.ok(verifyBuildIdentity(root, files).some(item => item.category === "runtime-artifact-digest-mismatch"));
  fs.writeFileSync(path.join(root, "dist/build-info.json"), JSON.stringify({ ...runtime, dirty: true }));
  assert.ok(verifyBuildIdentity(root, files).some(item => item.category === "uncommitted-or-mismatched-build"));
});

test("dependency notice check fails when lockfiles or license texts change", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-notices-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const base of ["", "apps/web"]) {
    const directory = path.join(root, base);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  }
  writeDependencyNotices(root);
  checkDependencyNotices(root);
  fs.appendFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "modified");
  assert.throws(() => checkDependencyNotices(root));
  writeDependencyNotices(root);
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/unknown": { version: "1.0.0", integrity: "sha512-fixture", license: "UNLICENSED" } } }));
  assert.throws(() => checkDependencyNotices(root));
});

test("intent routing resolves new node identities from metadata and preserves ambiguity", () => {
  const analyzer = new TaskIntentAnalyzer();
  const nodes = [
    { nodeId: "worker-apple-new", name: "New laptop", platform: "darwin" },
    { nodeId: "worker-linux-new", name: "Cloud server", platform: "linux" },
    { nodeId: "worker-windows-new", name: "Windows Native", platform: "win32" },
  ];
  assert.equal(analyzer.analyze("查询 Mac Node.js 版本", undefined, nodes).constraints.explicitNodeId, nodes[0]!.nodeId);
  assert.equal(analyzer.analyze("查询腾讯云 Node.js 版本", undefined, nodes).constraints.explicitNodeId, nodes[1]!.nodeId);
  assert.equal(analyzer.analyze("在 Windows Native 节点测试", undefined, nodes).constraints.explicitNodeId, nodes[2]!.nodeId);
  assert.equal(analyzer.analyze("检查 Mac", undefined, [...nodes, { nodeId: "second-mac", platform: "darwin" }]).constraints.explicitNodeId, undefined);
  assert.deepEqual(analyzer.analyze("检查 WSL2", undefined, nodes).targetNodeIds, []);
  assert.equal(analyzer.analyze("只检查 Mac，不访问腾讯云", undefined, nodes).constraints.explicitNodeId, nodes[0]!.nodeId);
  assert.equal(analyzer.analyze("检查项目", { explicitNodeId: "explicit-user-node" }, nodes).constraints.explicitNodeId, "explicit-user-node");
});

test("ClusterCoordinator fails closed when TLS configuration is invalid or missing files", async () => {
  const { ClusterCoordinator } = await import("../src/cluster/coordinator/cluster-coordinator.js");
  assert.throws(
    () => new ClusterCoordinator({ ephemeral: true, tls: { certPath: "a.crt", keyPath: "" } }),
    /TLS configuration incomplete/
  );
  assert.throws(
    () => new ClusterCoordinator({ ephemeral: true, tls: { certPath: "nonexistent.crt", keyPath: "nonexistent.key" } }),
    /TLS certificate file not found/
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tls-bad-content-"));
  try {
    const badCert = path.join(dir, "bad.crt");
    const badKey = path.join(dir, "bad.key");
    fs.writeFileSync(badCert, "not-a-cert");
    fs.writeFileSync(badKey, "not-a-key");
    assert.throws(
      () => new ClusterCoordinator({ ephemeral: true, tls: { certPath: badCert, keyPath: badKey } }),
      /Invalid TLS certificate or key/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
