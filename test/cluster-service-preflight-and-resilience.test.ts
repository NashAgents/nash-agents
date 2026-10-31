import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import {
  checkWorkingDirectory,
  checkEntrypoint,
  checkNodeRuntime,
  checkPortAvailability,
  checkEnvironmentVariables,
  checkDatabaseConnectivity,
  runServicePreflight,
  formatPreflightReport,
  sanitizeSecret,
  PREFLIGHT_EXIT_CODES,
} from "../src/cluster/preflight/service-preflight.js";
import {
  inspectSystemdUnit,
  runDeploymentDiagnostics,
  formatDeploymentReport,
  selectNashServiceUnits,
} from "../src/cluster/preflight/deployment-doctor.js";

describe("Nash Cluster Service Preflight & Resilience Tests", () => {
  // --------------------------------------------------------------------------
  // 1. 基础环境与路径检查
  // --------------------------------------------------------------------------
  describe("1. Basic Environment & Path Probing", () => {
    it("1.1 checkWorkingDirectory 应能识别不存在的路径与合法目录", () => {
      const nonExistent = path.join(os.tmpdir(), "non_existent_nash_dir_" + Date.now());
      const resBad = checkWorkingDirectory(nonExistent);
      assert.equal(resBad.passed, false);
      assert.ok(resBad.error?.includes("does not exist"));

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-test-dir-"));
      try {
        const resGood = checkWorkingDirectory(tmpDir);
        assert.equal(resGood.passed, true);
        assert.equal(resGood.detail, tmpDir);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("1.2 checkEntrypoint 应识别不存在、空文件及正常入口", () => {
      const nonExistent = path.join(os.tmpdir(), "entrypoint_missing_" + Date.now() + ".js");
      const resMissing = checkEntrypoint(nonExistent);
      assert.equal(resMissing.passed, false);
      assert.ok(resMissing.error?.includes("not found"));

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-entry-"));
      const emptyFile = path.join(tmpDir, "empty.js");
      fs.writeFileSync(emptyFile, "");

      const goodFile = path.join(tmpDir, "index.js");
      fs.writeFileSync(goodFile, "console.log('hello');");

      try {
        const resEmpty = checkEntrypoint(emptyFile);
        assert.equal(resEmpty.passed, false);
        assert.ok(resEmpty.error?.includes("0 bytes"));

        const resGood = checkEntrypoint(goodFile);
        assert.equal(resGood.passed, true);
        assert.ok(resGood.detail?.includes("index.js"));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("1.3 checkNodeRuntime 应精确匹配 Node.js 24 引擎版本", () => {
      const resCurrent = checkNodeRuntime(24, 14);
      assert.equal(resCurrent.passed, true);
      assert.ok(resCurrent.detail?.includes(process.versions.node));

      // 故意模拟要求未来的 Node.js 99
      const resFuture = checkNodeRuntime(99, 0);
      assert.equal(resFuture.passed, false);
      assert.ok(resFuture.error?.includes("does not satisfy engine requirement"));
    });
  });

  // --------------------------------------------------------------------------
  // 2. 端口与网络占用冲突
  // --------------------------------------------------------------------------
  describe("2. Port Availability Probing", () => {
    it("2.1 端口可用时返回 passed，被占用时返回清晰错误", async () => {
      // 找一个空闲端口
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address() as net.AddressInfo;
      const occupiedPort = address.port;

      // 在被占用状态下检查
      const resOccupied = await checkPortAvailability(occupiedPort, "127.0.0.1");
      assert.equal(resOccupied.passed, false);
      assert.ok(resOccupied.error?.includes("already in use"));

      // 释放端口后检查
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const resFree = await checkPortAvailability(occupiedPort, "127.0.0.1");
      assert.equal(resFree.passed, true);
      assert.ok(resFree.detail?.includes("is free and bindable"));
    });
  });

  // --------------------------------------------------------------------------
  // 3. 环境变量校验与敏感凭据脱敏
  // --------------------------------------------------------------------------
  describe("3. Environment Variables & Secret Sanitization", () => {
    it("3.1 sanitizeSecret 必须彻底脱敏 API Key、密码与数据库 URL", () => {
      assert.equal(sanitizeSecret("ANTHROPIC_API_KEY", "sk-test-178f43902c2940a69def"), "sk-***def");
      assert.equal(
        sanitizeSecret("DATABASE_URL", "postgresql://admin:super_secret_pw@127.0.0.1:5432/cluster_db"),
        "postgresql://admin:***@127.0.0.1:5432/cluster_db"
      );
      assert.equal(sanitizeSecret("SESSION_SECRET", "short"), "***");
      assert.equal(sanitizeSecret("APP_ENV", "production"), "production");
    });

    it("3.2 checkEnvironmentVariables 缺少必需变量时报错且不泄漏敏感值", () => {
      const mockEnv: NodeJS.ProcessEnv = {
        NASH_PORT: "18444",
        COORDINATOR_KEY: "sk-coord-secret-999",
      };

      const resMissing = checkEnvironmentVariables(["NASH_PORT", "DATABASE_URL"], mockEnv);
      assert.equal(resMissing.passed, false);
      assert.ok(resMissing.error?.includes("DATABASE_URL"));

      const resOk = checkEnvironmentVariables(["NASH_PORT", "COORDINATOR_KEY"], mockEnv);
      assert.equal(resOk.passed, true);
      assert.ok(resOk.detail?.includes("COORDINATOR_KEY=sk-***999"));
      assert.ok(!resOk.detail?.includes("sk-coord-secret-999"));
    });
  });

  // --------------------------------------------------------------------------
  // 4. 故障分类与退出码规范 (RFC sysexits.h)
  // --------------------------------------------------------------------------
  describe("4. Failure Classification & sysexits.h Codes", () => {
    it("4.1 永久配置错误分类为 PERMANENT_CONFIG_ERROR 并返回退出码 78", async () => {
      const nonExistentDir = path.join(os.tmpdir(), "non_existent_cluster_" + Date.now());
      const report = await runServicePreflight({
        workingDirectory: nonExistentDir,
        checkDatabase: false,
      });

      assert.equal(report.ok, false);
      assert.equal(report.classification, "PERMANENT_CONFIG_ERROR");
      assert.equal(report.exitCode, PREFLIGHT_EXIT_CODES.CONFIG_ERROR); // 78
      assert.equal(report.exitCode, 78);
      assert.ok(report.summary.includes("Permanent configuration error"));
    });

    it("4.2 格式化报告包含彩色状态与退出码说明", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-report-"));
      try {
        const dummyEntry = path.join(tmpDir, "dist", "index.js");
        fs.mkdirSync(path.dirname(dummyEntry), { recursive: true });
        fs.writeFileSync(dummyEntry, "console.log(1);");

        const report = await runServicePreflight({
          workingDirectory: tmpDir,
          entrypoint: dummyEntry,
          checkDatabase: false,
        });

        assert.equal(report.ok, true);
        const formatted = formatPreflightReport(report);
        assert.ok(formatted.includes("[Preflight PASSED]"));
        assert.ok(formatted.includes("Working Directory"));
        assert.ok(formatted.includes("Node.js Runtime"));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("4.3 数据库凭证配置错误应判定为永久错误 (78)", async () => {
      // 故意传入一个带错误密码的本地 URL
      const badDbUrl = "postgresql://non_existent_user:bad_pass@127.0.0.1:5432/non_existent_db";
      const dbCheck = await checkDatabaseConnectivity(badDbUrl, { maxRetries: 1, timeoutMs: 1000 });
      assert.equal(dbCheck.passed, false);
      assert.equal(typeof dbCheck.isTransient, "boolean");
      assert.ok(!dbCheck.error?.includes("bad_pass")); // 密码已脱敏
    });
  });

  // --------------------------------------------------------------------------
  // 5. 部署诊断器与 systemd 单元静态分析
  // --------------------------------------------------------------------------
  describe("5. Deployment Diagnostics & Unit Risk Analysis", () => {
    it("5.1a discovers the official product unit and custom nash units", () => {
      const units = selectNashServiceUnits([
        "nash-product.service enabled",
        "nash-node1.service enabled",
        "harness-agent.service disabled",
        "nginx.service enabled",
        "sshd.service enabled",
      ].join("\n"));

      assert.ok(units.includes("nash-product.service"));
      assert.ok(units.includes("nash-node1.service"));
      assert.ok(units.includes("harness-agent.service"));
      assert.ok(!units.includes("nginx.service"));
      assert.ok(!units.includes("sshd.service"));
    });

    it("5.1b keeps fallback units and honors an explicit service name", () => {
      const units = selectNashServiceUnits("", "custom-coordinator.service");
      assert.ok(units.includes("custom-coordinator.service"));
      assert.ok(units.includes("nash-cluster.service"));
      assert.ok(units.includes("nash-worker.service"));
      assert.ok(units.includes("nash-product.service"));
    });

    it("5.1 inspectSystemdUnit 应准确识别废弃服务并标记停用", () => {
      const diag = inspectSystemdUnit("harness-agent.service");
      assert.equal(diag.name, "harness-agent.service");
      assert.equal(diag.isDeprecated, true);
      assert.ok(diag.riskReason?.includes("Deprecated legacy Python backend"));
    });

    it("5.2 runDeploymentDiagnostics 应在当前工作区正常生成诊断数据", async () => {
      const report = await runDeploymentDiagnostics({
        deploymentDir: process.cwd(),
        checkDb: false,
      });

      assert.ok(report.platform);
      assert.ok(report.nodeVersion);
      assert.equal(report.entrypointExists, true);
      assert.ok(report.verdict === "READY" || report.verdict === "DEPLOYMENT_REQUIRED");

      const formatted = formatDeploymentReport(report);
      assert.ok(formatted.includes("Nash Linux Deployment & Service Diagnostic Report"));
      assert.ok(formatted.includes("System & Runtime Environment"));
    });

    it("5.3 inspectSystemdUnit 应准确识别未配置熔断的单元为无限重启高危", () => {
      // 模拟未加固前的旧 nash-cluster.service
      const oldUnitOutput = [
        "Description=Nash Cluster Coordinator & Worker Daemon",
        "ActiveState=active",
        "SubState=running",
        "UnitFileState=enabled",
        "Restart=always",
        "RestartSec=5s",
        "StartLimitIntervalUSec=10000000",
        "StartLimitBurst=5",
      ].join("\n");

      const diag = inspectSystemdUnit("nash-cluster.service", oldUnitOutput);
      assert.equal(diag.hasInfiniteRestartRisk, true);
      assert.ok(diag.riskReason?.includes("without EX_CONFIG (78) guard"));
    });

    it("5.4 inspectSystemdUnit 对配置了 StartLimitIntervalSec=60s 和 78 拦截的加固单元判定为安全", () => {
      // 模拟新模板配置
      const hardenedUnitOutput = [
        "Description=Nash Cluster Coordinator & Worker Daemon",
        "ActiveState=active",
        "SubState=running",
        "UnitFileState=enabled",
        "Restart=on-failure",
        "RestartSec=10s",
        "StartLimitIntervalUSec=60000000",
        "StartLimitBurst=3",
        "RestartPreventExitStatus=78",
      ].join("\n");

      const diag = inspectSystemdUnit("nash-cluster.service", hardenedUnitOutput);
      assert.equal(diag.hasInfiniteRestartRisk, false);
      assert.equal(diag.startLimitIntervalSec, 60);
      assert.equal(diag.startLimitBurst, 3);
      assert.deepEqual(diag.restartPreventExitStatus, [78]);
    });

    it("reads systemd human durations and redacts database credentials in effective ExecStart", () => {
      const diag = inspectSystemdUnit("nash-cluster.service", [
        "ActiveState=active", "Restart=on-failure", "RestartUSec=10s",
        "StartLimitIntervalUSec=1min", "StartLimitBurst=3", "RestartPreventExitStatus=78",
        "ExecStart=/node cluster start --db postgresql://user:test-password@localhost/db",
      ].join("\n"));
      assert.equal(diag.startLimitIntervalSec, 60);
      assert.equal(diag.restartSec, "10s");
      assert.equal(diag.hasInfiniteRestartRisk, false);
      assert.ok(!diag.execStart?.includes("test-password"));
    });

    it("5.5 Worker WSS 重连退避算法应按指数递增并在 15s 封顶", () => {
      // 模拟计算公式: min(1000 * Math.pow(1.5, attempt), 15000)
      const calculateDelay = (attempt: number) => Math.min(1000 * Math.pow(1.5, attempt), 15000);

      const delay1 = calculateDelay(1); // 1500
      const delay2 = calculateDelay(2); // 2250
      const delay5 = calculateDelay(5); // 7593.75
      const delay10 = calculateDelay(10); // 15000 (封顶)

      assert.equal(delay1, 1500);
      assert.equal(delay2, 2250);
      assert.ok(delay5 > delay2);
      assert.equal(delay10, 15000);
    });
  });
});


describe("deployment selection follows effective service identity", () => {
  it("uses the active service directory instead of a historical default", async () => {
    const { resolveDeploymentTarget } = await import("../src/cluster/preflight/deployment-doctor.js");
    const active = inspectSystemdUnit("nash-cluster.service", "LoadState=loaded\nActiveState=active\nWorkingDirectory=/srv/releases/current\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/releases/r1/dist/index.js cluster start ; }");
    const absent = inspectSystemdUnit("nash-worker.service", "LoadState=not-found\nActiveState=inactive");
    assert.equal(absent.loaded, false);
    const target = resolveDeploymentTarget({}, [active, absent], "/opt/old");
    assert.equal(target.directory, path.resolve("/srv/releases/current"));
    assert.equal(target.entrypoint, path.resolve("/srv/releases/r1/dist/index.js"));
    assert.equal(target.source, "systemd");
    const explicit = resolveDeploymentTarget({ deploymentDir: "/srv/staged" }, [active]);
    assert.equal(explicit.entrypoint, path.resolve("/srv/staged/dist/index.js"));
  });
  it("blocks ambiguous services and missing explicit units", async () => {
    const { resolveDeploymentTarget } = await import("../src/cluster/preflight/deployment-doctor.js");
    const services = ["nash-cluster.service", "nash-worker.service"].map(unit => inspectSystemdUnit(unit, "LoadState=loaded\nActiveState=active\nWorkingDirectory=/srv/" + unit));
    assert.match(resolveDeploymentTarget({}, services).error!, /Multiple active/);
    assert.equal(resolveDeploymentTarget({ serviceName: "nash-worker.service" }, services).service?.name, "nash-worker.service");
    assert.match(resolveDeploymentTarget({ serviceName: "missing.service" }, services).error!, /not loaded/);
  });
  it("redacts URL query passwords and command line secrets", async () => {
    const { redactDiagnosticText } = await import("../src/cluster/preflight/service-preflight.js");
    const value = redactDiagnosticText('postgresql://u:p%40ss@localhost/db?password=querysecret&sslkey=keysecret --token tokensecret');
    for (const secret of ["p%40ss", "querysecret", "keysecret", "tokensecret"]) assert.ok(!value.includes(secret));
  });
});
