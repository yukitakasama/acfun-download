<script setup lang="ts">
/** 任务队列 + 实时进度（PLAN Q12 第 2 块）。 */
import { computed } from 'vue';
import { api, type TaskView, type Stats } from '../api.js';
import { ERROR_LABEL, formatBytes, formatDuration, formatTime, STATUS_LABEL } from '../utils.js';

const props = defineProps<{ tasks: TaskView[]; stats: Stats }>();
const emit = defineEmits<{ (e: 'refresh'): void; (e: 'log', level: 'info' | 'warn' | 'error', msg: string): void }>();

const running = computed(() =>
  props.tasks.filter((t) => ['resolving', 'manifest', 'downloading', 'verifying'].includes(t.status)),
);

async function cancel(id: string): Promise<void> {
  try {
    await api.cancel(id);
    emit('log', 'warn', '已请求取消任务');
  } catch (e) {
    emit('log', 'error', (e as Error).message);
  }
}

async function retry(id: string): Promise<void> {
  try {
    await api.retry(id);
    emit('log', 'info', '已重新入队');
    emit('refresh');
  } catch (e) {
    emit('log', 'error', (e as Error).message);
  }
}

function statusClass(status: string): string {
  if (status === 'done') return 'ok';
  if (status === 'failed') return 'err';
  if (status === 'skipped' || status === 'canceled') return 'muted';
  return 'run';
}
</script>

<template>
  <section class="card">
    <header class="card-head">
      <h2>② 任务队列</h2>
      <div class="stats">
        <span>共 {{ stats.total }}</span>
        <span class="ok">成功 {{ stats.success }}</span>
        <span class="err">失败 {{ stats.failed }}</span>
        <span class="muted">跳过 {{ stats.skipped }}</span>
        <span class="run">进行中 {{ running.length }}</span>
        <span>排队 {{ stats.queued }}</span>
      </div>
    </header>

    <p v-if="tasks.length === 0" class="empty">还没有任务。粘贴链接后点「开始下载」。</p>

    <ul v-else class="list">
      <li v-for="t in tasks" :key="t.id" class="item" :class="statusClass(t.status)">
        <div class="line1">
          <span class="chip" :class="statusClass(t.status)">{{ STATUS_LABEL[t.status] ?? t.status }}</span>
          <span class="title" :title="t.title ?? t.url">{{ t.title ?? t.url }}</span>
          <span class="time">{{ formatTime(t.createdAt) }}</span>
        </div>

        <div class="bar" v-if="['downloading', 'verifying', 'resolving'].includes(t.status) || t.percent > 0">
          <div class="fill" :style="{ width: Math.min(100, Math.max(0, t.percent)) + '%' }" />
          <span class="pct">{{ t.percent.toFixed(1) }}%</span>
        </div>

        <div class="meta">
          <span v-if="t.percent > 0">已处理 {{ formatDuration(t.timeSec) }}</span>
          <span v-if="t.fileSize">{{ formatBytes(t.fileSize) }}</span>
          <span v-if="t.attempts > 1">第 {{ t.attempts }} 轮</span>
          <span v-if="t.outputPath" class="path" :title="t.outputPath">{{ t.outputPath }}</span>
        </div>

        <div v-if="t.status === 'failed'" class="err-box">
          <b>{{ ERROR_LABEL[t.errorKind ?? 'UNKNOWN'] ?? t.errorKind }}</b>
          <span>{{ t.message }}</span>
          <span class="muted" v-if="t.suggestion">建议：{{ t.suggestion }}</span>
        </div>

        <div class="actions">
          <button
            v-if="['queued', 'resolving', 'manifest', 'downloading', 'verifying'].includes(t.status)"
            small
            ghost
            @click="cancel(t.id)"
          >
            取消
          </button>
          <button v-if="['failed', 'canceled', 'skipped'].includes(t.status)" small @click="retry(t.id)">重试</button>
        </div>
      </li>
    </ul>
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
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

h2 {
  font-size: 15px;
  margin: 0;
}

.stats {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
}

.stats .ok {
  color: var(--ok);
}

.stats .err {
  color: var(--err);
}

.stats .run {
  color: var(--accent-2);
}

.empty {
  color: var(--muted);
  font-size: 13px;
  margin: 8px 0 0;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 46vh;
  overflow-y: auto;
}

.item {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-left: 3px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}

.item.ok {
  border-left-color: var(--ok);
}

.item.err {
  border-left-color: var(--err);
}

.item.run {
  border-left-color: var(--accent-2);
}

.line1 {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chip {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
  white-space: nowrap;
}

.chip.ok {
  color: var(--ok);
  border-color: rgba(62, 207, 142, 0.4);
}

.chip.err {
  color: var(--err);
  border-color: rgba(255, 92, 92, 0.4);
}

.chip.run {
  color: var(--accent-2);
  border-color: rgba(76, 141, 253, 0.4);
}

.title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time {
  color: var(--muted);
  font-size: 12px;
}

.bar {
  position: relative;
  height: 6px;
  background: #0b0d12;
  border-radius: 999px;
  margin: 8px 0 6px;
  overflow: hidden;
}

.fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-2), var(--accent));
  transition: width 0.3s;
}

.pct {
  position: absolute;
  right: 0;
  top: -18px;
  font-size: 11px;
  color: var(--muted);
}

.meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
  flex-wrap: wrap;
}

.path {
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.err-box {
  margin-top: 6px;
  font-size: 12px;
  color: var(--err);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.err-box .muted {
  color: var(--muted);
}

.actions {
  margin-top: 8px;
  display: flex;
  gap: 6px;
}
</style>
