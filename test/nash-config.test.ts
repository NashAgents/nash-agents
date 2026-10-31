import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  ensureNashSettings,
  getNashModelConfig,
  DEFAULT_NASH_MODEL_CONFIG,
} from "../src/config/nash-config.js";
import { loadSandboxPolicyFromSettings } from "../src/config/settings.js";

describe("Nash Settings & ~/.nash Configuration", () => {
  let fakeHomeDir: string;

  before(async () => {
    fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-home-"));
  });

  after(async () => {
    await fs.rm(fakeHomeDir, { recursive: true, force: true });
  });

  it("1. 启动时检查 ~/.nash/，不存在时自动创建目录与 settings.json", () => {
    const status = ensureNashSettings({ homeDir: fakeHomeDir });

    assert.equal(status.createdDir, true);
    assert.equal(status.createdSettings, true);
    assert.equal(fsSync.existsSync(status.nashDir), true);
    assert.equal(fsSync.existsSync(status.settingsPath), true);

    const written = JSON.parse(
      fsSync.readFileSync(status.settingsPath, "utf-8")
    );

    assert.ok(written.model, "应当包含 model 配置块");
    assert.equal(written.model.baseUrl, DEFAULT_NASH_MODEL_CONFIG.baseUrl);
    assert.equal(written.model.model, DEFAULT_NASH_MODEL_CONFIG.model);
    assert.equal(
      written.model.contextWindow,
      DEFAULT_NASH_MODEL_CONFIG.contextWindow
    );
    assert.equal(
      written.model.compactionThreshold,
      DEFAULT_NASH_MODEL_CONFIG.compactionThreshold
    );
    assert.ok(written.sandbox, "应当包含 sandbox 配置块");
    assert.equal(written.sandbox.filesystem, "workspace-write");
  });

  it("2. 若 ~/.nash/settings.json 已存在，则直接载入并不覆盖用户配置", async () => {
    const settingsPath = path.join(fakeHomeDir, ".nash", "settings.json");
    const customConfig = {
      model: {
        baseUrl: "https://custom.api.com/v1",
        apiKey: "sk-my-custom-token",
        model: "custom-gpt-model",
        contextWindow: 128000,
        compactionThreshold: 0.75,
      },
    };
    await fs.writeFile(
      settingsPath,
      JSON.stringify(customConfig, null, 2),
      "utf-8"
    );

    const status = ensureNashSettings({ homeDir: fakeHomeDir });
    assert.equal(status.createdSettings, false);
    assert.equal(status.settings.model?.model, "custom-gpt-model");
    assert.equal(status.settings.model?.contextWindow, 128000);
    assert.equal(status.settings.model?.compactionThreshold, 0.75);

    const loadedModel = getNashModelConfig({ homeDir: fakeHomeDir });
    assert.equal(loadedModel.baseUrl, "https://custom.api.com/v1");
    assert.equal(loadedModel.apiKey, "sk-my-custom-token");
    assert.equal(loadedModel.model, "custom-gpt-model");
    assert.equal(loadedModel.contextWindow, 128000);
    assert.equal(loadedModel.compactionThreshold, 0.75);
  });

  it("3. loadSandboxPolicyFromSettings 在工作区无配置时可回退至 ~/.nash/settings.json", async () => {
    const settingsPath = path.join(fakeHomeDir, ".nash", "settings.json");
    const fullAccessConfig = {
      sandbox: {
        preset: "full",
      },
    };
    await fs.writeFile(
      settingsPath,
      JSON.stringify(fullAccessConfig, null, 2),
      "utf-8"
    );

    // 显式指定读取该配置文件以验证回退解析
    const policy = loadSandboxPolicyFromSettings(settingsPath);
    assert.equal(policy.filesystem.mode, "danger-full-access");
    assert.equal(policy.network.mode, "allow");
    // 完全访问预设 = 全权文件系统 + 允许网络 + 审查通过后自动放行；
    // "never" 会直接拒绝需要审批的操作，与「自主模式」语义不符。
    assert.equal(policy.approval.mode, "auto-grant");
  });
});
