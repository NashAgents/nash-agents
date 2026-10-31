import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { CLUSTER_MIGRATIONS, LATEST_CLUSTER_SCHEMA_VERSION } from "./migrations.js";

const { Pool } = pg;

export class ClusterDatabase {
  private readonly transactionClient = new AsyncLocalStorage<pg.PoolClient>();
  private pool: pg.Pool | null = null;
  private isConnected = false;

  constructor(private readonly connectionString?: string) {}

  async connect(): Promise<boolean> {
    if (!this.connectionString) {
      return false;
    }

    try {
      this.pool = new Pool({
        connectionString: this.connectionString,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      // Idle sockets can disappear during a database or tunnel restart; pg replaces them on demand.
      this.pool.on("error", () => console.warn("[ClusterDatabase] Idle PostgreSQL connection closed; pending queries remain fail-closed."));

      // 测试连接连通性
      const client = await this.pool.connect();
      client.release();
      this.isConnected = true;
      return true;
    } catch (err) {
      console.warn(`[ClusterDatabase] Could not connect to PostgreSQL: ${err instanceof Error ? err.message : String(err)}`);
      this.isConnected = false;
      return false;
    }
  }

  isReady(): boolean {
    return this.isConnected && this.pool !== null;
  }

  async runMigrations(): Promise<void> {
    if (!this.pool || !this.isConnected) return;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(`
        CREATE TABLE IF NOT EXISTS cluster_schema_migrations (
          version INT PRIMARY KEY,
          name VARCHAR(128) NOT NULL,
          applied_at BIGINT NOT NULL
        );
      `);

      const res = await client.query<{ version: number }>(
        "SELECT version FROM cluster_schema_migrations ORDER BY version ASC"
      );
      const applied = new Set(res.rows.map((r) => r.version));

      // Fail-Closed：数据库已被更新版本的程序迁移过（典型场景是程序回滚），
      // 旧程序无法理解新增列/约束，继续运行会产生静默的数据错乱。
      // 这里显式拒绝，并把处置方式交给运维（恢复匹配的数据库备份或升级程序）。
      const appliedMax = res.rows.reduce((max, r) => Math.max(max, r.version), 0);
      if (appliedMax > LATEST_CLUSTER_SCHEMA_VERSION) {
        throw new Error(
          `[ClusterDatabase] 数据库 schema 版本 ${appliedMax} 高于当前程序支持的 ${LATEST_CLUSTER_SCHEMA_VERSION}；` +
            `请升级程序或恢复匹配的数据库备份，不得删除版本标记强行运行。`
        );
      }

      for (const mig of CLUSTER_MIGRATIONS) {
        if (!applied.has(mig.version)) {
          await client.query(mig.sql);
          await client.query(
            "INSERT INTO cluster_schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)",
            [mig.version, mig.name, Date.now()]
          );
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async query<R extends pg.QueryResultRow = any>(
    text: string,
    params?: any[]
  ): Promise<pg.QueryResult<R>> {
    if (!this.pool || !this.isConnected) {
      throw new Error("PostgreSQL pool is not connected");
    }
    return (this.transactionClient.getStore() ?? this.pool).query<R>(text, params);
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.transactionClient.getStore()) return operation();
    if (!this.pool || !this.isConnected) throw new Error("PostgreSQL pool is not connected");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await this.transactionClient.run(client, operation);
      await client.query("COMMIT");
      return value;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.isConnected = false;
    }
  }
}
