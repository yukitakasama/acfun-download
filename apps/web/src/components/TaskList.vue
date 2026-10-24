<script setup lang="ts">
/** 任务队列 + 实时进度（PLAN Q12 第 2 块）。 */
import { computed } from 'vue';
import { api, type TaskView, type Stats } from '../api.js';
import {
  ERROR_LABEL,
  formatBytes,
  formatDuration,
  formatEta,
  formatSpeed,
  formatTime,
  STATUS_LABEL,
} from '../utils.js';

const props = defineProps<{ tasks: TaskView[]; stats: Stats }>();
const emit = defineEmits<{ (e: 'refresh'): void; (e: 'log', level: 'info' | 'warn' | 'error', msg: string): void }>();

const ACTIVE = ['resolving', 'manifest', 'downloading', 'verifying'];
const running = computed(() => props.tasks.filter((t) => ACTIVE.includes(t.status)));

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

/** 百分比必须是有限数：NaN 会让 width 失效、整条变成「满格」。 */
function pct(t: TaskView): number {
  return Number.isFinite(t.percent) ? Math.min(100, Math.max(0, t.percent)) : 0;
}

/** 什么时候显示进度条：下载/核验中，或已经有过进度。 */
function showProgress(t: TaskView): boolean {
  return ACTIVE.includes(t.status) || (Number.isFinite(t.percent) && t.percent > 0);
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

        <!-- 进度：条 + 百分比 + 速度 + 分片 + 已处理/剩余（百分比移出 bar，避免被 overflow 裁掉） -->
        <div v-if="showProgress(t)" class="prog">
          <div class="bar" :class="{ waiting: t.stalled, verifying: t.status === 'verifying' }">
            <div class="fill" :style="{ width: `${pct(t)}%` }" />
          </div>
          <div class="prog-line">
            <span class="pct">{{ pct(t).toFixed(1) }}%</span>
            <span v-if="t.status === 'verifying'" class="hint">核验中（全片解码，可能较慢）…</span>
            <span v-else-if="t.stalled" class="hint warn">等待数据…</span>
            <span v-if="t.bytesPerSec" class="speed" title="实时下载速度">{{ formatSpeed(t.bytesPerSec) }}</span>
            <span v-if="t.segTotal" class="segs">{{ t.segDone ?? 0 }}/{{ t.segTotal }} 段</span>
            <span v-if="t.bytes" class="bytes">{{ formatBytes(t.bytes) }}</span>
            <span v-if="t.timeSec > 0" class="media">已处理 {{ formatDuration(t.timeSec) }}</span>
            <span v-if="t.etaSec" class="eta">{{ formatEta(t.etaSec) }}</span>
          </div>
        </div>

        <div class="meta">
          <span v-if="t.fileSize">{{ formatBytes(t.fileSize) }}</span>
          <span v-if="t.status === 'resolving'">解析页面与清单…</span>
          <span v-if="t.attempts > 1">第 {{ t.attempts }} 轮</span>
          <span v-if="t.outputPath" class="path" :title="t.outputPath">{{ t.outputPath }}</span>
        </div>

        <div v-if="t.status === 'failed'" class="err-box">
          <b>{{ ERROR_LABEL[t.errorKind ?? 'UNKNOWN'] ?? t.errorKind }}</b>
          <span>{{ t.message }}</span>
          <span class="muted" v-if="t.suggestion">建议：{{ t.suggestion }}</span>
        </div>

        <div class="actions">
          <button v-if="ACTIVE.includes(t.status) || t.status === 'queued'" small ghost @click="cancel(t.id)">取消</button>
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

/* ---- 进度 ---- */
.prog {
  margin: 8px 0 6px;
}

.bar {
  height: 6px;
  background: #0b0d12;
  border-radius: 999px;
  overflow: hidden;
}

.fill {
  height: 100%;
  min-width: 0;
  background: linear-gradient(90deg, var(--accent-2), var(--accent));
  transition: width 0.25s linear;
}

.bar.waiting .fill {
  background: repeating-linear-gradient(45deg, #48506a, #48506a 6px, #5a6480 6px, #5a6480 12px);
}

.bar.verifying .fill {
  background: repeating-linear-gradient(
    45deg,
    rgba(62, 207, 142, 0.55),
    rgba(62, 207, 142, 0.55) 6px,
    rgba(62, 207, 142, 0.85) 6px,
    rgba(62, 207, 142, 0.85) 12px
  );
  animation: stripes 1s linear infinite;
  background-size: 24px 24px;
}

@keyframes stripes {
  from {
    background-position: 0 0;
  }
  to {
    background-position: 24px 0;
  }
}

.prog-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
}

.pct {
  color: var(--text);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.speed {
  color: var(--accent-2);
  font-variant-numeric: tabular-nums;
}

.segs,
.bytes,
.media,
.eta {
  font-variant-numeric: tabular-nums;
}

.hint {
  color: var(--muted);
}

.hint.warn {
  color: var(--warn);
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
