/**
 * Unified API Client for Nash Web Control Plane
 * 支持 Cookie 凭据传递、CSRF 自动注入、统一错误处理与请求取消
 */

export interface ApiResponse<T = any> {
  data: T;
  status: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly data?: any
  ) {
    super(message);
    this.name = "ApiError";
  }
}

class ApiClient {
  private csrfToken: string | null = null;
  private unauthorizedHandler?: () => void;

  setUnauthorizedHandler(handler: () => void) { this.unauthorizedHandler = handler; }

  setCsrfToken(token: string | null) {
    this.csrfToken = token;
  }

  getCsrfToken(): string | null {
    return this.csrfToken;
  }

  async request<T = any>(
    path: string,
    options: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
      params?: Record<string, string | number | boolean | undefined>;
      signal?: AbortSignal;
    } = {}
  ): Promise<T> {
    let url = path;
    if (options.params) {
      const searchParams = new URLSearchParams();
      for (const [key, val] of Object.entries(options.params)) {
        if (val !== undefined) {
          searchParams.append(key, String(val));
        }
      }
      const qs = searchParams.toString();
      if (qs) {
        url += (url.includes("?") ? "&" : "?") + qs;
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
    };

    if (options.body && !(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    // 为写操作自动携带 CSRF Token
    const method = (options.method || "GET").toUpperCase();
    if (this.csrfToken && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers["X-CSRF-Token"] = this.csrfToken;
    }

    const res = await fetch(url, {
      method,
      headers,
      credentials: "include", // 关键：自动携带 HttpOnly Cookie
      body:
        options.body && !(options.body instanceof FormData)
          ? JSON.stringify(options.body)
          : options.body,
      signal: options.signal,
    });

    if (res.status === 204) {
      return {} as T;
    }

    let json: any = {};
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      if (res.status === 401 && path !== "/api/auth/login") this.unauthorizedHandler?.();
      if (res.status === 429) json.retryAfter = Number(res.headers.get("Retry-After")) || undefined;
      throw new ApiError(json.error || `HTTP ${res.status}: ${res.statusText}`, res.status, json);
    }

    return json as T;
  }

  // 认证
  async login(username: string, password: string) {
    const res = await this.request<{ success: boolean; user: any; csrfToken: string }>("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    if (res.csrfToken) {
      this.setCsrfToken(res.csrfToken);
    }
    return res;
  }

  async logout() {
    const res = await this.request<{ success: boolean }>("/api/auth/logout", {
      method: "POST",
    });
    this.setCsrfToken(null);
    return res;
  }

  async getMe() {
    const res = await this.request<{ authenticated: boolean; user: any; csrfToken?: string }>("/api/auth/me");
    if (res.csrfToken) {
      this.setCsrfToken(res.csrfToken);
    }
    return res;
  }

  // 集群状态与节点
  async getClusterStatus() {
    return this.request<{
      status: string;
      coordinatorNodeId: string;
      totalNodes: number;
      onlineNodes: number;
      totalTasks: number;
      runningTasks: number;
      pendingApprovals: number;
      timestamp: number;
    }>("/api/cluster/status");
  }

  async getNodes() {
    return this.request<{ nodes: any[] }>("/api/cluster/nodes");
  }

  // 任务
  async listTasks(params?: { nodeId?: string; status?: string; limit?: number }) {
    return this.request<{ tasks: any[] }>("/api/cluster/tasks", { params });
  }

  async getTask(taskId: string) {
    return this.request<{ task: any }>(`/api/cluster/tasks/${taskId}`);
  }

  async getTaskEvents(taskId: string, fromSeq = 0) {
    return this.request<{ events: any[] }>(`/api/cluster/tasks/${taskId}/events`, {
      params: { fromSeq },
    });
  }

  async steerTask(taskId: string, steerContent: string) {
    return this.request(`/api/cluster/tasks/${taskId}/steer`, {
      method: "POST",
      body: { content: steerContent, steerContent },
    });
  }

  async interruptTask(taskId: string) {
    return this.request(`/api/cluster/tasks/${taskId}/interrupt`, {
      method: "POST",
    });
  }

  async cancelTask(taskId: string, reason?: string) {
    return this.request(`/api/cluster/tasks/${taskId}/cancel`, {
      method: "POST",
      body: { reason },
    });
  }

  // 任务图 (TaskGraph)
  async listGraphs(params?: { status?: string; limit?: number }) {
    return this.request<{ graphs: any[] }>("/api/cluster/graphs", { params });
  }

  async getGraph(graphId: string) {
    return this.request<{
      graph: any;
      snapshot: any;
      nodes: any[];
      edges: any[];
      revisions: any[];
      provenance?: any;
      verifications?: any[];
      artifacts?: any[];
      events?: any[];
      goalEvaluation?: any;
    }>(`/api/cluster/graphs/${graphId}`);
  }

  async planGraph(goal: string, budget?: any) {
    return this.request<{ proposal: any; validation: any }>("/api/cluster/graphs/plan", {
      method: "POST",
      body: { goal, budget },
    });
  }

  async runGraph(goal: string, budget?: any) {
    return this.request<any>("/api/cluster/graphs/run", {
      method: "POST",
      body: { goal, budget },
    });
  }

  async steerGraph(graphId: string, instruction: string) {
    return this.request(`/api/cluster/graphs/${graphId}/steer`, {
      method: "POST",
      body: { instruction },
    });
  }

  async pauseGraph(graphId: string) {
    return this.request(`/api/cluster/graphs/${graphId}/pause`, { method: "POST" });
  }

  async resumeGraph(graphId: string) {
    return this.request(`/api/cluster/graphs/${graphId}/resume`, { method: "POST" });
  }

  async cancelGraph(graphId: string, reason?: string) {
    return this.request(`/api/cluster/graphs/${graphId}/cancel`, {
      method: "POST",
      body: { reason },
    });
  }

  async replanGraph(graphId: string, reason?: string, failedNodeId?: string) {
    return this.request(`/api/cluster/graphs/${graphId}/replan`, {
      method: "POST",
      body: { reason, failedNodeId },
    });
  }

  // 交互会话
  async listConversations(limit = 50) {
    return this.request<{ conversations: any[] }>("/api/cluster/conversations", {
      params: { limit },
    });
  }

  async createConversation(title?: string, initialPrompt?: string) {
    return this.request<{ conversation: any }>("/api/cluster/conversations", {
      method: "POST",
      body: { title, initialPrompt },
    });
  }

  async getConversation(id: string) {
    return this.request<{ conversation: any }>(`/api/cluster/conversations/${id}`);
  }

  async updateConversation(id: string, title: string, titleSource?: string) {
    return this.request<{ conversation: any }>(`/api/cluster/conversations/${id}`, {
      method: "PATCH",
      body: { title, titleSource },
    });
  }

  async generateConversationTitle(id: string) {
    return this.request<{ title: string; model: string }>(`/api/cluster/conversations/${id}/generate-title`, {
      method: "POST",
    });
  }

  async optimizePrompt(text: string, conversationId?: string, signal?: AbortSignal) {
    return this.request<{
      optimizedText: string;
      model: string;
      durationMs: number;
    }>("/api/ai/optimize-prompt", {
      method: "POST",
      body: { text, conversationId },
      signal,
    });
  }

  async deleteConversation(id: string) {
    return this.request<{ success: boolean }>(`/api/cluster/conversations/${id}`, {
      method: "DELETE",
    });
  }

  async sendConversationMessage(id: string, content: string, selection?: { optionId: string }) {
    return this.request<{
      userMessage: any;
      assistantMessage: any;
      taskId?: string;
      graphId?: string;
      conversation: any;
    }>(`/api/cluster/conversations/${id}/messages`, {
      method: "POST",
      body: { content, selection },
    });
  }

  async cancelConversation(id: string) {
    return this.request<{ success: boolean; cancelled: boolean; message: string }>(
      `/api/cluster/conversations/${id}/cancel`,
      { method: "POST" }
    );
  }

  async interruptConversation(id: string) {
    return this.request<{ success: boolean; interrupted: boolean; message: string }>(
      `/api/cluster/conversations/${id}/interrupt`,
      { method: "POST" }
    );
  }

  // 审批
  async listApprovals() {
    return this.request<{ approvals: any[]; history?: any[] }>("/api/cluster/approvals");
  }

  async resolveApproval(approvalId: string, decision: "allow-once" | "deny" | "grant-task-full-access") {
    return this.request(`/api/cluster/approvals/${approvalId}/resolve`, {
      method: "POST",
      body: { decision },
    });
  }

  async grantTaskFullAccess(approvalId: string) {
    return this.request<{ success: boolean; grantId: string; applied: boolean; targetPolicy: any; message: string }>(
      `/api/cluster/approvals/${approvalId}/grant-full-access`,
      {
        method: "POST",
        body: {},
      }
    );
  }

  async revokeTaskGrant(taskId: string, options: { grantId?: string; reason?: string } = {}) {
    return this.request<{ success: boolean; confirmed: boolean; grantId: string; status: string; message: string }>(
      `/api/cluster/tasks/${encodeURIComponent(taskId)}/revoke-grant`,
      { method: "POST", body: options }
    );
  }

  // 产物
  async listArtifacts(graphId?: string) {
    return this.request<{ artifacts: any[] }>("/api/cluster/artifacts", {
      params: { graphId },
    });
  }

  async getArtifact(artifactId: string) {
    return this.request<{ artifact: any }>(`/api/cluster/artifacts/${artifactId}`);
  }

  async getArtifactContent(artifactId: string) {
    return this.request<{
      artifactId: string;
      name: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
      content: string;
      truncated: boolean;
    }>(`/api/cluster/artifacts/${artifactId}/content`);
  }

  getArtifactDownloadUrl(artifactId: string): string {
    return `/api/cluster/artifacts/${artifactId}/download`;
  }

  // 目录与记忆检索
  async searchCatalog(query: string, deep = false, topK = 10) {
    return this.request("/api/cluster/catalog/search", {
      method: "POST",
      body: { query, deep, topK },
    });
  }

  async listMemory() {
    return this.request<{ entries: import("./memory-presentation.js").MemoryRecord[] }>("/api/cluster/memory/index");
  }

  async searchMemory(query: string, nodeId?: string, projectId?: string, topK = 10) {
    return this.request<{ results: import("./memory-presentation.js").MemoryRecord[] }>("/api/cluster/memory/search", {
      method: "POST",
      body: { query, nodeId, projectId, topK },
    });
  }

  async getCatalogProjects(nodeId?: string) {
    return this.request<{ projects: any[] }>("/api/cluster/catalog/projects", {
      params: { nodeId },
    });
  }

  async getProjectDetails(projectId: string, nodeId?: string) {
    return this.request<{
      project: any;
      node?: any;
      memory: any[];
      skills: any[];
      mcp: any[];
      tasks: any[];
    }>(`/api/cluster/projects/${encodeURIComponent(projectId)}`, {
      params: nodeId ? { nodeId } : undefined,
    });
  }

  async getCatalogSkills(nodeId?: string) {
    return this.request<{ skills: any[] }>("/api/cluster/catalog/skills", {
      params: { nodeId },
    });
  }

  async getCatalogMCP(nodeId?: string) {
    return this.request<{ mcp: any[] }>("/api/cluster/catalog/mcp", {
      params: { nodeId },
    });
  }

  // ==========================================
  // Scheduled Tasks API (Phase 5)
  // ==========================================

  async listScheduledTasks(filter?: { enabled?: boolean; targetType?: string; limit?: number; offset?: number }) {
    return this.request<{ tasks: any[]; total: number }>("/api/cluster/scheduled-tasks", {
      params: filter,
    });
  }

  async getScheduledTask(id: string) {
    return this.request<any>(`/api/cluster/scheduled-tasks/${id}`);
  }

  async createScheduledTask(task: any) {
    return this.request<any>("/api/cluster/scheduled-tasks", {
      method: "POST",
      body: task,
    });
  }

  async updateScheduledTask(id: string, patch: any) {
    return this.request<any>(`/api/cluster/scheduled-tasks/${id}`, {
      method: "PATCH",
      body: patch,
    });
  }

  async deleteScheduledTask(id: string) {
    return this.request<{ success: boolean; id: string }>(`/api/cluster/scheduled-tasks/${id}`, {
      method: "DELETE",
    });
  }

  async pauseScheduledTask(id: string) {
    return this.request<any>(`/api/cluster/scheduled-tasks/${id}/pause`, {
      method: "POST",
    });
  }

  async resumeScheduledTask(id: string) {
    return this.request<any>(`/api/cluster/scheduled-tasks/${id}/resume`, {
      method: "POST",
    });
  }

  async runScheduledTaskNow(id: string, force = false) {
    return this.request<{ success: boolean; run: any }>(`/api/cluster/scheduled-tasks/${id}/run`, {
      method: "POST",
      body: { force },
    });
  }

  async getScheduledTaskHistory(id: string, filter?: { status?: string; limit?: number; offset?: number }) {
    return this.request<{ runs: any[]; total: number }>(`/api/cluster/scheduled-tasks/${id}/history`, {
      params: filter,
    });
  }

  // ==========================================
  // Security Decision Audit API (Phase 5)
  // ==========================================

  async listSecurityAudits(filter?: {
    verdict?: string;
    decisionSource?: string;
    riskCategory?: string;
    reviewStatus?: string;
    taskId?: string;
    nodeId?: string;
    from?: number;
    to?: number;
    limit?: number;
    offset?: number;
  }) {
    return this.request<{ items: any[]; total: number }>("/api/cluster/security/audits", {
      params: filter,
    });
  }

  async getSecurityAudit(id: string) {
    return this.request<any>(`/api/cluster/security/audits/${id}`);
  }

  async submitSecurityAuditFeedback(id: string, feedback: { status: string; comment?: string; reviewedBy?: string }) {
    return this.request<{ success: boolean; audit: any; warning?: string; hardBlockEnforced?: boolean }>(
      `/api/cluster/security/audits/${id}/feedback`,
      {
        method: "POST",
        body: feedback,
      }
    );
  }

  async getSecurityAuditStats(windowMs?: number) {
    return this.request<{
      totalCount: number;
      allowCount: number;
      blockCount: number;
      requireApprovalCount: number;
      sourceCounts: Record<string, number>;
      falsePositiveCount: number;
      topRiskCategories: Array<{ category: string; count: number }>;
    }>("/api/cluster/security/stats", {
      params: windowMs ? { windowMs } : undefined,
    });
  }
}

export const api = new ApiClient();
