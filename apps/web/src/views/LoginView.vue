<template>
  <main class="min-h-dvh w-full bg-surface-950 text-surface-100 flex items-center justify-center px-5 py-10 relative overflow-hidden">
    <div aria-hidden="true" class="absolute -top-36 -left-24 w-96 h-96 rounded-full bg-nash-500/10 blur-3xl pointer-events-none"></div>
    <section class="relative w-full max-w-md rounded-2xl border border-surface-800 bg-surface-900 p-6 sm:p-9 shadow-2xl" aria-labelledby="login-title">
      <div class="w-11 h-11 rounded-xl border border-nash-500/30 bg-nash-500/10 flex items-center justify-center text-nash-400 text-xl font-bold mb-7" aria-hidden="true">N</div>
      <p class="text-xs font-medium tracking-widest text-nash-400 mb-2">NASH WORKSPACE</p>
      <h1 id="login-title" class="text-2xl font-semibold tracking-tight">登录工作台</h1>
      <p class="text-sm text-surface-400 mt-2 mb-8 leading-relaxed">管理任务、查看执行进度，与集群中的智能体协作。</p>
      <form @submit.prevent="handleLogin" class="space-y-5" :aria-busy="loading">
        <p v-if="errorMessage" role="alert" class="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-3 text-sm text-rose-400">{{ errorMessage }}</p>
        <div>
          <label for="username" class="block text-sm font-medium mb-2">管理员账号</label>
          <input id="username" type="text" v-model="username" name="username" autocomplete="username" required :disabled="loading"
            class="w-full min-h-12 rounded-lg bg-surface-950 border border-surface-700 px-3.5 text-base focus:outline-none focus:border-nash-500 focus:ring-2 focus:ring-nash-500/25 disabled:opacity-60" />
        </div>
        <div>
          <label for="password" class="block text-sm font-medium mb-2">密码</label>
          <div class="relative">
            <input id="password" ref="passwordInput" v-model="password" name="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" required :disabled="loading"
              class="w-full min-h-12 rounded-lg bg-surface-950 border border-surface-700 pl-3.5 pr-12 text-base focus:outline-none focus:border-nash-500 focus:ring-2 focus:ring-nash-500/25 disabled:opacity-60" />
            <button type="button" @click="showPassword = !showPassword" :aria-label="showPassword ? '隐藏密码' : '显示密码'" :aria-pressed="showPassword"
              class="absolute inset-y-0 right-0 w-12 flex items-center justify-center text-surface-400 hover:text-surface-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nash-500 rounded-lg">
              <EyeOff v-if="showPassword" class="w-5 h-5" /><Eye v-else class="w-5 h-5" />
            </button>
          </div>
        </div>
        <button type="submit" :disabled="loading || retryAfter > 0" class="w-full min-h-12 rounded-lg bg-nash-500 hover:bg-nash-600 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-nash-500 disabled:opacity-50 disabled:cursor-not-allowed">
          <span v-if="loading" class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" aria-hidden="true"></span>
          {{ loading ? '正在验证…' : retryAfter > 0 ? `${retryAfter} 秒后可重试` : '登录工作台' }}
        </button>
      </form>
      <p class="mt-6 pt-5 border-t border-surface-800 text-xs text-surface-400 flex items-center gap-2"><LockKeyhole class="w-3.5 h-3.5" aria-hidden="true" />安全会话 · 登录尝试频控</p>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import { useRoute } from "vue-router";
import { Eye, EyeOff, LockKeyhole } from "lucide-vue-next";
import { useAuthStore } from "../stores/auth";
const authStore = useAuthStore();
const route = useRoute();
const username = ref("");
const password = ref("");
const showPassword = ref(false);
const passwordInput = ref<HTMLInputElement | null>(null);
const loading = ref(false);
const errorMessage = ref("");
const retryAfter = ref(0);
let retryTimer: ReturnType<typeof setInterval> | undefined;
onUnmounted(() => { if (retryTimer) clearInterval(retryTimer); });
async function handleLogin() {
  if (loading.value || retryAfter.value > 0) return;
  loading.value = true;
  errorMessage.value = "";
  try {
    await authStore.login(username.value, password.value);
    password.value = "";
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/";
    window.location.replace(redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/");
  } catch (error: any) {
    errorMessage.value = error.message || "登录失败，请检查账号和密码";
    if (error.status === 429) {
      retryAfter.value = Number(error.data?.retryAfter) || 60;
      if (retryTimer) clearInterval(retryTimer);
      retryTimer = setInterval(() => { if (--retryAfter.value <= 0) { clearInterval(retryTimer); retryTimer = undefined; } }, 1000);
    }
    passwordInput.value?.focus();
  } finally { loading.value = false; }
}
</script>
