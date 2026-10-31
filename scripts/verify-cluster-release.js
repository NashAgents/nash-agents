import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { evaluateClusterRelease } from "./cluster-release-evaluator.js";

const { values } = parseArgs({
  options: {
    release: { type: "string" },
    helper: { type: "string" },
    artifact: { type: "string" },
    "build-info": { type: "string", default: "dist/build-info.json" },
    nodes: { type: "string" },
    "expected-count": { type: "string", default: "3" },
    url: { type: "string", default: "http://127.0.0.1:18444" },
  },
});

// 期望产物哈希的优先级：显式 --artifact > 本地构建产物 build-info。
// 绝不接受「只给 commit 就宣称运行版本已确认」。
let expectedArtifact = values.artifact;
if (!expectedArtifact) {
  try {
    const localBuild = JSON.parse(fs.readFileSync(path.resolve(values["build-info"]), "utf8"));
    expectedArtifact = localBuild.artifactSha256;
  } catch { /* 下方统一报错 */ }
}

if (!/^[a-f0-9]{40}$/.test(values.release ?? "") || !/^[a-f0-9]{64}$/.test(values.helper ?? "") || !values.nodes) {
  throw new Error("Required: --release <full commit> --helper <SHA256> --nodes <comma-separated node IDs>");
}
if (!/^[a-f0-9]{64}$/.test(expectedArtifact ?? "")) {
  throw new Error("Required: --artifact <SHA256> (or a readable --build-info with artifactSha256); commit alone cannot attest the running bytes");
}

const expectedNodes = values.nodes.split(",").map((value) => value.trim()).filter(Boolean);
const expectedCount = Number(values["expected-count"]);
if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedNodes.length !== expectedCount || new Set(expectedNodes).size !== expectedCount) {
  throw new Error("Expected node count must match unique --nodes entries");
}

let headers = { "Content-Type": "application/json" };
let session = false;
async function request(route, options = {}) {
  const response = await fetch(`${values.url}${route}`, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Cluster verification request failed (${response.status})`);
  return data;
}

try {
  if (process.env.NASH_ADMIN_API_KEY) headers.Authorization = `Bearer ${process.env.NASH_ADMIN_API_KEY}`;
  else {
    const response = await fetch(`${values.url}/api/auth/login`, {
      method: "POST", headers,
      body: JSON.stringify({ username: process.env.DASHBOARD_USER || process.env.ADMIN_USER || "admin", password: process.env.DASHBOARD_PASS || process.env.ADMIN_PASS }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Cluster login failed (${response.status})`);
    const login = await response.json();
    headers.cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    headers["x-csrf-token"] = login.csrfToken;
    session = true;
  }
  const [status, inventory] = await Promise.all([request("/api/cluster/status"), request("/api/cluster/nodes")]);
  const report = evaluateClusterRelease({
    expected: { commit: values.release, artifactSha256: expectedArtifact },
    coordinatorRelease: status.runtimeRelease,
    nodes: inventory.nodes ?? [],
    expectedNodes,
    helperSha256: values.helper,
  });
  console.log(JSON.stringify({
    ...report,
    artifactScope: "dist/**/*.js（运行进程自校验范围）；发布包级清单见 release-manifest 的 buildArtifactChecksums",
    provenance: "self-reported runtime release; not a supply-chain signature",
    sourceHeads: "Require separate Git audit",
    distributedE2E: "Require separate task evidence",
  }, null, 2));
  if (report.verdict !== "RUNTIME_VERIFIED") process.exitCode = 1;
} finally {
  if (session) await request("/api/auth/logout", { method: "POST" });
}
