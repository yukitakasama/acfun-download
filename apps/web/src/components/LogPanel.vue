<script setup lang="ts">
/** 日志 + 失败清单 + 历史（PLAN Q12 第 4 块）。 */
import { computed, onMounted, ref } from 'vue';
import { api, type LogLine, type TaskResult } from '../api.js';
import { ERROR_LABEL, formatBytes, formatTime } from '../utils.js';

const props = defineProps<{ logs: LogLine[] }>();

type Tab = 'log' | 'failures' | 'history';
const tab = ref<Tab>('log');
const failures = ref<TaskResult[]>([]);
const history = ref<TaskResult[]>([]);
const loading = ref(false);

const okCount = computed(() => history.value.filter((h) => h.status === 'success').length);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [f, h] = await Promise.all([api.failures(), api.history()]);
    failures.value = f.failures;
    history.value = h.history;
  } catch {
    /* 拉不到就保持旧数据 */
  } finally {
    loading.value = false;
  }
}

function copy(text: string): void {
  void navigator.clipboard?.writeText(text);
}

onMounted(load);
defineExpose({ load });
</script>

<template>
  <section class="card">
    <header class="card-head">
      <div class="tabs">
        <button small :class="{ active: tab === 'log' }" @click="tab = 'log'">日志 {{ logs.length }}</button>
        <button small :class="{ active: tab === 'failures' }" @click="tab = 'failures'">失败清单 {{ failures.length }}</button>
        <button small :class="{ active: tab === 'history' }" @click="tab = 'history'">历史 {{ okCount }}/{{ history.length }}</button>
      </div>
      <button small ghost :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
    </header>

    <div v-if="tab === 'log'" class="log-box">
      <p v-if="logs.length === 0" class="muted">暂无日志。</p>
      <div v-for="(l, i) in logs" :key="i" class="log-line" :class="l.level">
        <span class="ts">{{ formatTime(l.ts) }}</span>
        <span class="lvl">{{ l.level === 'error' ? 'ERR' : l.level === 'warn' ? 'WRN' : 'INF' }}</span>
        <span class="msg">{{ l.message }}</span>
      </div>
    </div>

    <div v-else-if="tab === 'failures'">
      <p v-if="failures.length === 0" class="muted">没有失败任务 🎉</p>
      <ul v-else class="items">
        <li v-for="f in failures" :key="f.taskId + f.url">
          <div class="row">
            <b class="err">{{ ERROR_LABEL[f.errorKind ?? 'UNKNOWN'] ?? f.errorKind }}</b>
            <span class="url" :title="f.url">{{ f.url }}</span>
            <button small ghost @click="copy(f.url)">复制链接</button>
          </div>
          <div class="detail">{{ f.message }}</div>
          <div class="muted" v-if="f.suggestion">建议：{{ f.suggestion }}</div>
        </li>
      </ul>
    </div>

    <div v-else>
      <p v-if="history.length === 0" class="muted">还没有历史记录。</p>
      <ul v-else class="items">
        <li v-for="h in history.slice(0, 60)" :key="h.taskId">
          <div class="row">
            <b :class="h.status === 'success' ? 'ok' : h.status === 'failed' ? 'err' : 'muted'">
              {{ h.status === 'success' ? '成功' : h.status === 'failed' ? '失败' : '跳过' }}
            </b>
            <span class="url" :title="h.filePath ?? h.url">{{ h.title ?? h.url }}</span>
            <span class="muted">{{ formatBytes(h.fileSize) }}</span>
          </div>
          <div class="detail mono" v-if="h.filePath">{{ h.filePath }}</div>
          <div class="detail" v-if="h.verified">
            核验：{{ h.verified.frames }} 帧 / {{ h.verified.durationSec.toFixed(1) }}s（清单
            {{ h.verified.manifestDurationSec.toFixed(1) }}s）
          </div>
          <div class="detail err" v-else-if="h.status === 'failed'">{{ h.errorKind }}: {{ h.message }}</div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}

.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.tabs {
  display: flex;
  gap: 6px;
}

.tabs button.active {
  border-color: var(--accent-2);
  color: var(--accent-2);
}

.log-box {
  font-family: var(--mono);
  font-size: 12px;
  max-height: 260px;
  overflow-y: auto;
  background: #0b0d12;
  border-radius: 8px;
  padding: 8px 10px;
}

.log-line {
  display: flex;
  gap: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-line.warn .lvl {
  color: var(--warn);
}

.log-line.error .lvl {
  color: var(--err);
}

.log-line.info .lvl {
  color: var(--muted);
}

.ts {
  color: #5b6373;
}

.lvl {
  width: 28px;
}

.muted {
  color: var(--muted);
}

.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 300px;
  overflow-y: auto;
}

.items li {
  background: var(--panel-2);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.url {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
  word-break: break-all;
}

.detail.mono {
  font-family: var(--mono);
}

.ok {
  color: var(--ok);
}

.err {
  color: var(--err);
}
</style>
