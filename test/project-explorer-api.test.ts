import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { getFriendlyNodeName, getProjectStatus, getProjectIconType } from "../apps/web/src/utils/project-helpers.js";

describe("Project Explorer API & Helper Functions", () => {
  it("getFriendlyNodeName 应准确识别 Darwin / Mac / 腾讯云 / WSL 友好名称", () => {
    assert.equal(getFriendlyNodeName("mac-node-01", "MacBook-Air.local"), "macOS Node");
    assert.equal(getFriendlyNodeName("tencent-prod-01", "example-cloud"), "Cloud Linux Node");
    assert.equal(getFriendlyNodeName("opaque-node", "VM-Linux"), "Linux Node");
    assert.equal(getFriendlyNodeName("wsl2-ubuntu-node", "DESKTOP-WSL"), "WSL2 Linux");
    assert.equal(getFriendlyNodeName("generic-linux-box", "ubuntu-server"), "Linux Node");
  });

  it("getProjectStatus 严格区分已授权与未授权自动发现候选", () => {
    const regProj = {
      projectId: "nash-agent",
      name: "Nash Agent",
      status: "active",
      visibility: "public",
    };
    const regStatus = getProjectStatus(regProj, true);
    assert.equal(regStatus.status, "registered");
    assert.equal(regStatus.canExecuteDirectly, true);

    const discProj = {
      projectId: "discovered-crawler-01",
      name: "Crawler Candidate",
      status: "active",
      visibility: "discovered",
    };
    const discStatus = getProjectStatus(discProj, true);
    assert.equal(discStatus.status, "discovered");
    assert.equal(discStatus.canExecuteDirectly, false);

    const offlineStatus = getProjectStatus(regProj, false);
    assert.equal(offlineStatus.status, "offline");
    assert.equal(offlineStatus.canExecuteDirectly, false);
  });

  it("getProjectIconType 正确按技术栈与特征推断分类", () => {
    assert.equal(getProjectIconType({ technologies: ["TypeScript", "Agent"] }), "agent");
    assert.equal(getProjectIconType({ technologies: ["Vue", "TailwindCSS"] }), "web");
    assert.equal(getProjectIconType({ technologies: ["Python", "FastAPI"] }), "python");
    assert.equal(getProjectIconType({ technologies: ["Electron", "Vue"] }), "desktop");
  });

  it("InMemoryClusterStore 支持按 projectId 过滤任务", async () => {
    const store = new InMemoryClusterStore();

    await store.saveTask({
      taskId: "task-01",
      nodeId: "mac-node",
      projectId: "nash-agent",
      goal: "优化调度引擎",
      status: "completed",
      dispatchAttempt: 1,
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
    });

    await store.saveTask({
      taskId: "task-02",
      nodeId: "tencent-node",
      projectId: "srt-project",
      goal: "转码字幕",
      status: "running",
      dispatchAttempt: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const nashTasks = await store.listTasks({ projectId: "nash-agent" });
    assert.equal(nashTasks.length, 1);
    assert.equal(nashTasks[0]?.taskId, "task-01");

    const srtTasks = await store.listTasks({ projectId: "srt-project" });
    assert.equal(srtTasks.length, 1);
    assert.equal(srtTasks[0]?.taskId, "task-02");
  });
});
