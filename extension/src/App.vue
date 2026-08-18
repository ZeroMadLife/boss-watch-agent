<script setup lang="ts">
import {
  AlertTriangle,
  BriefcaseBusiness,
  Check,
  Clipboard,
  Clock3,
  Database,
  FileSearch,
  LoaderCircle,
  MessageSquareText,
  Plug,
  RefreshCw,
  Save,
  Settings,
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  type ApplicationTimeline,
  type CaptureResponse,
  type ConversationAnalysisResponse,
  type HealthResponse,
  LocalApiClient,
  LocalApiError,
} from "./api.js";
import type { PageAdapterResult } from "./page-adapter.js";

type View = "current" | "timeline" | "settings";
type ConnectionState = "checking" | "disconnected" | "pairing" | "connected";

const api = new LocalApiClient(undefined, undefined, chrome.runtime.id);
const view = ref<View>("current");
const connection = ref<ConnectionState>("checking");
const health = ref<HealthResponse>();
const pairingCode = ref("");
const page = ref<PageAdapterResult>();
const applicationIds = ref<string[]>([]);
const applicationOptions = ref<Array<{ applicationId: string; company: string; role: string }>>([]);
const selectedApplicationId = ref("");
const busy = ref(false);
const errorCode = ref("");
const capture = ref<CaptureResponse>();
const analysis = ref<ConversationAnalysisResponse>();
const timeline = ref<ApplicationTimeline>();
const copied = ref(false);
let eventController: AbortController | undefined;

const modeLabel = computed(() => {
  if (health.value?.runtimeMode === "pi_ready") return "Pi 已就绪";
  if (health.value?.runtimeMode === "baseline_ready") return "规则分析";
  if (health.value?.runtimeMode === "capture_only") return "仅捕获";
  return "未连接";
});

const pageLabel = computed(() => {
  if (page.value?.status !== "ready") return "等待页面";
  return page.value.snapshot.pageKind === "job_detail" ? "岗位页" : "聊天页";
});

onMounted(async () => {
  await connect();
  chrome.tabs.onActivated.addListener(handleTabChange);
  chrome.tabs.onUpdated.addListener(handleTabUpdated);
});

onBeforeUnmount(() => {
  eventController?.abort();
  chrome.tabs.onActivated.removeListener(handleTabChange);
  chrome.tabs.onUpdated.removeListener(handleTabUpdated);
});

async function connect(): Promise<void> {
  connection.value = "checking";
  errorCode.value = "";
  try {
    health.value = await api.health();
  } catch {
    connection.value = "disconnected";
    return;
  }

  const stored = await chrome.storage.local.get(["clientToken", "lastApplicationId"]);
  const token = typeof stored.clientToken === "string" ? stored.clientToken : undefined;
  selectedApplicationId.value = typeof stored.lastApplicationId === "string" ? stored.lastApplicationId : "";
  if (!token) {
    connection.value = "pairing";
    return;
  }
  api.setToken(token);
  try {
    await loadApplications();
    connection.value = "connected";
    await inspectPage();
    startEventStream();
  } catch (error) {
    if (await resetIfUnauthorized(error)) return;
    connection.value = "disconnected";
  }
}

async function pair(): Promise<void> {
  if (!/^\d{6}$/u.test(pairingCode.value)) {
    errorCode.value = "请输入 6 位配对码";
    return;
  }
  busy.value = true;
  errorCode.value = "";
  try {
    const paired = await api.pair(pairingCode.value);
    api.setToken(paired.token);
    await chrome.storage.local.set({ clientToken: paired.token });
    connection.value = "connected";
    pairingCode.value = "";
    await loadApplications();
    await inspectPage();
    startEventStream();
  } catch (error) {
    if (await resetIfUnauthorized(error)) return;
    errorCode.value = errorLabel(error);
  } finally {
    busy.value = false;
  }
}

async function inspectPage(): Promise<void> {
  if (connection.value !== "connected") return;
  errorCode.value = "";
  capture.value = undefined;
  analysis.value = undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) {
      page.value = { status: "unsupported" };
      return;
    }
    page.value = (await chrome.tabs.sendMessage(tab.id, {
      type: "BOSS_WATCH_INSPECT",
      applicationId: selectedApplicationId.value || undefined,
    })) as PageAdapterResult;
  } catch {
    page.value = { status: "unsupported" };
  }
}

