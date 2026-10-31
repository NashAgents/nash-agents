/**
 * PostgreSQL Schema Migrations for Nash Cluster
 * 包含所有核心表结构、索引与幂等迁移逻辑
 */

/**
 * 当前程序能理解的最高 schema 版本。
 * 数据库记录的版本高于此值时，说明是「旧程序 + 新数据库」（典型的回滚场景），
 * 迁移器必须拒绝启动而不是带着未知列继续运行。
 */
export const LATEST_CLUSTER_SCHEMA_VERSION = 15;

export const CLUSTER_MIGRATIONS = [
  {
    version: 1,
    name: "001_initial_cluster_schema",
    sql: `
      -- 1. 节点表
      CREATE TABLE IF NOT EXISTS cluster_nodes (
        node_id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'worker',
        platform VARCHAR(32) NOT NULL DEFAULT 'unknown',
        arch VARCHAR(32) NOT NULL DEFAULT 'unknown',
        hostname VARCHAR(128) NOT NULL DEFAULT '',
        token_hash VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'offline',
        last_seen_at BIGINT NOT NULL DEFAULT 0,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cluster_nodes_status ON cluster_nodes(status);

      -- 2. 节点连接与代际表
      CREATE TABLE IF NOT EXISTS cluster_node_connections (
        connection_id VARCHAR(64) PRIMARY KEY,
        node_id VARCHAR(64) NOT NULL REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        generation INT NOT NULL DEFAULT 1,
        remote_ip VARCHAR(64),
        connected_at BIGINT NOT NULL,
        disconnected_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_cluster_connections_node ON cluster_node_connections(node_id);

      -- 3. 配对邀请凭证表
      CREATE TABLE IF NOT EXISTS cluster_invites (
        invite_code VARCHAR(64) PRIMARY KEY,
        token_hash VARCHAR(64) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'worker',
        max_uses INT NOT NULL DEFAULT 1,
        uses_count INT NOT NULL DEFAULT 0,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        revoked_at BIGINT
      );

      -- 4. 任务元数据与当前状态表
      CREATE TABLE IF NOT EXISTS cluster_tasks (
        task_id VARCHAR(64) PRIMARY KEY,
        node_id VARCHAR(64) NOT NULL REFERENCES cluster_nodes(node_id),
        project_id VARCHAR(128) NOT NULL,
        goal TEXT NOT NULL,
        prompt TEXT,
        status VARCHAR(32) NOT NULL DEFAULT 'created',
        dispatch_attempt INT NOT NULL DEFAULT 1,
        result_summary TEXT,
        final_answer TEXT,
        deliverables JSONB,
        error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        completed_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_cluster_tasks_status ON cluster_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_cluster_tasks_node ON cluster_tasks(node_id);
      CREATE INDEX IF NOT EXISTS idx_cluster_tasks_updated ON cluster_tasks(updated_at DESC);

      -- 5. 任务执行 Run 记录表
      CREATE TABLE IF NOT EXISTS cluster_task_runs (
        run_id VARCHAR(64) PRIMARY KEY,
        task_id VARCHAR(64) NOT NULL REFERENCES cluster_tasks(task_id) ON DELETE CASCADE,
        node_id VARCHAR(64) NOT NULL REFERENCES cluster_nodes(node_id),
        attempt INT NOT NULL DEFAULT 1,
        status VARCHAR(32) NOT NULL DEFAULT 'running',
        started_at BIGINT NOT NULL,
        completed_at BIGINT,
        error TEXT,
        exit_code INT
      );

      CREATE INDEX IF NOT EXISTS idx_cluster_runs_task ON cluster_task_runs(task_id);

      -- 6. 持久化单调事件日志表
      CREATE TABLE IF NOT EXISTS cluster_events (
        id BIGSERIAL PRIMARY KEY,
        task_id VARCHAR(64) NOT NULL REFERENCES cluster_tasks(task_id) ON DELETE CASCADE,
        run_id VARCHAR(64) NOT NULL,
        node_id VARCHAR(64) NOT NULL,
        seq INT NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at BIGINT NOT NULL,
        CONSTRAINT uq_cluster_events_task_seq UNIQUE (task_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_cluster_events_task_id ON cluster_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_cluster_events_run_id ON cluster_events(run_id);

      -- 7. 远程审批表
      CREATE TABLE IF NOT EXISTS cluster_approvals (
        approval_id VARCHAR(64) PRIMARY KEY,
        task_id VARCHAR(64) NOT NULL REFERENCES cluster_tasks(task_id) ON DELETE CASCADE,
        run_id VARCHAR(64) NOT NULL,
        node_id VARCHAR(64) NOT NULL REFERENCES cluster_nodes(node_id),
        agent_id VARCHAR(64) NOT NULL DEFAULT 'main',
        capability VARCHAR(64) NOT NULL,
        reason TEXT NOT NULL,
        target TEXT,
        tool_name VARCHAR(64),
        status VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending | resolved | expired
        decision VARCHAR(32), -- allow-once | deny
        requested_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        resolved_at BIGINT,
        resolved_by VARCHAR(64)
      );

      CREATE INDEX IF NOT EXISTS idx_cluster_approvals_status ON cluster_approvals(status);
      CREATE INDEX IF NOT EXISTS idx_cluster_approvals_task ON cluster_approvals(task_id);

      -- 8. 可靠投递 Outbox 队列
      CREATE TABLE IF NOT EXISTS cluster_outbox (
        id BIGSERIAL PRIMARY KEY,
        target_node_id VARCHAR(64) NOT NULL,
        message_id VARCHAR(64) NOT NULL,
        message_type VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending | sent | dead
        attempts INT NOT NULL DEFAULT 0,
        next_retry_at BIGINT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cluster_outbox_queue ON cluster_outbox(status, next_retry_at);

      -- 9. 幂等去重 Inbox 表
      CREATE TABLE IF NOT EXISTS cluster_inbox (
        message_id VARCHAR(64) PRIMARY KEY,
        source_node_id VARCHAR(64) NOT NULL,
        received_at BIGINT NOT NULL,
        processed_at BIGINT
      );
    `,
  },
  {
    version: 2,
    name: "002_catalog_and_federated_memory_schema",
    sql: `
      -- 1. 节点 Catalog 修订版本与同步状态表
      CREATE TABLE IF NOT EXISTS cluster_catalog_revisions (
        node_id VARCHAR(64) PRIMARY KEY REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        catalog_revision INT NOT NULL DEFAULT 0,
        hardware_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_sync_at BIGINT NOT NULL DEFAULT 0,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'idle',
        updated_at BIGINT NOT NULL
      );

      -- 2. 项目目录表 (复合主键: node_id + project_id)
      CREATE TABLE IF NOT EXISTS cluster_project_catalog (
        node_id VARCHAR(64) NOT NULL REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        project_id VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        technologies JSONB NOT NULL DEFAULT '[]'::jsonb,
        capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        visibility VARCHAR(32) NOT NULL DEFAULT 'summary',
        registered_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        last_indexed_at BIGINT NOT NULL,
        revision INT NOT NULL DEFAULT 1,
        user_aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
        PRIMARY KEY (node_id, project_id)
      );

      CREATE INDEX IF NOT EXISTS idx_proj_cat_node ON cluster_project_catalog(node_id);
      CREATE INDEX IF NOT EXISTS idx_proj_cat_name ON cluster_project_catalog(name);
      CREATE INDEX IF NOT EXISTS idx_proj_cat_status ON cluster_project_catalog(status);

      -- 3. Skills 能力目录表 (复合主键: node_id + skill_id)
      CREATE TABLE IF NOT EXISTS cluster_skill_catalog (
        node_id VARCHAR(64) NOT NULL REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        skill_id VARCHAR(128) NOT NULL,
        project_id VARCHAR(128),
        name VARCHAR(128) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        scope VARCHAR(32) NOT NULL DEFAULT 'global',
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        fingerprint VARCHAR(64) NOT NULL DEFAULT '',
        available BOOLEAN NOT NULL DEFAULT true,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (node_id, skill_id)
      );

      CREATE INDEX IF NOT EXISTS idx_skill_cat_node ON cluster_skill_catalog(node_id);
      CREATE INDEX IF NOT EXISTS idx_skill_cat_name ON cluster_skill_catalog(name);

      -- 4. MCP 服务目录表 (复合主键: node_id + server_id)
      CREATE TABLE IF NOT EXISTS cluster_mcp_catalog (
        node_id VARCHAR(64) NOT NULL REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        server_id VARCHAR(128) NOT NULL,
        display_name VARCHAR(128) NOT NULL,
        transport_type VARCHAR(32) NOT NULL DEFAULT 'stdio',
        status VARCHAR(32) NOT NULL DEFAULT 'unknown',
        capability_summary TEXT NOT NULL DEFAULT '',
        tools JSONB NOT NULL DEFAULT '[]'::jsonb,
        resource_count INT NOT NULL DEFAULT 0,
        prompt_count INT NOT NULL DEFAULT 0,
        last_verified_at BIGINT NOT NULL DEFAULT 0,
        revision INT NOT NULL DEFAULT 1,
        PRIMARY KEY (node_id, server_id)
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_cat_node ON cluster_mcp_catalog(node_id);

      -- 5. 联邦记忆轻量索引表 (复合主键: node_id + entry_id)
      CREATE TABLE IF NOT EXISTS cluster_memory_index (
        node_id VARCHAR(64) NOT NULL REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        entry_id VARCHAR(128) NOT NULL,
        project_id VARCHAR(128) NOT NULL,
        topic VARCHAR(128) NOT NULL,
        summary TEXT NOT NULL,
        keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
        source_reference VARCHAR(128) NOT NULL,
        confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        visibility VARCHAR(32) NOT NULL DEFAULT 'summary',
        revision INT NOT NULL DEFAULT 1,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (node_id, entry_id)
      );

      CREATE INDEX IF NOT EXISTS idx_mem_idx_node_proj ON cluster_memory_index(node_id, project_id);
      CREATE INDEX IF NOT EXISTS idx_mem_idx_topic ON cluster_memory_index(topic);

      -- 6. 资源删除与撤销墓碑表 (Tombstone)
      CREATE TABLE IF NOT EXISTS cluster_catalog_tombstones (
        id BIGSERIAL PRIMARY KEY,
        node_id VARCHAR(64) NOT NULL REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        resource_type VARCHAR(32) NOT NULL,
        resource_id VARCHAR(128) NOT NULL,
        project_id VARCHAR(128),
        deleted_at BIGINT NOT NULL,
        revision INT NOT NULL,
        CONSTRAINT uq_catalog_tombstone UNIQUE (node_id, resource_type, resource_id)
      );

      CREATE INDEX IF NOT EXISTS idx_tombstones_node ON cluster_catalog_tombstones(node_id);

      -- 7. 同步审计日志表
      CREATE TABLE IF NOT EXISTS cluster_catalog_sync_log (
        id BIGSERIAL PRIMARY KEY,
        node_id VARCHAR(64) NOT NULL REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        sync_type VARCHAR(32) NOT NULL,
        revision INT NOT NULL,
        item_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(32) NOT NULL,
        error TEXT,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sync_log_node_created ON cluster_catalog_sync_log(node_id, created_at DESC);
    `,
  },
  {
    version: 3,
    name: "003_semantic_task_routing_schema",
    sql: `
      -- 1. 语义路由决策表
      CREATE TABLE IF NOT EXISTS cluster_routes (
        route_id VARCHAR(64) PRIMARY KEY,
        task_id VARCHAR(64) REFERENCES cluster_tasks(task_id) ON DELETE SET NULL,
        user_request TEXT NOT NULL,
        intent JSONB NOT NULL DEFAULT '{}'::jsonb,
        decision_type VARCHAR(32) NOT NULL,
        selected_node_id VARCHAR(64),
        selected_project_id VARCHAR(128),
        reason TEXT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'created',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cluster_routes_task ON cluster_routes(task_id);
      CREATE INDEX IF NOT EXISTS idx_cluster_routes_status ON cluster_routes(status);

      -- 2. 路由候选快照表
      CREATE TABLE IF NOT EXISTS cluster_route_candidates (
        id BIGSERIAL PRIMARY KEY,
        route_id VARCHAR(64) NOT NULL REFERENCES cluster_routes(route_id) ON DELETE CASCADE,
        node_id VARCHAR(64) NOT NULL,
        project_id VARCHAR(128) NOT NULL,
        project_name VARCHAR(128) NOT NULL,
        score DOUBLE PRECISION NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        hard_constraints_satisfied BOOLEAN NOT NULL,
        unsatisfied_constraints JSONB NOT NULL DEFAULT '[]'::jsonb,
        evidences JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_route_cand_route ON cluster_route_candidates(route_id);

      -- 3. 路由事件审计表
      CREATE TABLE IF NOT EXISTS cluster_route_events (
        id BIGSERIAL PRIMARY KEY,
        route_id VARCHAR(64) NOT NULL REFERENCES cluster_routes(route_id) ON DELETE CASCADE,
        event_type VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_route_events_route ON cluster_route_events(route_id);

      -- 4. 重新规划审计表
      CREATE TABLE IF NOT EXISTS cluster_route_replans (
        replan_id VARCHAR(64) PRIMARY KEY,
        route_id VARCHAR(64) NOT NULL,
        task_id VARCHAR(64) NOT NULL,
        original_run_id VARCHAR(64) NOT NULL,
        trigger VARCHAR(64) NOT NULL,
        trigger_details TEXT NOT NULL,
        original_node_id VARCHAR(64) NOT NULL,
        original_project_id VARCHAR(128) NOT NULL,
        new_node_id VARCHAR(64),
        new_project_id VARCHAR(128),
        status VARCHAR(32) NOT NULL,
        outcome_unknown_reason TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_route_replans_task ON cluster_route_replans(task_id);
    `,
  },
  {
    version: 4,
    name: "004_distributed_taskgraph_and_a2a",
    sql: `
      -- 1. 分布式任务图元数据与生命周期表
      CREATE TABLE IF NOT EXISTS cluster_graphs (
        graph_id VARCHAR(64) PRIMARY KEY,
        parent_goal TEXT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'planning',
        revision INT NOT NULL DEFAULT 1,
        planner_session_id VARCHAR(64),
        budget JSONB NOT NULL DEFAULT '{}'::jsonb,
        concurrency_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        final_summary TEXT,
        error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        completed_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_cluster_graphs_status ON cluster_graphs(status);
      CREATE INDEX IF NOT EXISTS idx_cluster_graphs_updated ON cluster_graphs(updated_at DESC);

      -- 2. 分布式任务图子任务节点表
      CREATE TABLE IF NOT EXISTS cluster_graph_nodes (
        graph_id VARCHAR(64) NOT NULL REFERENCES cluster_graphs(graph_id) ON DELETE CASCADE,
        node_id VARCHAR(64) NOT NULL,
        task_id VARCHAR(64) REFERENCES cluster_tasks(task_id) ON DELETE SET NULL,
        title VARCHAR(256) NOT NULL,
        goal TEXT NOT NULL,
        operation VARCHAR(64) NOT NULL DEFAULT 'execute',
        assigned_node_id VARCHAR(64),
        assigned_project_id VARCHAR(128),
        required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
        required_artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
        produced_artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
        acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        failure_policy VARCHAR(32) NOT NULL DEFAULT 'block_dependents',
        retry_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        attempt_count INT NOT NULL DEFAULT 0,
        worker_run_id VARCHAR(64),
        result_summary TEXT,
        error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        started_at BIGINT,
        completed_at BIGINT,
        PRIMARY KEY (graph_id, node_id)
      );

      CREATE INDEX IF NOT EXISTS idx_graph_nodes_status ON cluster_graph_nodes(status);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_task ON cluster_graph_nodes(task_id);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_assigned_node ON cluster_graph_nodes(assigned_node_id);

      -- 3. 分布式依赖有向边表
      CREATE TABLE IF NOT EXISTS cluster_graph_edges (
        edge_id VARCHAR(64) PRIMARY KEY,
        graph_id VARCHAR(64) NOT NULL REFERENCES cluster_graphs(graph_id) ON DELETE CASCADE,
        from_node_id VARCHAR(64) NOT NULL,
        to_node_id VARCHAR(64) NOT NULL,
        dependency_type VARCHAR(32) NOT NULL DEFAULT 'success',
        required_outcome VARCHAR(32) DEFAULT 'completed',
        artifact_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at BIGINT NOT NULL,
        CONSTRAINT uq_graph_edge UNIQUE (graph_id, from_node_id, to_node_id)
      );

      CREATE INDEX IF NOT EXISTS idx_graph_edges_graph ON cluster_graph_edges(graph_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON cluster_graph_edges(graph_id, to_node_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON cluster_graph_edges(graph_id, from_node_id);

      -- 4. 任务图动态版本与变更审计表
      CREATE TABLE IF NOT EXISTS cluster_graph_revisions (
        id BIGSERIAL PRIMARY KEY,
        graph_id VARCHAR(64) NOT NULL REFERENCES cluster_graphs(graph_id) ON DELETE CASCADE,
        revision INT NOT NULL,
        reason TEXT NOT NULL,
        diff_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_graph_revisions_graph ON cluster_graph_revisions(graph_id, revision);

      -- 5. 图级别单调递增事件流表
      CREATE TABLE IF NOT EXISTS cluster_graph_events (
        id BIGSERIAL PRIMARY KEY,
        graph_id VARCHAR(64) NOT NULL REFERENCES cluster_graphs(graph_id) ON DELETE CASCADE,
        seq INT NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at BIGINT NOT NULL,
        CONSTRAINT uq_graph_events_seq UNIQUE (graph_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_graph_events_graph_seq ON cluster_graph_events(graph_id, seq);

      -- 6. 确定性结果验收审计表
      CREATE TABLE IF NOT EXISTS cluster_graph_verifications (
        id BIGSERIAL PRIMARY KEY,
        graph_id VARCHAR(64) NOT NULL REFERENCES cluster_graphs(graph_id) ON DELETE CASCADE,
        graph_node_id VARCHAR(64) NOT NULL,
        verification_type VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL,
        evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        message TEXT,
        verified_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_graph_verifications_node ON cluster_graph_verifications(graph_id, graph_node_id);

      -- 7. 跨节点分布式 Agent 消息邮箱表
      CREATE TABLE IF NOT EXISTS cluster_agent_mailbox (
        message_id VARCHAR(64) PRIMARY KEY,
        graph_id VARCHAR(64) NOT NULL REFERENCES cluster_graphs(graph_id) ON DELETE CASCADE,
        source_node_id VARCHAR(64) NOT NULL,
        source_agent_id VARCHAR(64) NOT NULL,
        source_task_id VARCHAR(64),
        target_node_id VARCHAR(64) NOT NULL,
        target_agent_id VARCHAR(64) NOT NULL,
        target_task_id VARCHAR(64),
        message_type VARCHAR(64) NOT NULL DEFAULT 'agent.message',
        correlation_id VARCHAR(64),
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        delivery_status VARCHAR(32) NOT NULL DEFAULT 'pending',
        sent_at BIGINT NOT NULL,
        delivered_at BIGINT,
        acknowledged_at BIGINT,
        expires_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_mailbox_target ON cluster_agent_mailbox(target_node_id, target_agent_id, delivery_status);
      CREATE INDEX IF NOT EXISTS idx_agent_mailbox_graph ON cluster_agent_mailbox(graph_id);

      -- 8. 跨节点产物元数据与物理位置表
      CREATE TABLE IF NOT EXISTS cluster_artifacts (
        artifact_id VARCHAR(64) PRIMARY KEY,
        graph_id VARCHAR(64) NOT NULL REFERENCES cluster_graphs(graph_id) ON DELETE CASCADE,
        producer_task_id VARCHAR(64),
        producer_node_id VARCHAR(64) NOT NULL,
        name VARCHAR(256) NOT NULL,
        content_type VARCHAR(128) NOT NULL DEFAULT 'text/plain',
        size_bytes BIGINT NOT NULL DEFAULT 0,
        sha256 VARCHAR(64) NOT NULL,
        storage_path TEXT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at BIGINT NOT NULL,
        expires_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_cluster_artifacts_graph ON cluster_artifacts(graph_id);
      CREATE INDEX IF NOT EXISTS idx_cluster_artifacts_status ON cluster_artifacts(status);

      -- 9. 产物访问授权表
      CREATE TABLE IF NOT EXISTS cluster_artifact_grants (
        id BIGSERIAL PRIMARY KEY,
        artifact_id VARCHAR(64) NOT NULL REFERENCES cluster_artifacts(artifact_id) ON DELETE CASCADE,
        graph_id VARCHAR(64) NOT NULL REFERENCES cluster_graphs(graph_id) ON DELETE CASCADE,
        consumer_node_id VARCHAR(64) NOT NULL,
        consumer_task_id VARCHAR(64),
        granted_at BIGINT NOT NULL,
        CONSTRAINT uq_artifact_grant UNIQUE (artifact_id, consumer_node_id, consumer_task_id)
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_grants_consumer ON cluster_artifact_grants(consumer_node_id, consumer_task_id);

      -- 10. 任务图全局控制指令表
      CREATE TABLE IF NOT EXISTS cluster_graph_controls (
        control_id VARCHAR(64) PRIMARY KEY,
        graph_id VARCHAR(64) NOT NULL REFERENCES cluster_graphs(graph_id) ON DELETE CASCADE,
        action VARCHAR(32) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        issued_at BIGINT NOT NULL,
        executed_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_graph_controls_graph ON cluster_graph_controls(graph_id, status);
    `,
  },
  {
    version: 5,
    name: "005_web_control_plane_and_sessions",
    sql: `
      -- 1. Web 交互会话表 (用于 Workspace / Chat 跨设备持久化)
      CREATE TABLE IF NOT EXISTS cluster_web_conversations (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(256) NOT NULL,
        linked_task_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        linked_graph_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        messages JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_web_conversations_updated ON cluster_web_conversations(updated_at DESC);

      -- 2. Web 认证 Session 表 (安全 HttpOnly Cookie + CSRF 防护)
      CREATE TABLE IF NOT EXISTS cluster_web_sessions (
        session_id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        username VARCHAR(64) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'admin',
        csrf_token VARCHAR(64) NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON cluster_web_sessions(expires_at);
    `,
  },
  {
    version: 6,
    name: "006_task_execution_identity",
    sql: `ALTER TABLE cluster_tasks ADD COLUMN IF NOT EXISTS run_id VARCHAR(64);
          ALTER TABLE cluster_tasks ADD COLUMN IF NOT EXISTS timeout_ms BIGINT;
          ALTER TABLE cluster_tasks ADD COLUMN IF NOT EXISTS dispatch_options JSONB;`,
  },
  {
    version: 7,
    name: "007_outbox_delivery_identity",
    sql: `DELETE FROM cluster_outbox WHERE id IN (
            SELECT id FROM (SELECT id, row_number() OVER (
              PARTITION BY message_id ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END, id
            ) AS position FROM cluster_outbox) duplicates WHERE position > 1
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_cluster_outbox_delivery ON cluster_outbox(message_id);`,
  },
  {
    version: 8,
    name: "008_web_conversation_title_management",
    sql: `ALTER TABLE cluster_web_conversations ADD COLUMN IF NOT EXISTS title_source VARCHAR(32) DEFAULT 'default';
          ALTER TABLE cluster_web_conversations ADD COLUMN IF NOT EXISTS title_revision INT DEFAULT 0;`,
  },
  {
    version: 9,
    name: "009_scheduled_tasks_and_security_audit",
    sql: `
      -- 1. 持久化定时任务定义表
      CREATE TABLE IF NOT EXISTS cluster_scheduled_tasks (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(256) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled BOOLEAN NOT NULL DEFAULT true,
        trigger_type VARCHAR(32) NOT NULL, -- 'cron' | 'interval' | 'once'
        cron_expression VARCHAR(128),
        interval_ms BIGINT,
        run_at BIGINT,
        timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
        target_type VARCHAR(32) NOT NULL, -- 'single_task' | 'graph'
        task_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        graph_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        concurrency_policy VARCHAR(32) NOT NULL DEFAULT 'SKIP_IF_RUNNING', -- 'SKIP_IF_RUNNING' | 'QUEUE' | 'ALLOW_CONCURRENT'
        misfire_policy VARCHAR(32) NOT NULL DEFAULT 'RUN_ONCE_IMMEDIATELY', -- 'RUN_ONCE_IMMEDIATELY' | 'SKIP_MISFIRE' | 'CATCH_UP'
        max_concurrency INT NOT NULL DEFAULT 1,
        last_run_at BIGINT,
        last_run_status VARCHAR(32),
        next_run_at BIGINT,
        run_count INT NOT NULL DEFAULT 0,
        created_by VARCHAR(64) NOT NULL DEFAULT 'coordinator',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sched_tasks_next_run ON cluster_scheduled_tasks(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_sched_tasks_enabled ON cluster_scheduled_tasks(enabled);
      CREATE INDEX IF NOT EXISTS idx_sched_tasks_updated ON cluster_scheduled_tasks(updated_at DESC);

      -- 2. 调度执行历史记录表
      CREATE TABLE IF NOT EXISTS cluster_scheduled_task_runs (
        id VARCHAR(64) PRIMARY KEY,
        scheduled_task_id VARCHAR(64) NOT NULL REFERENCES cluster_scheduled_tasks(id) ON DELETE CASCADE,
        target_type VARCHAR(32) NOT NULL,
        task_id VARCHAR(64) REFERENCES cluster_tasks(task_id) ON DELETE SET NULL,
        graph_id VARCHAR(64) REFERENCES cluster_graphs(graph_id) ON DELETE SET NULL,
        trigger_time BIGINT NOT NULL,
        started_at BIGINT NOT NULL,
        completed_at BIGINT,
        status VARCHAR(32) NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'failed' | 'skipped'
        skip_reason VARCHAR(128),
        error TEXT,
        result_summary TEXT,
        metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sched_runs_task ON cluster_scheduled_task_runs(scheduled_task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sched_runs_status ON cluster_scheduled_task_runs(status);
      CREATE INDEX IF NOT EXISTS idx_sched_runs_task_id ON cluster_scheduled_task_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_sched_runs_graph_id ON cluster_scheduled_task_runs(graph_id);

      -- 3. 安全决策审计历史表
      CREATE TABLE IF NOT EXISTS cluster_security_audits (
        id VARCHAR(64) PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        tool_name VARCHAR(64) NOT NULL,
        args_fingerprint VARCHAR(64) NOT NULL,
        sanitized_args JSONB NOT NULL DEFAULT '{}'::jsonb,
        raw_args_snippet TEXT NOT NULL DEFAULT '',
        decision_source VARCHAR(32) NOT NULL, -- 'LLM_MONITOR' | 'DETERMINISTIC_POLICY' | 'USER_APPROVAL' | 'SYSTEM_FAILURE'
        verdict VARCHAR(32) NOT NULL, -- 'ALLOW' | 'BLOCK' | 'REQUIRE_APPROVAL'
        severity INT NOT NULL DEFAULT 0,
        risk_category VARCHAR(64) NOT NULL DEFAULT 'Routine Operation',
        rule_name VARCHAR(128),
        reason TEXT NOT NULL,
        decision_evidence TEXT,
        agent_id VARCHAR(64) NOT NULL DEFAULT 'main',
        node_id VARCHAR(64),
        project_id VARCHAR(128),
        task_id VARCHAR(64),
        run_id VARCHAR(64),
        duration_ms INT NOT NULL DEFAULT 0,
        is_hard_block BOOLEAN NOT NULL DEFAULT false,
        tokens_used JSONB DEFAULT '{}'::jsonb,
        model_version VARCHAR(64),
        review_feedback JSONB NOT NULL DEFAULT '{"status":"unreviewed"}'::jsonb,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sec_audit_timestamp ON cluster_security_audits(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_sec_audit_verdict ON cluster_security_audits(verdict);
      CREATE INDEX IF NOT EXISTS idx_sec_audit_source ON cluster_security_audits(decision_source);
      CREATE INDEX IF NOT EXISTS idx_sec_audit_category ON cluster_security_audits(risk_category);
      CREATE INDEX IF NOT EXISTS idx_sec_audit_task ON cluster_security_audits(task_id);
      CREATE INDEX IF NOT EXISTS idx_sec_audit_fingerprint ON cluster_security_audits(args_fingerprint);
    `,
  },
  {
    version: 10,
    name: "graph_patch_operations",
    sql: `CREATE TABLE IF NOT EXISTS cluster_graph_patch_operations (
      graph_id VARCHAR(64) NOT NULL REFERENCES cluster_graphs(graph_id) ON DELETE CASCADE,
      operation_id VARCHAR(128) NOT NULL,
      request_sha256 CHAR(64) NOT NULL,
      result JSONB NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (graph_id, operation_id)
    );`,
  },
  { version: 11, name: "graph_planning_provenance", sql: `ALTER TABLE cluster_graphs ADD COLUMN IF NOT EXISTS strategy_decision JSONB;` },
  { version: 12, name: "runtime_model_usage", sql: `
    CREATE TABLE IF NOT EXISTS cluster_runtime_spans (span_id VARCHAR(128) PRIMARY KEY, trace_id VARCHAR(128) NOT NULL, started_at BIGINT NOT NULL, payload JSONB NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_runtime_span_trace ON cluster_runtime_spans(trace_id,started_at,span_id);
    CREATE TABLE IF NOT EXISTS cluster_model_usage (
      accounting_id VARCHAR(160) PRIMARY KEY,
      trace_id VARCHAR(128), graph_id VARCHAR(64), conversation_id VARCHAR(64),
      task_id VARCHAR(64), agent_id VARCHAR(128), node_id VARCHAR(64),
      started_at BIGINT NOT NULL, status VARCHAR(32) NOT NULL, payload JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_usage_trace ON cluster_model_usage(trace_id, started_at, accounting_id);
    CREATE INDEX IF NOT EXISTS idx_model_usage_graph ON cluster_model_usage(graph_id, started_at, accounting_id);
    CREATE INDEX IF NOT EXISTS idx_model_usage_conversation ON cluster_model_usage(conversation_id, started_at, accounting_id);
    CREATE INDEX IF NOT EXISTS idx_model_usage_retention ON cluster_model_usage(started_at);
  ` },
  { version: 13, name: "telemetry_indices_and_retention", sql: `
    CREATE INDEX IF NOT EXISTS idx_runtime_span_phase ON cluster_runtime_spans((payload->>'phase'));
    CREATE INDEX IF NOT EXISTS idx_runtime_span_task ON cluster_runtime_spans((payload->>'taskId'));
    CREATE INDEX IF NOT EXISTS idx_runtime_span_graph ON cluster_runtime_spans((payload->>'graphId'));
    CREATE INDEX IF NOT EXISTS idx_model_usage_status ON cluster_model_usage(started_at, status);
  ` },
  { version: 14, name: "goal_runs", sql: `
    CREATE TABLE IF NOT EXISTS cluster_goal_runs (
      goal_run_id VARCHAR(64) PRIMARY KEY,
      conversation_id VARCHAR(64) NOT NULL REFERENCES cluster_web_conversations(id) ON DELETE CASCADE,
      user_message_id VARCHAR(64) NOT NULL,
      revision INTEGER NOT NULL,
      created_at BIGINT NOT NULL,
      payload JSONB NOT NULL,
      UNIQUE (conversation_id, user_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_runs_conversation ON cluster_goal_runs(conversation_id, created_at DESC);
  ` },
  {
    version: 15,
    name: "task_security_grants",
    sql: `
      -- 任务级安全授权 (Task Security Grant) 与审批决策溯源。
      -- 必须作为独立迁移：已升级到 v1 的既有部署不会重跑 v1 的 CREATE TABLE。
      ALTER TABLE cluster_approvals ADD COLUMN IF NOT EXISTS grant_id VARCHAR(64);

      CREATE TABLE IF NOT EXISTS cluster_task_grants (
        grant_id VARCHAR(64) PRIMARY KEY,
        approval_id VARCHAR(64) NOT NULL,
        node_id VARCHAR(64) NOT NULL,
        task_id VARCHAR(64) NOT NULL REFERENCES cluster_tasks(task_id) ON DELETE CASCADE,
        run_id VARCHAR(64) NOT NULL,
        authorization_mode VARCHAR(32) NOT NULL,
        original_policy JSONB NOT NULL,
        target_policy JSONB NOT NULL,
        authorized_by VARCHAR(64) NOT NULL,
        granted_at BIGINT NOT NULL,
        effective_at BIGINT,
        worker_ack_at BIGINT,
        revoked_at BIGINT,
        expired_at BIGINT,
        status VARCHAR(32) NOT NULL,
        configuration_version INT NOT NULL,
        revoked_by VARCHAR(64),
        last_error TEXT,
        reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE
      );

      -- 同一审批同一时刻最多只有一个「生效中」的授权：并发重复授权由部分唯一索引兜底。
      -- 已结束（revoked / expired）的授权保留审计记录，并允许管理员在同一审批上重试。
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cluster_task_grants_approval_active
        ON cluster_task_grants(approval_id)
        WHERE status IN ('granted', 'applied', 'revocation_pending');
      CREATE INDEX IF NOT EXISTS idx_cluster_task_grants_task_run ON cluster_task_grants(task_id, run_id);
      CREATE INDEX IF NOT EXISTS idx_cluster_task_grants_node ON cluster_task_grants(node_id);
      CREATE INDEX IF NOT EXISTS idx_cluster_task_grants_status ON cluster_task_grants(status);
    `,
  },
];

// 常量与迁移表必须始终一致：新增迁移却忘记提升常量时，立即在模块加载期暴露，
// 避免「守卫按旧的最高版本判断」而放行未知 schema。
const highestMigrationVersion = CLUSTER_MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0
);
if (highestMigrationVersion !== LATEST_CLUSTER_SCHEMA_VERSION) {
  throw new Error(
    `[ClusterMigrations] LATEST_CLUSTER_SCHEMA_VERSION (${LATEST_CLUSTER_SCHEMA_VERSION}) 与迁移表最高版本 (${highestMigrationVersion}) 不一致`
  );
}
