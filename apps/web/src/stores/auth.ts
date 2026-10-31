import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { closeAllSseConnections } from "../services/sse";
import { api } from "../services/api";

export interface UserProfile {
  userId: string;
  username: string;
  role: "admin" | "operator" | "viewer";
}

export const useAuthStore = defineStore("auth", () => {
  const user = ref<UserProfile | null>(null);
  const loading = ref(false);
  const initialized = ref(false);

  api.setUnauthorizedHandler(() => {
    user.value = null;
    api.setCsrfToken(null);
    closeAllSseConnections();
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.replace(`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
  });

  const isAuthenticated = computed(() => !!user.value);
  const isAdmin = computed(() => user.value?.role === "admin");

  async function checkAuth(): Promise<boolean> {
    loading.value = true;
    try {
      const res = await api.getMe();
      if (res.authenticated && res.user) {
        user.value = res.user;
        return true;
      }
      user.value = null;
      return false;
    } catch {
      user.value = null;
      return false;
    } finally {
      loading.value = false;
      initialized.value = true;
    }
  }

  async function login(username: string, password: string) {
    loading.value = true;
    try {
      const res = await api.login(username, password);
      if (res.success && res.user) {
        user.value = res.user;
        initialized.value = true;
        return res;
      }
      throw new Error("Login failed");
    } finally {
      loading.value = false;
    }
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      user.value = null;
      api.setCsrfToken(null);
      closeAllSseConnections();
    }
  }

  return {
    user,
    loading,
    initialized,
    isAuthenticated,
    isAdmin,
    checkAuth,
    login,
    logout,
  };
});
