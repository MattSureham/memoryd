import type { AgentProfile, InputEvent, ScopeRef } from "../contracts.js";

export interface TaskFeatures {
  taskType: "coding" | "visual" | "recall" | "conversation";
  userIntent: string;
  hasImage: boolean;
  hasCurrentEvidence: boolean;
  asksForVisibleDetail: boolean;
  asksToRecall: boolean;
  asksForIdentity: boolean;
  multipleEntities: boolean;
  destructiveIntent: boolean;
  containsSecretMaterial: boolean;
  mentionsOtherWorkspace: boolean;
  likelyStaleReference: boolean;
  narrativeCue: boolean;
  contextAge: "short" | "long" | "unknown";
  entitiesCount: number;
  agentFamily: string;
  agentVersion: string;
  toolsetDigest?: string;
  workspacePresent: boolean;
}

const IMAGE_MEDIA = /^(image\/|application\/pdf$)/i;
const RECALL_CUE = /\b(remember|recall|last time|previously|earlier session|old conversation)\b|记得|回忆|上次|以前|之前(?:的)?对话/i;
const VISIBLE_DETAIL = /\b(what(?:'s| is) (?:in|shown)|visible|screenshot|image|picture|scene|frame)\b|图中|截图|画面|这一幕|看起来/i;
const IDENTITY_QUESTION = /\b(who|which person|identity|identify|whose)\b|是谁|哪个人|身份|辨认/i;
const DESTRUCTIVE = /\b(rm\s+-rf|drop\s+(?:table|database)|truncate\s+table|git\s+reset\s+--hard|git\s+push\s+.*--force|delete\s+all|wipe|destroy)\b|删除全部|清空数据库|强制推送/i;
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)\b/;
const OTHER_WORKSPACE = /\b(other|another|different)\s+(?:repo|repository|workspace|project)\b|另一个(?:仓库|项目|工作区)|其他(?:仓库|项目|工作区)/i;
const STALE_CUE = /\b(old|previous|historical|formerly|used to|before the refactor|last commit)\b|旧版|历史|重构前|以前的代码|上个提交/i;
const NARRATIVE_CUE = /\b(scene|plot|story|episode|what happened|off[- ]screen)\b|剧情|这一幕|发生了什么|镜头外|故事/i;
const CODE_CUE = /\b(code|function|class|method|repository|repo|test|build|compile|bug|file|commit|branch|api)\b|代码|函数|类|方法|仓库|测试|构建|编译|提交|分支|接口/i;
const USER_INTENTS = new Set([
  "unspecified",
  "inspect",
  "explain",
  "recall",
  "remember",
  "modify",
  "debug",
  "test",
  "review",
  "delete",
  "plan",
]);

function countEntityLikeTokens(content: string): number {
  const latin = content.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? [];
  const quoted = content.match(/["'“”‘’`][^"'“”‘’`\n]{2,40}["'“”‘’`]/g) ?? [];
  return new Set([...latin, ...quoted]).size;
}

function metadataBoolean(event: InputEvent, key: string): boolean {
  return event.metadata?.[key] === true;
}

function normalizedUserIntent(value: unknown): string {
  if (typeof value !== "string") return "unspecified";
  const normalized = value.trim().toLowerCase();
  return USER_INTENTS.has(normalized) ? normalized : "unspecified";
}

export function extractFeatures(
  event: InputEvent,
  scope: ScopeRef,
  agent: AgentProfile,
): TaskFeatures {
  const content = event.content;
  const attachments = event.attachments ?? [];
  const hasImage =
    attachments.some((item) => item.mediaType !== undefined && IMAGE_MEDIA.test(item.mediaType)) ||
    metadataBoolean(event, "hasImage");
  const asksToRecall = RECALL_CUE.test(content);
  const asksForVisibleDetail = VISIBLE_DETAIL.test(content);
  const inferredEntities = countEntityLikeTokens(content);
  const reportedEntities = Number(event.metadata?.entitiesCount);
  const entitiesCount = Number.isFinite(reportedEntities)
    ? Math.max(inferredEntities, Math.max(0, Math.floor(reportedEntities)))
    : inferredEntities;
  const contextAge =
    event.metadata?.contextAge === "long"
      ? "long"
      : event.metadata?.contextAge === "short"
        ? "short"
        : "unknown";
  const taskType = hasImage
    ? "visual"
    : CODE_CUE.test(content)
      ? "coding"
      : asksToRecall
        ? "recall"
        : "conversation";

  return {
    taskType,
    userIntent: normalizedUserIntent(event.metadata?.userIntent),
    hasImage,
    // Current evidence is authoritative only after memory_checkpoint_evidence.
    // Caller-controlled metadata must not be able to bypass the server gate.
    hasCurrentEvidence: false,
    asksForVisibleDetail,
    asksToRecall,
    asksForIdentity: IDENTITY_QUESTION.test(content),
    multipleEntities: entitiesCount >= 2,
    destructiveIntent: DESTRUCTIVE.test(content),
    containsSecretMaterial: SECRET_VALUE.test(content),
    mentionsOtherWorkspace: OTHER_WORKSPACE.test(content) || metadataBoolean(event, "workspaceMismatch"),
    likelyStaleReference: STALE_CUE.test(content) || (asksToRecall && taskType === "coding"),
    narrativeCue: NARRATIVE_CUE.test(content),
    contextAge,
    entitiesCount,
    agentFamily: agent.family,
    agentVersion: agent.version,
    ...(agent.toolsetDigest === undefined ? {} : { toolsetDigest: agent.toolsetDigest }),
    workspacePresent: scope.workspaceId !== undefined,
  };
}

/** Classifiers receive this projection, never the raw user prompt or episode text. */
export function compressedClassifierFeatures(features: TaskFeatures): Record<string, unknown> {
  return {
    taskType: features.taskType,
    userIntent: features.userIntent,
    hasImage: features.hasImage,
    hasCurrentEvidence: features.hasCurrentEvidence,
    asksForVisibleDetail: features.asksForVisibleDetail,
    asksToRecall: features.asksToRecall,
    asksForIdentity: features.asksForIdentity,
    multipleEntities: features.multipleEntities,
    destructiveIntent: features.destructiveIntent,
    containsSecretMaterial: features.containsSecretMaterial,
    mentionsOtherWorkspace: features.mentionsOtherWorkspace,
    likelyStaleReference: features.likelyStaleReference,
    narrativeCue: features.narrativeCue,
    contextAge: features.contextAge,
    entitiesCount: features.entitiesCount,
    agentFamily: features.agentFamily,
    agentVersion: features.agentVersion,
    toolsetDigest: features.toolsetDigest ?? "unknown",
    workspacePresent: features.workspacePresent,
  };
}
