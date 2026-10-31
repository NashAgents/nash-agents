import { computed, onScopeDispose, ref } from "vue";
import { defineStore } from "pinia";
import { api } from "../services/api.js";
import { memoryKey, type MemoryRecord } from "../services/memory-presentation.js";

export const useMemoryStore = defineStore("memory", () => {
  const entries = ref<MemoryRecord[]>([]);
  const results = ref<MemoryRecord[]>([]);
  const activeQuery = ref("");
  const loading = ref(false);
  const error = ref("");
  const loaded = ref(false);
  let requestVersion = 0;
  const items = computed(() => activeQuery.value ? results.value : entries.value);

  async function load(query = "") {
    const version = ++requestVersion;
    activeQuery.value = query.trim();
    results.value = [];
    error.value = "";
    loading.value = true;
    try {
      const response = activeQuery.value ? await api.searchMemory(activeQuery.value, undefined, undefined, 100) : await api.listMemory();
      if (version !== requestVersion) return;
      const records = "results" in response ? response.results : response.entries;
      const unique = [...new Map(records.map((item) => [memoryKey(item), item])).values()];
      if (activeQuery.value) results.value = unique;
      else { entries.value = unique; loaded.value = true; }
    } catch (err) {
      if (version !== requestVersion) return;
      error.value = err instanceof Error ? err.message : "暂时无法读取记忆，请稍后重试。";
    } finally {
      if (version === requestVersion) loading.value = false;
    }
  }

  onScopeDispose(() => { requestVersion++; });
  return { entries, results, activeQuery, loading, error, loaded, items, load };
});