async function saveCurrent(): Promise<void> {
  if (page.value?.status !== "ready") return;
  busy.value = true;
  errorCode.value = "";
  analysis.value = undefined;
  try {
    const currentSnapshot = page.value.snapshot;
    capture.value = await api.capture(currentSnapshot);
    selectedApplicationId.value = capture.value.applicationId;
    await chrome.storage.local.set({ lastApplicationId: capture.value.applicationId });
    await loadApplications();
    await loadTimeline();
    if (currentSnapshot.pageKind === "conversation" && health.value?.runtimeMode !== "capture_only") {
      const mode = health.value?.runtimeMode === "pi_ready" ? "pi" : "baseline";
      analysis.value = await api.analyze(capture.value.eventId, currentSnapshot.pageRevision, mode);
    }
  } catch (error) {
    if (await resetIfUnauthorized(error)) return;
    errorCode.value = errorLabel(error);
  } finally {
    busy.value = false;
  }
}

async function loadApplications(): Promise<void> {
  const response = await api.applications();
  applicationIds.value = response.applicationIds;
  applicationOptions.value = response.applications;
  if (!applicationIds.value.includes(selectedApplicationId.value)) {
    selectedApplicationId.value = applicationIds.value.at(-1) ?? "";
  }
}

async function selectApplication(): Promise<void> {
  await chrome.storage.local.set({ lastApplicationId: selectedApplicationId.value });
  await inspectPage();
  await loadTimeline();
}

async function loadTimeline(): Promise<void> {
  if (!selectedApplicationId.value) {
    timeline.value = undefined;
    return;
  }
  try {
    timeline.value = await api.timeline(selectedApplicationId.value);
  } catch (error) {
    if (await resetIfUnauthorized(error)) return;
    errorCode.value = errorLabel(error);
  }
}

async function copyDraft(): Promise<void> {
  const text = analysis.value?.analysis.draft.text;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1500);
}

function handleTabChange(): void {
  void inspectPage();
}

function handleTabUpdated(_tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab): void {
  if (tab.active && (change.status === "complete" || change.url !== undefined)) void inspectPage();
}

function startEventStream(): void {
  eventController?.abort();
  const controller = new AbortController();
  eventController = controller;
  void api
    .watchEvents(controller.signal, (event) => {
      if (event === "capture" || event === "analysis") void loadTimeline();
    })
    .catch(async (error: unknown) => {
      if (controller !== eventController) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (await resetIfUnauthorized(error)) return;
      errorCode.value = errorLabel(error);
    });
}

async function resetIfUnauthorized(error: unknown): Promise<boolean> {
  if (!(error instanceof LocalApiError) || error.status !== 401) return false;
  await resetAuthentication();
  return true;
}

async function resetAuthentication(): Promise<void> {
  eventController?.abort();
  eventController = undefined;
  await chrome.storage.local.remove("clientToken");
  api.setToken(undefined);
  page.value = undefined;
  capture.value = undefined;
  analysis.value = undefined;
  timeline.value = undefined;
  errorCode.value = "";
  connection.value = "pairing";
  view.value = "current";
}

function errorLabel(error: unknown): string {
  if (!(error instanceof LocalApiError)) return "本地服务请求失败";
  const labels: Record<string, string> = {
    invalid_pairing_code: "配对码不正确",
    pairing_attempts_exceeded: "配对尝试次数已用完，请重启服务",
    pairing_code_expired: "配对码已过期，请重启服务",
    pairing_code_consumed: "配对码已使用，请重启服务获取新配对码",
    page_revision_mismatch: "页面内容已变化，请重新读取",
    stale_page_revision: "页面内容已变化，请重新捕获",
    application_not_found: "请选择已保存的岗位",
    pi_not_ready: "Pi 模型尚未配置",
  };
  return labels[error.code] ?? `请求失败：${error.code}`;
}

function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    job_description_captured: "岗位 JD 已保存",
    recruiter_message_captured: "招聘方消息已保存",
    interview_note_recorded: "面试记录已保存",
    status_change_proposed: "状态变更待确认",
  };
  return labels[type] ?? type;
}

function applicationLabel(applicationId: string): string {
  const application = applicationOptions.value.find((item) => item.applicationId === applicationId);
  return application === undefined ? applicationId : `${application.role} · ${application.company}`;
}
</script>

