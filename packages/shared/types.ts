import type { BotCategory, ProcessingPhrases, WorkProgress } from './team';
export const AVATAR_SHAPES = [
  'wedge',
  'blob',
  'teardrop',
  'robot',
  'cat',
  'ghost',
  'flower',
  'heart',
  'cloud',
  'hex',
  'star',
  'house',
] as const;
export type Shape = (typeof AVATAR_SHAPES)[number];
export interface Avatar {
  shape: Shape;
  color: string;
  accent: string;
}
export interface Bot {
  id: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  avatar: Avatar;
  modelId: string | null;
  providerId?: string | null;
  reasoningEffort?: import('./model-effort').ReasoningEffort | null;
  enabled: boolean;
  sourceFile?: string;
  categoryId?: string | null;
  isPrototype?: boolean;
  prototypeId?: string;
  cloneTaskId?: string;
  cloneStatus?: 'active' | 'retired';
  archivedAt?: string;
  archiveState?: { enabled: boolean; routineIds: string[] };
  deletedAt?: string;
  processingPhrases?: ProcessingPhrases;
}
export type TaskType = 'general' | 'research' | 'coding' | 'writing' | 'planning';
export type Urgency = 'relaxed' | 'soon' | 'urgent';
export interface JobOptions {
  timezone?: string;
  urgency?: Urgency;
  importance?: 'normal' | 'high';
  task?: TaskType;
}
export interface HumanFeedback {
  rating: number;
  timing: 'unspecified' | 'worth-the-wait' | 'too-slow';
  note: string;
  updatedAt: string;
}
export interface ModelAttempt {
  modelId: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'switched';
  modelTimeMs: number;
  tokens: number;
  usageKnown: boolean;
  calls: number;
}
export interface WorkRecord {
  context?: {
    inputTokens: number;
    windowTokens?: number;
    reservedOutputTokens: number;
    compactions: number;
    status: 'ready' | 'compacting';
    source: 'loaded' | 'manual' | 'provider';
  };
  prototypeId?: string;
  id: string;
  botId: string;
  handoffId?: string;
  task: TaskType;
  urgency: Urgency;
  importance: 'normal' | 'high';
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  modelId?: string;
  attempts: ModelAttempt[];
  feedback?: HumanFeedback;
  progress?: WorkProgress;
  queued?: boolean;
}
export interface Provider {
  credentialId?: string;
  autoDiscover?: boolean;
  autoEnableModels?: boolean;
  followLoadedModels?: boolean;
  metadataSource?: 'lm-studio-v1' | 'lm-studio-v0' | 'openai';
  id: string;
  name: string;
  kind: 'openai-compatible' | 'openai-responses' | 'anthropic' | 'chatgpt' | 'claude-code';
  baseUrl: string;
  apiKeyEnv: string;
  enabled: boolean;
  local: boolean;
  timeoutMs: number;
  discoveredAt?: string;
  error?: string;
}
export interface Model {
  toolCalling?: 'auto' | 'enabled' | 'disabled';
  toolFormatUnsupported?: boolean;
  enablement?: 'auto' | 'manual';
  contextSource?: 'server' | 'manual';
  loadedContextTokens?: number;
  maxContextTokens?: number;
  loadState?: 'loaded' | 'unloaded' | 'unknown';
  modelType?: 'llm' | 'embedding' | 'other';
  supportsTools?: boolean;
  instanceId?: string;
  id: string;
  providerId: string;
  name: string;
  enabled: boolean;
  priority: number;
  costPerMillion: number;
  tasks: TaskType[];
  status: 'unknown' | 'online' | 'offline';
  lastError?: string;
  lastSeen?: string;
  contextTokens: number;
  reasoningEffort?: import('./model-effort').ReasoningEffort;
}
export interface Message {
  deliveryId?: string;
  senderBotId?: string;
  id: string;
  botId: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  displayContent?: string;
  createdAt: string;
  runId?: string;
  modelId?: string;
  workId?: string;
  steeringId?: string;
}
export interface Conversation {
  modelId?: string | null;
  reasoningEffort?: import('./model-effort').ReasoningEffort | null;
  contextCheckpointId?: string;
  spaceId?: string;
  id: string;
  botId: string;
  title: string;
  createdAt: string;
  contextResetAt?: string;
}
export interface TeamConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  legacy?: boolean;
}
export interface Memory {
  id: string;
  botId: string | null;
  category: 'profile' | 'behavior' | 'world' | 'workstream';
  content: string;
  createdAt: string;
  pinned?: boolean;
  runId?: string;
  taskId?: string;
  compacted?: boolean;
}
export interface Skill {
  id: string;
  name: string;
  content: string;
  description?: string;
  builtIn?: boolean;
  sourceFile?: string;
  /** Provenance only: every skill is shared, including after this bot is removed. */
  originBotId?: string;
  originBotName?: string;
  createdAt?: string;
  updatedAt?: string;
  runId?: string;
  apiId?: string;
}
export interface Routine {
  id: string;
  botId: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  nextRun?: string;
  lastRun?: string;
  source?: string;
  error?: string;
}
export interface Handoff {
  conversationId?: string;
  receivedAt?: string;
  id: string;
  parentId?: string;
  fromBotId: string;
  toBotId: string;
  brief: string;
  status: 'working' | 'completed' | 'failed' | 'cancelled';
  answer?: string;
  error?: string;
}
export interface RunEvent {
  at: string;
  kind:
    | 'start'
    | 'route'
    | 'fallback'
    | 'tool'
    | 'handoff'
    | 'complete'
    | 'error'
    | 'steer'
    | 'draft'
    | 'progress';
  botId: string;
  text: string;
  tool?: string;
  targetBotId?: string;
  phase?: 'preparing' | 'thinking' | 'responding' | 'delegating' | 'returned';
  task?: TaskType;
  handoffId?: string;
  handoff?: Handoff;
  steeringId?: string;
  draftId?: string;
}
export interface SteeringMessage {
  id: string;
  messageId: string;
  content: string;
  createdAt: string;
  appliedWorkIds: string[];
}
export interface Run {
  /** Set only by the server from the human's authenticated role. */
  panelAccess?: boolean;
  timezone?: string;
  id: string;
  origin?: 'chat' | 'routine';
  botId: string;
  conversationId: string;
  prompt: string;
  task: TaskType;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  modelId?: string;
  tokens: number;
  events: RunEvent[];
  error?: string;
  rating?: number;
  feedback?: HumanFeedback;
  feedbackRevision?: number;
  urgency?: Urgency;
  importance?: 'normal' | 'high';
  taskSource?: 'human' | 'automatic';
  work?: WorkRecord[];
  steering?: SteeringMessage[];
  revision?: number;
}
export type ActivityUpdate = (
  | { type: 'snapshot'; runs: Run[] }
  | { type: 'run'; run: Run }
  | { type: 'models'; models: Model[]; providers: Provider[] }
) & {
  bots?: Bot[];
};
export interface Page {
  publication?: {
    serviceId: string;
    site: string;
    publicUrl: string;
    shortUrl?: string;
    contentHash: string;
    publishedAt: string;
  };
  id: string;
  botId: string;
  title: string;
  content: string;
  format: 'markdown' | 'html' | 'code';
  filename?: string;
  language?: string;
  runId?: string;
  workspacePath?: string;
  createdAt: string;
}
export interface Incident {
  id: string;
  kind: 'models-unavailable';
  openedAt: string;
  resolvedAt?: string;
  message: string;
  deliveries: { channel: string; status: string; at: string }[];
}
export interface AlertChannel {
  credentialId?: string;
  enabled: boolean;
  url: string;
  tokenEnv: string;
  destination: string;
}
export interface Settings {
  mainBotId?: string | null;
  modelSelection?: 'auto' | 'manual';
  maxParallelModels?: number;
  maxBrowserSessions?: number;
  maxWorkerClones?: number;
  webSearchProvider?: 'google' | 'bing' | 'duckduckgo' | 'brave';
  localOnly: boolean;
  defaultModelId: string;
  maxOutputTokens: number;
  maxToolSteps: number;
  maxDelegationDepth: number;
  alertEmail: AlertChannel;
  alertSms: AlertChannel;
  alertCooldownMinutes: number;
}
export interface Assessment {
  botId?: string;
  modelId: string;
  task: TaskType;
  samples: number;
  average: number;
  successes: number;
  failures: number;
  averageDurationMs?: number;
  averageModelTimeMs?: number;
  averageTokens?: number;
  tokenSamples?: number;
  slowReports?: number;
  worthTheWait?: number;
}
export interface Bootstrap {
  accessRole?: 'owner' | 'operator' | 'viewer';
  categories?: BotCategory[];
  bots: Bot[];
  providers: Provider[];
  models: Model[];
  routines: Routine[];
  skills: Skill[];
  runs: Run[];
  pages: Page[];
  memory: Memory[];
  incidents: Incident[];
  settings: Settings;
  assessments: Assessment[];
  connections: { id: string; name: string; status: string; detail: string }[];
}
