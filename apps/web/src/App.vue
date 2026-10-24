<script setup lang="ts">
/**
 * 应用外壳：连接 SSE、维护任务/配置/日志，把 4 大区块拼起来。
 * 业务逻辑全在 core/服务端，这里只做展示与交互（PLAN §3.1 双入口）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  api,
  connectEvents,
  getToken,
  initToken,
  setToken,
  type Config,
  type LogLine,
  type SseEvent,
  type Stats,
  type TaskView,
} from './api.js';
import InputPanel from './components/InputPanel.vue';
import LogPanel from './components/LogPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import TaskList from './components/TaskList.vue';

const token = ref('');
const tokenInput = ref('');
const connected = ref(false);
const connectionDetail = ref('');
const config = ref<Config | null>(null);
const tasks = ref<TaskView[]>([]);
const stats = ref<Stats>({ total: 0, success: 0, failed: 0, skipped: 0, running: 0, queued: 0 });
const logs = ref<LogLine[]>([]);
const showSettings = ref(false);
const logPanel = ref<{ load: () => Promise<void> } | null>(null);
const fatal = ref('');

const hasToken = computed(() => token.value.length > 0);
const disconnected = computed(() => hasToken.value && !connected.value);

function pushLog(level: LogLine['level'], message: string, taskId?: string): void {
  logs.value.push({ ts: Date.now(), level, message, ...(taskId === undefined ? {} : { taskId }) });
  if (logs.value.length > 800) logs.value = logs.value.slice(-800);
}

function upsertTask(task: TaskView): void {
  const i = tasks.value.findIndex((t) => t.id === task.id);
  if (i >= 0) tasks.value[i] = { ...tasks.value[i]!, ...task };
  else tasks.value.unshift({ ...task });
}

function applyEvent(e: SseEvent): void {
  switch (e.type) {
    case 'hello': {
      const hello = e as unknown as { tasks?: TaskView[]; stats?: Stats };
      if (hello.tasks) tasks.value = [...hello.tasks];
      if (hello.stats) stats.value = hello.stats;
      break;
    }
    case 'task': {
      const t = (e as unknown as { task: TaskView }).task;
      if (t) upsertTask(t);
      break;
    }
    case 'progress': {
      const { taskId, progress } = e as unknown as {
        taskId: string;
        progress: { percent: number; timeSec: number };
      };
      const task = tasks.value.find((x) => x.id === taskId);
      if (task) {
        task.percent = progress.percent;
        task.timeSec = progress.timeSec;
      }
      break;
    }
    case 'log': {
      const { level, message, taskId } = e as unknown as { level: LogLine['level']; message: string; taskId?: string };
      pushLog(level, message, taskId);
      break;
    }
    case 'done': {
      void refreshTasks();
      void logPanel.value?.load();
      break;
    }
    case 'config': {
      const { config: cfg } = e as unknown as { config: Config };
      if (cfg) config.value = cfg;
      break;
    }
    default:
      break;
  }
}

async function refreshTasks(): Promise<void> {
  try {
    const res = await api.tasks();
    tasks.value = res.tasks;
    stats.value = res.stats;
  } catch (e) {
    pushLog('error', `刷新任务失败: ${(e as Error).message}`);
  }
}

let closeEvents: (() => void) | null = null;

async function boot(): Promise<void> {
  fatal.value = '';
  try {
    const health = await api.health();
    pushLog('info', `已连接本地服务（pid=${health.pid}, v${health.version}）`);
    const cfg = await api.config();
    config.value = cfg.config;
    await refreshTasks();
    closeEvents?.();
    closeEvents = connectEvents(applyEvent, (ok, detail) => {
      connected.value = ok;
      connectionDetail.value = detail ?? '';
      if (!ok && detail) pushLog('warn', detail);
    });
  } catch (e) {
    fatal.value = `连接本地服务失败：${(e as Error).message}`;
  }
}

function submitToken(): void {
  if (!tokenInput.value.trim()) return;
  setToken(tokenInput.value);
  token.value = getToken();
  tokenInput.value = '';
  void boot();
}

watch(
  () => config.value?.concurrency,
  () => {
    /* 并发变更由服务端 pump 处理，前端无需额外动作 */
  },
);

onMounted(() => {
  token.value = initToken();
  if (hasToken.value) void boot();
});

onBeforeUnmount(() => closeEvents?.());
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="logo">Ac</span>
        <div>
          <h1>AcFun 视频下载</h1>
          <p class="sub">CLI + 本地 GUI 共用同一套 core；只下载允许公开播放的内容，核验不可跳过。</p>
        </div>
      </div>
      <div class="right">
        <span class="dot" :class="connected ? 'on' : 'off'" />
        <span class="muted">{{ connected ? '实时连接' : hasToken ? '未连接' : '未授权' }}</span>
        <span class="sep" />
        <span class="muted">成功 {{ stats.success }} / 失败 {{ stats.failed }} / 跳过 {{ stats.skipped }}</span>
        <button small ghost @click="showSettings = !showSettings">{{ showSettings ? '收起设置' : '设置' }}</button>
      </div>
    </header>

    <div v-if="fatal" class="banner err">{{ fatal }}</div>
    <div v-if="disconnected && connectionDetail" class="banner warn">{{ connectionDetail }}</div>

    <section v-if="!hasToken" class="token-box card">
      <h2>需要访问 token</h2>
      <p class="muted">
        本地服务启动时会打印一次性 token（`{"type":"server","token":"…"}`），或用
        <code>http://127.0.0.1:&lt;port&gt;/?token=…</code> 直接打开本页。
      </p>
      <div class="row">
        <input v-model="tokenInput" placeholder="粘贴 token" @keyup.enter="submitToken" />
        <button class="primary" @click="submitToken">连接</button>
      </div>
    </section>

    <main v-else class="main">
      <InputPanel @submitted="refreshTasks" @log="pushLog" />
      <TaskList :tasks="tasks" :stats="stats" @refresh="refreshTasks" @log="pushLog" />
      <SettingsPanel v-if="config && showSettings" :config="config" @saved="config = $event" @log="pushLog" />
      <LogPanel ref="logPanel" :logs="logs" />
    </main>

    <footer class="footer">
      <span class="muted">
        仅支持 Windows x64 · 外部依赖 ffmpeg/ffprobe（必需）、ego lite（默认浏览器通道）
      </span>
    </footer>
  </div>
</template>

<style scoped>
.app {
  max-width: 1080px;
  margin: 0 auto;
  padding: 18px 18px 40px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 100%;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.brand {
  display: flex;
  gap: 10px;
  align-items: center;
}

.logo {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--accent), #ff8a5b);
  color: #fff;
  font-weight: 700;
}

h1 {
  font-size: 17px;
  margin: 0;
}

.sub {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--muted);
}

.right {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}

.dot.on {
  background: var(--ok);
  box-shadow: 0 0 8px rgba(62, 207, 142, 0.7);
}

.dot.off {
  background: var(--err);
}

.sep {
  width: 1px;
  height: 14px;
  background: var(--border);
}

.main {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}

.token-box h2 {
  font-size: 15px;
  margin: 0 0 6px;
}

.token-box .row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.banner {
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
}

.banner.err {
  background: rgba(255, 92, 92, 0.12);
  color: var(--err);
}

.banner.warn {
  background: rgba(240, 180, 41, 0.12);
  color: var(--warn);
}

.muted {
  color: var(--muted);
}

.footer {
  margin-top: 6px;
  font-size: 12px;
  text-align: center;
}
</style>
