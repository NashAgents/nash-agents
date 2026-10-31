import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/auth";

const routes = [
  {
    path: "/login",
    name: "Login",
    component: () => import("../views/LoginView.vue"),
    meta: { public: true },
  },
  {
    path: "/",
    name: "Workspace",
    component: () => import("../views/WorkspaceView.vue"),
  },
  { path: "/dashboard", name: "Dashboard", component: () => import("../views/DashboardView.vue") },
  { path: "/models", name: "Models", component: () => import("../views/ModelsView.vue") },
  { path: "/security", name: "SecuritySettings", component: () => import("../views/SecuritySettingsView.vue") },
  { path: "/diagnostics", name: "Diagnostics", component: () => import("../views/DiagnosticsView.vue") },
  {
    path: "/tasks",
    name: "Tasks",
    component: () => import("../views/TasksView.vue"),
  },
  {
    path: "/tasks/:id",
    name: "TaskDetail",
    component: () => import("../views/TaskDetailView.vue"),
  },
  {
    path: "/graphs",
    name: "Graphs",
    component: () => import("../views/TaskGraphView.vue"),
  },
  {
    path: "/graphs/:id",
    name: "GraphDetail",
    component: () => import("../views/TaskGraphView.vue"),
  },
  {
    path: "/schedules",
    alias: ["/scheduled-tasks"],
    name: "Schedules",
    component: () => import("../views/ScheduledTasksView.vue"),
  },
  {
    path: "/cluster",
    name: "Cluster",
    component: () => import("../views/ClusterView.vue"),
  },
  {
    path: "/projects",
    name: "Projects",
    component: () => import("../views/ProjectsView.vue"),
  },
  {
    path: "/projects/:projectId",
    name: "ProjectDetail",
    component: () => import("../views/ProjectDetailView.vue"),
  },
  {
    path: "/memory",
    name: "Memory",
    component: () => import("../views/MemoryView.vue"),
  },
  {
    path: "/approvals",
    name: "Approvals",
    component: () => import("../views/ApprovalsView.vue"),
  },
  {
    path: "/security/audit",
    alias: ["/security/decisions"],
    name: "SecurityAudit",
    component: () => import("../views/SecurityAuditView.vue"),
  },
  {
    path: "/artifacts",
    name: "Artifacts",
    component: () => import("../views/ArtifactsView.vue"),
  },
  {
    path: "/settings",
    name: "Settings",
    component: () => import("../views/SettingsView.vue"),
  },
  {
    path: "/:pathMatch(.*)*",
    redirect: "/",
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to, _from, next) => {
  const authStore = useAuthStore();
  if (!authStore.initialized) {
    await authStore.checkAuth();
  }

  if (to.meta.public) {
    if (authStore.isAuthenticated) {
      next("/");
      return;
    }
    next();
    return;
  }

  if (!authStore.isAuthenticated) {
    next({ path: "/login", query: { redirect: to.fullPath } });
    return;
  }

  next();
});

export default router;
