<script setup lang="ts">
/**
 * 输入区 + 解析预览（PLAN Q12 第 1 块）。
 *
 * 「解析预览」只做站点/世代判定（快，不开浏览器），让用户在下载前就知道
 * 世代、页面类型、pageId —— 世代判错时能立刻发现，而不是等下载失败。
 */
import { computed, ref } from 'vue';
import { api, type ParsePreview } from '../api.js';

const emit = defineEmits<{ (e: 'submitted'): void; (e: 'log', level: 'info' | 'warn' | 'error', msg: string): void }>();

const text = ref('');
const preview = ref<ParsePreview | null>(null);
const previewing = ref(false);
const submitting = ref(false);
const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);

const lineCount = computed(() => text.value.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length);

/** 从输入里挑第一个像链接的行做预览。 */
function firstLine(): string {
  const line = text.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('//'));
  return line ?? '';
}

async function doPreview(): Promise<void> {
  const input = firstLine();
  if (!input) {
    message.value = { kind: 'err', text: '先粘贴一个链接或分享文本' };
    return;
  }
  previewing.value = true;
  message.value = null;
  try {
    preview.value = await api.parse(input);
  } catch (e) {
    message.value = { kind: 'err', text: (e as Error).message };
  } finally {
    previewing.value = false;
  }
}

async function doSubmit(): Promise<void> {
  if (!text.value.trim()) {
    message.value = { kind: 'err', text: '输入为空' };
    return;
  }
  submitting.value = true;
  message.value = null;
  try {
    const res = await api.submit({ text: text.value });
    const parts: string[] = [`已加入 ${res.created.length} 条`];
    if (res.skipped.length > 0) parts.push(`跳过 ${res.skipped.length} 条（${res.skipped[0]?.reason ?? ''}）`);
    message.value = { kind: 'ok', text: parts.join('，') };
    emit('submitted');
    emit('log', 'info', `提交 ${res.created.length} 条任务`);
    text.value = '';
    preview.value = null;
  } catch (e) {
    message.value = { kind: 'err', text: (e as Error).message };
  } finally {
    submitting.value = false;
  }
}

function clearAll(): void {
  text.value = '';
  preview.value = null;
  message.value = null;
}
</script>

<template>
  <section class="card">
    <header class="card-head">
      <h2>① 输入</h2>
      <span class="hint">支持多个链接 / 分享文本 / 纯 id（需在设置里填基准域名）</span>
    </header>

    <textarea
      v-model="text"
      placeholder="粘贴播放页 / 社区帖链接，或整段分享文本：&#10;https://<域名>/play/267427&#10;【日常分享】快来看这个 https://<域名>/community/2164411 🎉&#10;（空行与 # // 开头的行会被忽略）"
      spellcheck="false"
      rows="5"
    />

    <div class="row between">
      <div class="muted">共 {{ lineCount }} 行有效输入</div>
      <div class="row">
        <button ghost small @click="clearAll">清空</button>
        <button small :disabled="previewing" @click="doPreview">
          {{ previewing ? '解析中…' : '解析预览' }}
        </button>
        <button class="primary" :disabled="submitting" @click="doSubmit">
          {{ submitting ? '提交中…' : '开始下载' }}
        </button>
      </div>
    </div>

    <div v-if="message" class="msg" :class="message.kind">{{ message.text }}</div>

    <div v-if="preview" class="preview" :class="{ bad: !preview.ok }">
      <template v-if="preview.ok">
        <div class="preview-grid">
          <div><span class="k">世代</span><b class="gen" :data-gen="preview.generation">{{ preview.generation }}</b></div>
          <div><span class="k">类型</span>{{ preview.kind }}</div>
          <div><span class="k">pageId</span><code>{{ preview.pageId }}</code></div>
          <div><span class="k">域名</span>{{ preview.origin }}</div>
        </div>
        <div class="evidence">判定依据：<code v-for="e in preview.evidence" :key="e">{{ e }}</code></div>
        <div v-if="preview.generation === 'official'" class="warn-line">
          官方站（www.acfun.cn）只做尽力解析，可能给出 OFFICIAL_UNSUPPORTED —— 属已知限制。
        </div>
      </template>
      <template v-else>
        <b>{{ preview.error?.kind }}</b>
        <div>{{ preview.error?.message }}</div>
        <div class="muted">建议：{{ preview.error?.suggestion }}</div>
      </template>
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
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}

h2 {
  font-size: 15px;
  margin: 0;
}

.hint,
.muted {
  color: var(--muted);
  font-size: 12px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row.between {
  justify-content: space-between;
  margin-top: 10px;
}

.msg {
  margin-top: 10px;
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 8px;
}

.msg.ok {
  background: rgba(62, 207, 142, 0.12);
  color: var(--ok);
}

.msg.err {
  background: rgba(255, 92, 92, 0.12);
  color: var(--err);
}

.preview {
  margin-top: 12px;
  padding: 12px;
  background: var(--panel-2);
  border-radius: 8px;
  border: 1px solid var(--border);
  font-size: 13px;
}

.preview.bad {
  border-color: rgba(255, 92, 92, 0.5);
}

.preview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px 16px;
}

.k {
  color: var(--muted);
  margin-right: 6px;
  font-size: 12px;
}

.gen {
  color: var(--accent-2);
  text-transform: uppercase;
}

.gen[data-gen='official'] {
  color: var(--warn);
}

.evidence {
  margin-top: 8px;
  color: var(--muted);
  font-size: 12px;
}

.evidence code {
  margin-right: 6px;
}

.warn-line {
  margin-top: 8px;
  color: var(--warn);
  font-size: 12px;
}
</style>
