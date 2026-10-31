import path from "node:path";
import { WorkerRuntime } from "../worker/worker-runtime.js";
import { NodeIdentity } from "../identity/node-identity.js";
import { resolveNashHome } from "../../config/data-home.js";
import { ProjectRegistry } from "../worker/project-registry.js";
import { ProjectRegistryAdapter } from "../worker/catalog/project-registry-adapter.js";
import { LocalCatalogProvider } from "../worker/catalog/local-catalog-provider.js";

export async function handleNodeCommand(args: string[]): Promise<void> {
  const subCommand = args[0] || "help";

  if (subCommand === "help" || args.includes("--help") || args.includes("-h")) {
    printNodeHelp();
    return;
  }

  const identity = new NodeIdentity();
  const registry = new ProjectRegistry();

  switch (subCommand) {
    case "start": {
      const coordIndex = args.indexOf("--coordinator");
      const coordUrl = coordIndex !== -1 ? args[coordIndex + 1] : identity.coordinatorUrl;
      if (!coordUrl) { console.error("Worker connection blocked: MISSING_COORDINATOR_URL"); process.exitCode = 78; return; }

      console.log(`Starting Nash Worker node (ID: ${identity.nodeId})...`);
      const worker = new WorkerRuntime({
        coordinatorUrl: coordUrl,
        onFatalError: () => { void worker.stop().finally(() => { process.exitCode = 78; }); },
      });
      const stop = () => { void worker.stop(); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try { await worker.start(); }
      catch (error) {
        process.exitCode = (error as { exitCode?: number }).exitCode ?? 1;
        if ((error as Error).name !== "AbortError") console.error((error as Error).message);
        return;
      }
      console.log(`✓ Worker node connected to Coordinator!`);
      console.log(`Node ID: ${worker.nodeId}`);
      console.log(`Authorized Projects: ${worker.projects.listProjects().length}`);
      console.log(`Worker is running in background. Waiting for tasks...`);

      // 保持前台长驻运行
      await new Promise(() => {});
      break;
    }

    case "join": {
      const coordinatorUrl = args[1];
      const inviteCode = args[2];

      if (!coordinatorUrl || !inviteCode) {
        console.error("Usage: nash node join <coordinator-wss-url> <invite-code>");
        return;
      }

      console.log(`Pairing node with Coordinator at ${coordinatorUrl}...`);
      const worker = new WorkerRuntime({
        coordinatorUrl,
        inviteCode,
      });

      try {
        await worker.start();
        console.log(`✓ Successfully joined Nash Cluster!`);
        console.log(`Node ID: ${worker.nodeId}`);
        console.log(`Persistent token saved to ${path.join(resolveNashHome(), "cluster-identity.json")}`);
        await worker.stop();
      } catch (err) {
        console.error(`Failed to join cluster: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case "status": {
      console.log("\n=== Local Node Status ===");
      console.log(`Node ID:         ${identity.nodeId}`);
      console.log(`Node Name:       ${identity.name}`);
      console.log(`Role:            ${identity.role}`);
      console.log(`Coordinator URL: ${identity.coordinatorUrl ?? "Not configured"}`);
      console.log(`Has Node Token:  ${identity.nodeToken ? "Yes (configured)" : "No"}`);
      const projects = registry.listProjects();
      console.log(`Projects Count:  ${projects.length}`);
      for (const p of projects) {
        console.log(`  - [${p.projectId}] ${p.name} -> ${p.canonicalPath}`);
      }
      console.log("");
      break;
    }

    case "projects": {
      const action = args[1] || "list";
      if (action === "list") {
        const projects = registry.listProjects();
        console.log("\n=== Authorized Local Projects ===");
        if (projects.length === 0) {
          console.log("No projects registered. Add one using: nash node projects add <path>\n");
          return;
        }
        for (const p of projects) {
          console.log(`[${p.projectId}] ${p.name}`);
          console.log(`  Path: ${p.canonicalPath}\n`);
        }
      } else if (action === "add") {
        const projectPath = args[2];
        if (!projectPath) {
          console.error("Usage: nash node projects add <path> [--name <name>]");
          return;
        }
        const nameIdx = args.indexOf("--name");
        const name = nameIdx !== -1 ? args[nameIdx + 1] : undefined;
        try {
          const registered = registry.registerProject(projectPath, name);
          console.log(`✓ Authorized project registered:`);
          console.log(`  Project ID: ${registered.projectId}`);
          console.log(`  Name:       ${registered.name}`);
          console.log(`  Real Path:  ${registered.canonicalPath}`);
        } catch (err) {
          console.error(`Failed to register project: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (action === "remove") {
        const projectId = args[2];
        if (!projectId) {
          console.error("Usage: nash node projects remove <project-id>");
          return;
        }
        const ok = registry.removeProject(projectId);
        console.log(ok ? `✓ Project ${projectId} removed` : `Project ${projectId} not found`);
      } else if (action === "describe") {
        const projectId = args[2];
        if (!projectId) {
          console.error("Usage: nash node projects describe <project-id> [--summary <text>] [--desc <text>] [--tech <t1,t2>] [--cap <c1,c2>] [--visibility <vis>]");
          return;
        }
        const projAdapter = new ProjectRegistryAdapter(registry, identity.nodeId);
        const summaryIdx = args.indexOf("--summary");
        const descIdx = args.indexOf("--desc");
        const techIdx = args.indexOf("--tech");
        const capIdx = args.indexOf("--cap");
        const visIdx = args.indexOf("--visibility");

        const summary = summaryIdx !== -1 ? args[summaryIdx + 1] : undefined;
        const description = descIdx !== -1 ? args[descIdx + 1] : undefined;
        const technologies = techIdx !== -1 ? args[techIdx + 1].split(",").map((s) => s.trim()) : undefined;
        const capabilities = capIdx !== -1 ? args[capIdx + 1].split(",").map((s) => s.trim()) : undefined;
        const visibility = visIdx !== -1 ? (args[visIdx + 1] as any) : undefined;

        if (!summary && !description && !technologies && !capabilities && !visibility) {
          const current = projAdapter.getProjectOverride(projectId);
          console.log(`\n=== Project Metadata Override: ${projectId} ===`);
          console.log(JSON.stringify(current ?? { message: "No overrides set (using auto-detected)" }, null, 2));
          return;
        }

        projAdapter.setProjectOverride(projectId, {
          summary,
          description,
          technologies,
          capabilities,
          visibility,
        });
        console.log(`✓ Updated metadata overrides for project: ${projectId}`);
      }
      break;
    }

    case "memory": {
      const memAction = args[1];
      if (memAction === "reindex") {
        console.log(`\nReindexing local federated memory summaries for node ${identity.nodeId}...`);
        const provider = new LocalCatalogProvider({
          nodeId: identity.nodeId,
          projectRegistry: registry,
        });
        const items = await provider.memoryAdapter.exportFederatedIndex();
        console.log(`✓ Reindexed ${items.length} federated memory topic entries:`);
        for (const item of items) {
          console.log(`  - [${item.entryId}] ${item.topic} (Keywords: ${item.keywords.join(", ")})`);
        }
        console.log("");
        return;
      }
      console.error("Usage: nash node memory reindex");
      break;
    }

    default:
      printNodeHelp();
  }
}

function printNodeHelp(): void {
  console.log(`
Nash Node CLI (Phase 1 & Phase 2: Local Catalog Provider)

Usage:
  nash node start [--coordinator <url>]                Start Worker and connect to Coordinator
  nash node join <coordinator-url> <invite-code>       Pair with Cluster using an invite code
  nash node status                                     Show local node identity and configuration
  nash node projects list                              List locally registered projects
  nash node projects add <path> [--name <name>]        Authorize a local project directory
  nash node projects remove <project-id>               Revoke authorization for a project
  nash node projects describe <project-id>             Describe or update project metadata/visibility
  nash node memory reindex                             Rebuild and inspect local federated memory index
`);
}