<template>
  <main class="app-shell">
    <header class="app-header">
      <div class="brand-mark"><BriefcaseBusiness :size="18" /></div>
      <div class="brand-copy">
        <h1>Boss Watch</h1>
        <p>本地求职事实台</p>
      </div>
      <button class="icon-button" type="button" title="刷新当前状态" :disabled="busy" @click="connect">
        <RefreshCw :size="17" :class="{ spinning: connection === 'checking' }" />
      </button>
    </header>

    <section class="status-strip" aria-label="运行状态">
      <span :class="['status-dot', connection === 'connected' ? 'online' : 'offline']"></span>
      <span>{{ connection === "connected" ? "本地服务" : "未连接" }}</span>
      <span class="status-divider"></span>
      <span>{{ pageLabel }}</span>
      <span class="status-divider"></span>
      <span>{{ modeLabel }}</span>
    </section>

    <section class="workspace">
      <template v-if="view === 'current'">
        <div v-if="connection === 'checking'" class="state-panel">
          <LoaderCircle class="spinning" :size="28" />
          <h2>正在连接本地服务</h2>
        </div>

        <div v-else-if="connection === 'disconnected'" class="state-panel">
          <Plug :size="28" />
          <h2>本地服务未启动</h2>
          <code>npm run serve</code>
          <button class="secondary-button" type="button" @click="connect">
            <RefreshCw :size="16" />重新连接
          </button>
        </div>

        <form v-else-if="connection === 'pairing'" class="pairing-panel" @submit.prevent="pair">
          <div class="section-icon"><Plug :size="20" /></div>
          <h2>连接本地服务</h2>
          <label for="pairing-code">配对码</label>
          <input
            id="pairing-code"
            v-model="pairingCode"
            inputmode="numeric"
            maxlength="6"
            autocomplete="one-time-code"
            placeholder="000000"
          />
          <button class="primary-button" type="submit" :disabled="busy">
            <LoaderCircle v-if="busy" class="spinning" :size="16" />
            <Plug v-else :size="16" />
            完成配对
          </button>
        </form>

        <template v-else>
          <div v-if="page?.status === 'unsupported' || page === undefined" class="state-panel">
            <FileSearch :size="28" />
            <h2>当前页面不受支持</h2>
            <p class="empty-copy">支持岗位详情页和已选中的 BOSS 聊天会话</p>
          </div>

          <div v-else-if="page.status === 'human_required'" class="state-panel warning-state">
            <AlertTriangle :size="28" />
            <h2>{{ page.reason === "login" ? "请先人工登录" : "请先完成人工验证" }}</h2>
          </div>

          <div v-else-if="page.status === 'page_adapter_mismatch'" class="state-panel warning-state">
            <AlertTriangle :size="28" />
            <h2>页面结构暂未识别</h2>
            <button class="secondary-button" type="button" @click="inspectPage">
              <RefreshCw :size="16" />重新读取
            </button>
          </div>

          <div v-else-if="page.status === 'application_required'" class="content-section">
            <div class="section-heading">
              <MessageSquareText :size="18" />
              <h2>关联投递</h2>
            </div>
            <select v-model="selectedApplicationId" @change="selectApplication">
              <option value="" disabled>选择已保存岗位</option>
              <option v-for="id in applicationIds" :key="id" :value="id">{{ applicationLabel(id) }}</option>
            </select>
            <p v-if="applicationIds.length === 0" class="empty-copy">尚无已保存岗位</p>
          </div>

          <div v-else-if="page.status === 'ready'" class="content-section">
            <div class="section-heading">
              <BriefcaseBusiness v-if="page.snapshot.pageKind === 'job_detail'" :size="18" />
              <MessageSquareText v-else :size="18" />
              <h2>{{ page.snapshot.pageKind === "job_detail" ? page.snapshot.role : page.snapshot.recruiterName }}</h2>
            </div>

            <template v-if="page.snapshot.pageKind === 'job_detail'">
              <p class="meta-line">{{ page.snapshot.company }}</p>
              <p class="evidence-preview">{{ page.snapshot.description }}</p>
            </template>
            <template v-else>
              <select v-model="selectedApplicationId" @change="selectApplication">
                <option v-for="id in applicationIds" :key="id" :value="id">{{ applicationLabel(id) }}</option>
              </select>
              <blockquote>{{ page.snapshot.messageText }}</blockquote>
            </template>

            <button class="primary-button" type="button" :disabled="busy" @click="saveCurrent">
              <LoaderCircle v-if="busy" class="spinning" :size="16" />
              <Save v-else :size="16" />
              {{ page.snapshot.pageKind === "job_detail" ? "保存当前岗位" : "保存并分析" }}
            </button>
          </div>

          <div v-if="capture" class="result-band success-band">
            <Check :size="17" />
            <div>
              <strong>{{ capture.deduplicated ? "证据已存在" : "证据已保存" }}</strong>
              <p>{{ capture.contentHash.slice(0, 12) }} · {{ new Date(capture.savedAt).toLocaleString() }}</p>
            </div>
          </div>

          <div v-if="analysis" class="analysis-section">
            <div class="analysis-title">
              <span>分析结果</span>
              <span class="mode-badge">{{ analysis.mode === "pi" ? "Pi" : "Baseline" }}</span>
            </div>
            <dl>
              <dt>意图</dt>
              <dd>{{ analysis.analysis.intent }}</dd>
              <dt>原文证据</dt>
              <dd>{{ analysis.analysis.evidence?.quote }}</dd>
              <dt>回复草稿</dt>
              <dd class="draft-row">
                <span>{{ analysis.analysis.draft.text }}</span>
                <button class="icon-button compact" type="button" title="复制回复草稿" @click="copyDraft">
                  <Check v-if="copied" :size="15" />
                  <Clipboard v-else :size="15" />
                </button>
              </dd>
            </dl>
          </div>
        </template>
      </template>

      <template v-else-if="view === 'timeline'">
        <div class="section-heading timeline-heading">
          <Clock3 :size="18" />
          <h2>投递时间线</h2>
          <button class="icon-button compact" type="button" title="刷新时间线" @click="loadTimeline">
            <RefreshCw :size="15" />
          </button>
        </div>
        <select v-model="selectedApplicationId" @change="loadTimeline">
          <option value="" disabled>选择投递</option>
          <option v-for="id in applicationIds" :key="id" :value="id">{{ applicationLabel(id) }}</option>
        </select>
        <ol v-if="timeline?.events.length" class="timeline-list">
          <li v-for="event in timeline.events" :key="event.eventId">
            <span class="timeline-sequence">{{ event.sequence }}</span>
            <div>
              <strong>{{ eventLabel(event.type) }}</strong>
              <p>{{ new Date(event.occurredAt).toLocaleString() }}</p>
            </div>
          </li>
        </ol>
        <div v-else class="state-panel compact-state">
          <Clock3 :size="24" />
          <h2>暂无事件</h2>
        </div>
      </template>

      <template v-else>
        <div class="section-heading">
          <Settings :size="18" />
          <h2>本地设置</h2>
        </div>
        <dl class="settings-list">
          <div><dt>服务地址</dt><dd>{{ api.baseUrl }}</dd></div>
          <div><dt>连接状态</dt><dd>{{ connection === "connected" ? "已配对" : "未配对" }}</dd></div>
          <div><dt>分析模式</dt><dd>{{ modeLabel }}</dd></div>
          <div><dt>数据存储</dt><dd><Database :size="14" />SQLite</dd></div>
          <div><dt>版本</dt><dd>{{ health?.version ?? "-" }}</dd></div>
        </dl>
        <button
          v-if="connection === 'connected'"
          class="secondary-button settings-action"
          type="button"
          @click="resetAuthentication"
        >
          <RefreshCw :size="16" />重新配对
        </button>
      </template>

      <div v-if="errorCode" class="error-band" role="alert">
        <AlertTriangle :size="16" />{{ errorCode }}
      </div>
    </section>

    <nav class="bottom-nav" aria-label="主要视图">
      <button :class="{ active: view === 'current' }" type="button" @click="view = 'current'">
        <BriefcaseBusiness :size="18" />当前
      </button>
      <button :class="{ active: view === 'timeline' }" type="button" @click="view = 'timeline'; loadTimeline()">
        <Clock3 :size="18" />时间线
      </button>
      <button :class="{ active: view === 'settings' }" type="button" @click="view = 'settings'">
        <Settings :size="18" />设置
      </button>
    </nav>
  </main>
</template>
