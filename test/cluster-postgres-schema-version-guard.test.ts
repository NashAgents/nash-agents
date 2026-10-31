import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ClusterDatabase } from "../src/cluster/storage/db.js";
import { CLUSTER_MIGRATIONS, LATEST_CLUSTER_SCHEMA_VERSION } from "../src/cluster/storage/migrations.js";

const connection = process.env.NASH_TEST_DATABASE_URL;

/** 每个用例一个独立 schema，结束后整体 DROP，保证数据库零残留。 */
async function fixture(t: TestContext) {
  const admin = new ClusterDatabase(connection);
  const schema = `nash_schema_guard_${randomUUID().replaceAll("-", "")}`;
  const connections: ClusterDatabase[] = [];
  let created = false;
  t.after(async () => {
    try {
      for (const db of connections) await db.close();
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.close();
    }
  });
  assert.equal(await admin.connect(), true);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  const url = new URL(connection!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const connect = async () => {
    const db = new ClusterDatabase(url.toString());
    connections.push(db);
    assert.equal(await db.connect(), true);
    return db;
  };
  return { db: await connect(), connect, schema };
}

test("REAL_DATABASE: 迁移常量与迁移表最高版本一致，全量迁移后停在 15", { skip: !connection }, async (t) => {
  const { db } = await fixture(t);
  const highest = CLUSTER_MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
  assert.equal(LATEST_CLUSTER_SCHEMA_VERSION, highest, "常量必须与迁移表最高版本一致");

  await db.runMigrations();
  const rows = await db.query<{ version: number }>("SELECT version FROM cluster_schema_migrations ORDER BY version");
  assert.equal(rows.rows.length, CLUSTER_MIGRATIONS.length, "每个迁移都必须被记录一次");
  assert.equal(Math.max(...rows.rows.map((r) => r.version)), LATEST_CLUSTER_SCHEMA_VERSION, "迁移后版本必须等于当前最高版本");
  const taskSecurityGrants = await db.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'cluster_task_grants') AS exists"
  );
  assert.equal(taskSecurityGrants.rows[0].exists, true, "v15 的任务级授权表必须真实创建");
});

test("REAL_DATABASE: 重复执行迁移是幂等的", { skip: !connection }, async (t) => {
  const { db } = await fixture(t);
  await db.runMigrations();
  await db.runMigrations();
  const rows = await db.query<{ version: number }>("SELECT version FROM cluster_schema_migrations");
  assert.equal(rows.rows.length, CLUSTER_MIGRATIONS.length, "重复执行不得重复记录迁移");
});

test("REAL_DATABASE: 从 v14 数据库升级只补 v15 且保留已有数据", { skip: !connection }, async (t) => {
  const { db } = await fixture(t);
  // 模拟一个停留在 v14 的老数据库：手工只应用前 14 个迁移。
  await db.query(`CREATE TABLE cluster_schema_migrations (
    version INT PRIMARY KEY, name VARCHAR(128) NOT NULL, applied_at BIGINT NOT NULL)`);
  for (const migration of CLUSTER_MIGRATIONS.filter((m) => m.version <= 14)) {
    await db.query(migration.sql);
    await db.query("INSERT INTO cluster_schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)", [
      migration.version,
      migration.name,
      Date.now(),
    ]);
  }
  const now = Date.now();
  await db.query(
    `INSERT INTO cluster_nodes (node_id, name, role, platform, arch, hostname, token_hash, status, last_seen_at, metadata, created_at, updated_at)
     VALUES ($1,$2,'worker','linux','x64','legacy',$3,'online',$4,'{}',$4,$4)`,
    ["legacy-node", "legacy", "hash", now]
  );

  await db.runMigrations();

  const versions = await db.query<{ version: number }>("SELECT version FROM cluster_schema_migrations ORDER BY version");
  assert.deepEqual(
    versions.rows.map((r) => r.version),
    CLUSTER_MIGRATIONS.map((m) => m.version),
    "升级后版本序列必须完整且不重复"
  );
  const legacy = await db.query<{ name: string }>("SELECT name FROM cluster_nodes WHERE node_id = 'legacy-node'");
  assert.equal(legacy.rows[0]?.name, "legacy", "升级不得丢失旧数据");
  const grants = await db.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'cluster_task_grants') AS exists"
  );
  assert.equal(grants.rows[0].exists, true, "v15 必须被补上");
});

test("REAL_DATABASE: 数据库版本高于程序时 Fail-Closed 拒绝启动且不写入任何表", { skip: !connection }, async (t) => {
  const { db } = await fixture(t);
  // 模拟「程序回滚 + 数据库已被新版本迁移」：版本记录超前，但实际表可能存在未知列。
  await db.query(`CREATE TABLE cluster_schema_migrations (
    version INT PRIMARY KEY, name VARCHAR(128) NOT NULL, applied_at BIGINT NOT NULL)`);
  for (const migration of CLUSTER_MIGRATIONS) {
    await db.query("INSERT INTO cluster_schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)", [
      migration.version,
      migration.name,
      Date.now(),
    ]);
  }
  await db.query("INSERT INTO cluster_schema_migrations (version, name, applied_at) VALUES (999, 'from_the_future', $1)", [Date.now()]);

  await assert.rejects(
    () => db.runMigrations(),
    (error: Error) => {
      assert.match(error.message, /999/, "错误必须报出实际版本");
      assert.match(error.message, new RegExp(String(LATEST_CLUSTER_SCHEMA_VERSION)), "错误必须报出程序支持的版本");
      assert.match(error.message, /不得删除版本标记强行运行/, "错误必须给出明确处置指引");
      return true;
    }
  );

  const nodes = await db.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'cluster_nodes') AS exists"
  );
  assert.equal(nodes.rows[0].exists, false, "守卫必须在应用任何迁移之前抛出，不能留下半迁移状态");
});

test("REAL_DATABASE: 版本超前的数据库在并发连接下同样被拒绝", { skip: !connection }, async (t) => {
  const { db, connect } = await fixture(t);
  await db.query(`CREATE TABLE cluster_schema_migrations (
    version INT PRIMARY KEY, name VARCHAR(128) NOT NULL, applied_at BIGINT NOT NULL)`);
  await db.query("INSERT INTO cluster_schema_migrations (version, name, applied_at) VALUES (999, 'from_the_future', $1)", [Date.now()]);

  const other = await connect();
  const results = await Promise.allSettled([db.runMigrations(), other.runMigrations()]);
  assert.equal(results.filter((r) => r.status === "rejected").length, 2, "两个连接都必须拒绝，而不是部分成功");
});
