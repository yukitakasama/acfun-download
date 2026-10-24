<script setup lang="ts">
/**
 * 设置页（PLAN Q12 第 3 块 / Q13）。
 *
 * 配置持久化到 `%APPDATA%\acfun-download\config.json`（服务端写盘）。
 * 环境探测（ffmpeg / ego lite）不可用时给黄色告警并允许在这里手填路径。
 */
import { onMounted, reactive, ref, watch } from 'vue';
import { api, type Config } from '../api.js';

interface EnvStatus {
  ffmpeg: { ok: boolean; version?: string; error?: string };
  ego: { ok: boolean; version?: string; error?: string };
}

const props = defineProps<{ config: Config }>();
const emit = defineEmits<{
  (e: 'saved', config: Config): void;
  (e: 'log', level: 'info' | 'warn' | 'error', msg: string): void;
}>();

const form = reactive<Config>({ ...props.config });
const env = ref<EnvStatus | null>(null);
const saving = ref(false);
const savedAt = ref<number | null>(null);

watch(
  () => props.config,
  (next) => Object.assign(form, next),
  { deep: true },
);

async function loadEnv(): Promise<void> {
  try {
    const res = await fetch('/api/env', {
      headers: { 'x-acfun-token': localStorage.getItem('acfun.token') ?? '' },
    });
    if (res.ok) env.value = (await res.json()) as EnvStatus;
  } catch {
    /* 环境探测失败不影响设置页 */
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const res = await api.saveConfig({ ...form });
    emit('saved', res.config);
    savedAt.value = Date.now();
    emit('log', 'info', '设置已保存');
    void loadEnv();
  } catch (e) {
    emit('log', 'error', (e as Error).message);
  } finally {
    saving.value = false;
  }
}

onMounted(loadEnv);
</script>

<template>
  <section class="card">
    <header class="card-head">
      <h2>③ 设置</h2>
      <div class="right">
        <button small ghost @click="loadEnv">重新探测环境</button>
        <button class="primary" small :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存设置' }}</button>
      </div>
    </header>

    <div v-if="env" class="env">
      <div class="env-item" :class="env.ffmpeg.ok ? 'ok' : 'warn'">
        <b>ffmpeg</b>
        <span>{{ env.ffmpeg.ok ? env.ffmpeg.version : env.ffmpeg.error }}</span>
      </div>
      <div class="env-item" :class="env.ego.ok ? 'ok' : 'warn'">
        <b>ego lite</b>
        <span>{{ env.ego.ok ? env.ego.version : env.ego.error }}</span>
      </div>
    </div>
    <div v-if="env && !env.ffmpeg.ok" class="alert">
      ⚠ 找不到 ffmpeg/ffprobe。核验与转封装必需：请安装后加入 PATH，或在下方填写可执行文件完整路径。
    </div>
    <div v-if="env && !env.ego.ok" class="alert soft">
      ℹ ego lite 不可用，将回落到 Chrome + CDP 通道（需要本机装 Chrome）。
    </div>

    <div class="grid">
      <div class="field span2">
        <label>输出目录</label>
        <input v-model="form.outDir" placeholder="downloads" />
      </div>

      <div class="field">
        <label>容器格式</label>
        <select v-model="form.container">
          <option value="mp4">mp4</option>
          <option value="mkv">mkv</option>
          <option value="ts">ts</option>
        </select>
      </div>

      <div class="field">
        <label>重名处理</label>
        <select v-model="form.onExist">
          <option value="rename">rename（-1/-2）</option>
          <option value="skip">skip</option>
          <option value="overwrite">overwrite</option>
        </select>
      </div>

      <div class="field">
        <label>命名模式</label>
        <select v-model="form.nameMode">
          <option value="title">title（用视频标题）</option>
          <option value="custom">custom（固定名/模板）</option>
        </select>
      </div>

      <div class="field">
        <label>固定名（custom）</label>
        <input v-model="form.name" placeholder="留空则用模板/标题" />
      </div>

      <div class="field span2">
        <label>模板（custom，占位符 {title}{author}{date}{id}{index}）</label>
        <input v-model="form.template" placeholder="{title} [{author}] {date} {id}" />
      </div>

      <div class="field">
        <label>并发（仅并行 ffmpeg；浏览器恒串行）</label>
        <input v-model.number="form.concurrency" type="number" min="1" max="8" />
      </div>

      <div class="field">
        <label>整片重试轮数</label>
        <input v-model.number="form.retries" type="number" min="0" max="5" />
      </div>

      <div class="field">
        <label>超时（秒）</label>
        <input v-model.number="form.timeoutSec" type="number" min="5" max="300" />
      </div>

      <div class="field">
        <label>任务间隔（毫秒）</label>
        <input v-model.number="form.intervalMs" type="number" min="0" max="60000" step="100" />
      </div>

      <div class="field">
        <label>浏览器通道</label>
        <select v-model="form.channel">
          <option value="auto">auto（ego 优先）</option>
          <option value="ego">ego lite</option>
          <option value="chrome">Chrome + CDP</option>
        </select>
      </div>

      <div class="field">
        <label>ffmpeg 路径</label>
        <input v-model="form.ffmpegPath" placeholder="ffmpeg" />
      </div>

      <div class="field">
        <label>ffprobe 路径</label>
        <input v-model="form.ffprobePath" placeholder="ffprobe" />
      </div>

      <div class="field">
        <label>Chrome 路径（可空）</label>
        <input v-model="form.chromePath" placeholder="自动探测" />
      </div>

      <div class="field">
        <label>代理（可空，ego 通道不支持）</label>
        <input v-model="form.proxy" placeholder="http://127.0.0.1:7890" />
      </div>

      <div class="field">
        <label>Cookie 文件（仅 Chrome 通道）</label>
        <input v-model="form.cookieFile" placeholder="cookies.txt" />
      </div>
    </div>

    <div class="toggles">
      <label class="toggle"><input v-model="form.meta" type="checkbox" /> 元数据 .meta.json</label>
      <label class="toggle"><input v-model="form.cover" type="checkbox" /> 封面</label>
      <label class="toggle"><input v-model="form.danmaku" type="checkbox" /> 弹幕（实验性）</label>
      <label class="toggle"><input v-model="form.subtitle" type="checkbox" /> 字幕（实验性）</label>
    </div>

    <div v-if="savedAt" class="saved">已保存于 {{ new Date(savedAt).toLocaleTimeString() }}</div>
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
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.right {
  display: flex;
  gap: 8px;
}

h2 {
  font-size: 15px;
  margin: 0;
}

.env {
  display: flex;
  gap: 16px;
  font-size: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.env-item {
  display: flex;
  gap: 6px;
  align-items: baseline;
}

.env-item.ok b {
  color: var(--ok);
}

.env-item.warn b {
  color: var(--warn);
}

.env-item span {
  color: var(--muted);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.alert {
  background: rgba(240, 180, 41, 0.12);
  color: var(--warn);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  margin-bottom: 10px;
}

.alert.soft {
  background: rgba(76, 141, 253, 0.1);
  color: var(--accent-2);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.field.span2 {
  grid-column: span 2;
}

.toggles {
  display: flex;
  gap: 18px;
  margin-top: 14px;
  flex-wrap: wrap;
  font-size: 13px;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  font-size: 13px;
  margin: 0;
}

.toggle input {
  width: auto;
}

.saved {
  margin-top: 10px;
  font-size: 12px;
  color: var(--ok);
}
</style>
