<template>
  <component :is="layoutComponent">
    <div class="flex-1 flex flex-col p-4 md:p-6 max-w-6xl mx-auto w-full">
      <div class="flex items-center justify-between pb-4 border-b border-surface-800 mb-6">
        <div>
          <h2 class="text-lg font-bold text-surface-100 tracking-tight">
            {{ t.artifacts.title }}
          </h2>
          <p class="text-xs text-surface-400 mt-0.5 font-mono">
            跨节点产物持久化交换 · SHA-256 强哈希完整性校验与流式下载
          </p>
        </div>
        <button
          @click="() => artifactsStore.loadArtifacts()"
          class="px-3 py-1.5 rounded-lg bg-surface-900 border border-surface-700 text-xs font-mono text-surface-300 hover:text-surface-100 transition-colors"
        >
          刷新产物
        </button>
      </div>

      <!-- 产物概念与用途说明卡片 -->
      <div class="mb-6 p-4 rounded-xl bg-surface-900/80 border border-surface-800 text-xs text-surface-300 leading-relaxed space-y-2 shadow-sm">
        <div class="flex items-center gap-2 font-semibold text-nash-300">
          <svg class="w-4 h-4 text-nash-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>什么是产物仓库 (Artifacts)？</span>
        </div>
        <p class="text-surface-400">
          在分布式多节点协同或任务图 (TaskGraph) 执行流水线时，各 Worker 节点生成的实体交付文件（如编译包、提取出的字幕/文档、测试审计报告 JSON、数据快照等）会自动生成 SHA-256 完整性哈希并持久化上传至此。产物一方面用于跨节点下游流水线消费，另一方面可供管理员在此集中审计、预览内容或直接下载。
        </p>
      </div>

      <!-- 产物列表网格 -->
      <div v-if="artifactsStore.artifacts.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div
          v-for="art in artifactsStore.artifacts"
          :key="art.artifactId"
          class="p-4 rounded-xl bg-surface-900 border border-surface-800 hover:border-surface-700 transition-all shadow-sm flex flex-col justify-between space-y-3"
        >
          <div>
            <div class="flex items-start justify-between gap-2 mb-2">
              <div class="flex items-center gap-2 truncate">
                <svg class="w-4 h-4 text-nash-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                <h3 class="font-semibold text-xs text-surface-100 truncate" :title="art.name">
                  {{ art.name }}
                </h3>
              </div>
              <Badge variant="outline" size="sm">
                {{ formatBytes(art.sizeBytes) }}
              </Badge>
            </div>

            <div class="space-y-1.5 text-[11px] text-surface-400 font-mono">
              <div>生产节点: <span class="text-surface-200">{{ art.producerNodeId || 'local' }}</span></div>
              <div v-if="art.producerTaskId">关联任务: <span class="text-surface-200">{{ art.producerTaskId }}</span></div>
              <div v-if="art.graphId">所属任务图: <span class="text-surface-200">{{ art.graphId }}</span></div>
              <div>格式: <span class="text-surface-200">{{ art.contentType }}</span></div>
              <div class="flex items-center gap-1.5">
                <span>校验状态:</span>
                <span class="text-emerald-400 font-semibold flex items-center gap-0.5">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                  SHA-256 完整性已校验
                </span>
              </div>
              <div class="truncate text-[10px] text-surface-500">
                SHA: {{ art.sha256 }}
              </div>
            </div>
          </div>

          <div class="pt-3 border-t border-surface-800/80 flex items-center justify-between text-xs font-mono">
            <button
              @click="openPreview(art)"
              class="text-nash-400 hover:text-nash-300 underline text-xs"
            >
              在线预览
            </button>
            <a
              :href="artifactsStore.getDownloadUrl(art.artifactId)"
              download
              class="flex items-center gap-1 text-surface-300 hover:text-surface-100 transition-colors"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              下载
            </a>
          </div>
        </div>
      </div>

      <EmptyState
        v-else
        title="暂无任何交付产物"
        description="任务执行完成后产生的报告或代码将统一归集并持久化至此"
      />
    </div>
  </component>

  <!-- 预览弹窗 -->
  <Modal v-model="showPreviewModal" :title="`产物内容预览: ${selectedArt?.name || ''}`">
    <div v-if="artifactsStore.previewLoading" class="p-8 text-center text-xs text-surface-400">
      正在读取产物并校验 SHA-256 完整性...
    </div>
    <div v-else class="space-y-3">
      <div class="flex items-center justify-between text-xs font-mono text-surface-400 pb-2 border-b border-surface-800">
        <span class="truncate max-w-sm">SHA-256: {{ selectedArt?.sha256 }}</span>
        <span>{{ formatBytes(selectedArt?.sizeBytes || 0) }}</span>
      </div>
      <div class="text-xs text-surface-400 space-y-1">
        <p>系统记录的生成时间：{{ selectedArt?.createdAt ? new Date(selectedArt.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (北京时间)' : '未知' }}</p>
        <p>所属任务图：{{ selectedArt?.graphId }}</p>
        <p>正文由模型生成，正文中的日期不作为系统时间记录。</p>
      </div>
      <pre class="p-3 rounded-lg bg-surface-950 border border-surface-800 font-mono text-xs overflow-x-auto text-surface-200 max-h-96 whitespace-pre-wrap">{{ artifactsStore.previewContent }}</pre>
    </div>
    <template #footer>
      <a
        v-if="selectedArt"
        :href="artifactsStore.getDownloadUrl(selectedArt.artifactId)"
        download
        class="px-4 py-2 rounded-lg bg-nash-500 hover:bg-nash-600 text-white font-semibold text-xs transition-colors flex items-center gap-1.5"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        下载文件
      </a>
    </template>
  </Modal>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useUiStore } from "../stores/ui";
import { useArtifactsStore } from "../stores/artifacts";
import { useI18n } from "../i18n";

import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";

import Badge from "../components/ui/Badge.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import Modal from "../components/ui/Modal.vue";

const uiStore = useUiStore();
const artifactsStore = useArtifactsStore();
const { t } = useI18n();

const showPreviewModal = ref(false);
const selectedArt = ref<any | null>(null);

const layoutComponent = computed(() => {
  if (uiStore.isMobile) return MobileLayout;
  if (uiStore.isTablet) return TabletLayout;
  return DesktopLayout;
});

onMounted(async () => {
  await artifactsStore.loadArtifacts();
});

async function openPreview(art: any) {
  selectedArt.value = art;
  await artifactsStore.loadPreview(art.artifactId);
  showPreviewModal.value = true;
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
</script>
