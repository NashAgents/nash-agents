import fs from "node:fs";
import path from "node:path";
import { serialize, deserialize } from "node:v8";
import { ClusterStorageError, InMemoryClusterStore, type IClusterStore } from "./cluster-store.js";

/** 单 Coordinator 本地持久化；多实例部署继续使用 PostgreSQL。 */
export function createLocalClusterStore(file: string): IClusterStore {
  const target = new InMemoryClusterStore();
  const keys = Object.keys(target).filter(key => key !== "conversationSnapshots");
  const restore = (buffer: Buffer): void => {
    const snapshot = deserialize(buffer);
    if (snapshot.version !== 1) throw new ClusterStorageError("Unsupported cluster snapshot version");
    for (const key of keys) {
      if (Object.hasOwn(snapshot.data, key)) {
        Reflect.set(target, key, snapshot.data[key]);
      } else {
        // 向前兼容：若老版本快照缺少新字段，保留 target 初始化的默认结构
        if (!Reflect.get(target, key)) {
          Reflect.set(target, key, new Map());
        }
      }
    }
  };
  const snapshot = (): Buffer => serialize({ version: 1, data: Object.fromEntries(keys.map((key) => [key, Reflect.get(target, key)])) });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) restore(fs.readFileSync(file));
  let queue = Promise.resolve();
  return new Proxy(target, {
    get(object, key) {
      const method = Reflect.get(object, key);
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => {
        const write = /^(executeGoalTaskControl|commitGoalTurnResponse|continueGoalRun|createGoalRun|claimGoalTurnLease|renewGoalTurnLease|createNodeIfAbsent|createGraphAtomic|claimScheduledTaskRun|transition|apply|prune|purge|save|update|upsert|delete|append|enqueue|mark|checkAndRecord|record|resolve|grant|clean)/.test(String(key));
        const result = queue.then(async () => {
          const previous = write ? snapshot() : undefined;
          try {
            const value = await method.apply(object, args);
            if (write) {
              const temporary = `${file}.tmp`;
              try {
                fs.writeFileSync(temporary, snapshot(), { mode: 0o600, flush: true });
                fs.renameSync(temporary, file);
              } finally { fs.rmSync(temporary, { force: true }); }
            }
            return value;
          } catch (err) { if (previous) restore(previous); throw err; }
        });
        queue = result.then(() => {}, () => {});
        return result;
      };
    },
  });
}
