import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { ProductStore } from "../dist/product/store.js";
import { ProductConfigError } from "../dist/product/types.js";
import { testModelProfile } from "../dist/product/model-check.js";

// Credentials enter over stdin or a private file, never through URL/argv values.
const profileArg = process.argv.indexOf("--profiles");
let profiles;
if (process.argv.includes("--stdin")) {
  console.error("Ready for one JSON line of model profiles on stdin.");
  const input = createInterface({ input: process.stdin, terminal: false });
  try { const [line] = await once(input, "line"); profiles = JSON.parse(line); }
  finally { input.close(); process.stdin.pause(); }
} else if (profileArg >= 0 && process.argv[profileArg + 1]) {
  const file = process.argv[profileArg + 1], stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576 || process.platform !== "win32" && stat.mode & 0o077) throw new Error("Use an ordinary profiles JSON file with permission 600.");
  profiles = JSON.parse(fs.readFileSync(file, "utf8"));
} else { console.error("Usage: node scripts/model-compatibility.js --profiles <private-json-file> [--output <report.json>] or --stdin"); process.exit(2); }
if (!Array.isArray(profiles) || !profiles.length || profiles.length > 12) throw new Error("Provide 1–12 explicit profiles.");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-model-compatibility-"));
let store;
const report = { evidenceLevel: "REAL_LLM", startedAt: new Date().toISOString(), results: [] };
try {
  store = new ProductStore({ homeDir: home });
  for (const profile of profiles) {
    const started = performance.now();
    const label = { name: String(profile.name ?? "profile").slice(0, 100), model: String(profile.model ?? ""), format: String(profile.format ?? "") };
    console.error(`Testing ${label.name} (${label.format})…`);
    try {
      const input = { baseUrl: profile.baseUrl, model: profile.model, apiKey: profile.apiKey, format: profile.format, timeoutMs: profile.timeoutMs ?? 90000, streaming: true, toolCalling: true };
      const result = await testModelProfile(store.previewModel(input), AbortSignal.timeout(7 * 90000));
      report.results.push({ ...label, ...result, passed: true });
    } catch (error) {
      const status = String(error?.message ?? "").match(/(?:HTTP|status)\D{0,4}(\d{3})/i)?.[1];
      report.results.push({ ...label, passed: false, durationMs: performance.now() - started, errorType: error?.name ?? "Error", code: error instanceof ProductConfigError ? error.code : undefined, httpStatus: status ? Number(status) : undefined });
    }
  }
} finally { store?.close(); fs.rmSync(home, { recursive: true, force: true }); }
report.completedAt = new Date().toISOString();
report.passed = report.results.every(result => result.passed);
const outputArg = process.argv.indexOf("--output");
if (outputArg >= 0) fs.writeFileSync(process.argv[outputArg + 1], JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
