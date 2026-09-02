export type CleanTaskView = {
  taskId: string;
  label: string;
  description: string;
  lifecycleState: string;
  tokenCount: number | null;
  charCount: number;
  tokenPercent: number | null;
  recommendation: "clean" | "keep" | "protected";
  reasonCodes: string[];
  selectable: boolean;
};

export type CleanPlanView = {
  planId: string;
  hostId: string;
  sessionId: string;
  contextWindowTokens?: number;
  usedTokens: number | null;
  usedChars: number;
  protectedTokens: number | null;
  protectedChars: number;
  unassignedTokens: number | null;
  unassignedChars: number;
  tokenCountMode: string;
  tasks: CleanTaskView[];
};

export type CleanReceiptView = {
  planId: string;
  status: string;
  selectedTaskIds: string[];
  estimatedSavedTokens: number | null;
  estimatedSavedChars: number;
  appliedSavedTokens?: number | null;
  appliedSavedChars?: number;
  fallbackUsed: boolean;
  deferredTaskIds: string[];
  reasons: string[];
};

function count(tokens: number | null, chars: number): string {
  return tokens === null ? `${chars} chars` : `${tokens} tok`;
}

function cell(value: string, width: number): string {
  return value.length > width
    ? `${value.slice(0, Math.max(0, width - 3))}...`
    : value.padEnd(width);
}

function risk(task: CleanTaskView): string {
  const level = task.recommendation === "protected" ? "blocked"
    : task.recommendation === "keep" ? "caution" : "low";
  return task.reasonCodes.length > 0 ? `${level}: ${task.reasonCodes.join(",")}` : level;
}

export function estimateCleanSelection(plan: CleanPlanView, selectedTaskIds: readonly string[]): {
  tokens: number | null;
  chars: number;
} {
  const selected = plan.tasks.filter((task) => selectedTaskIds.includes(task.taskId));
  return {
    tokens: selected.length === 0
      ? (plan.usedTokens === null ? null : 0)
      : selected.every((task) => task.tokenCount !== null)
      ? selected.reduce((total, task) => total + (task.tokenCount ?? 0), 0)
      : null,
    chars: selected.reduce((total, task) => total + task.charCount, 0),
  };
}

export function renderCleanPlan(plan: CleanPlanView): string {
  const rows = plan.tasks.map((task) => [
    task.selectable ? "[ ]" : "[-]",
    task.taskId,
    task.description,
    count(task.tokenCount, task.charCount),
    task.tokenPercent === null ? "-" : `${task.tokenPercent.toFixed(1)}%`,
    task.recommendation,
    risk(task),
  ]);
  const widths = [
    3,
    Math.max(18, "TASK".length, ...plan.tasks.map((task) => task.taskId.length)),
    22,
    10,
    7,
    9,
    17,
  ];
  const format = (row: string[]) => row.map((value, index) => cell(value, widths[index]!)).join("  ").trimEnd();
  const recommendedTaskIds = plan.tasks
    .filter((task) => task.selectable && task.recommendation === "clean")
    .map((task) => task.taskId);
  const recommended = estimateCleanSelection(plan, recommendedTaskIds);
  const usage = plan.contextWindowTokens !== undefined && plan.contextWindowTokens > 0 && plan.usedTokens !== null
    ? `${plan.usedTokens} / ${plan.contextWindowTokens} tok (${(plan.usedTokens / plan.contextWindowTokens * 100).toFixed(1)}%)`
    : count(plan.usedTokens, plan.usedChars);
  return [
    `Context clean plan ${plan.planId}`,
    `Host/session: ${plan.hostId} / ${plan.sessionId}`,
    `Context usage: ${usage} (${plan.tokenCountMode})`,
    `Protected context: ${count(plan.protectedTokens, plan.protectedChars)}`,
    `Unassigned context: ${count(plan.unassignedTokens, plan.unassignedChars)}`,
    "",
    format(["", "TASK", "DESCRIPTION", "SIZE", "SHARE", "ADVICE", "RISK / REASONS"]),
    format(widths.map((width) => "-".repeat(width))),
    ...rows.map(format),
    "",
    "Task details:",
    ...plan.tasks.map((task) => `- ${task.taskId}: ${task.description}`),
    "",
    "Reason codes:",
    ...plan.tasks
      .filter((task) => task.reasonCodes.length > 0)
      .map((task) => `- ${task.taskId}: ${task.reasonCodes.join(", ")}`),
    "",
    `Recommended selection estimate: ${count(recommended.tokens, recommended.chars)}`,
  ].join("\n");
}

export function renderCleanReceipt(receipt: CleanReceiptView): string {
  const lines = [
    `Context clean ${receipt.status}: ${receipt.planId}`,
    `Selected tasks: ${receipt.selectedTaskIds.length > 0 ? receipt.selectedTaskIds.join(", ") : "(none)"}`,
    `Estimated savings: ${count(receipt.estimatedSavedTokens, receipt.estimatedSavedChars)}`,
    `Scheduled savings: ${receipt.status === "scheduled" || receipt.status === "applied"
      ? count(receipt.estimatedSavedTokens, receipt.estimatedSavedChars)
      : "not scheduled"}`,
  ];
  if (receipt.status === "applied") {
    if (receipt.appliedSavedTokens !== undefined || receipt.appliedSavedChars !== undefined) {
      lines.push(`Applied savings: ${count(receipt.appliedSavedTokens ?? null, receipt.appliedSavedChars ?? 0)}`);
    } else {
      lines.push("Applied savings: unavailable (missing Host evidence)");
    }
  } else {
    lines.push("Applied savings: not applied");
  }
  lines.push(`Fallback count: ${receipt.fallbackUsed ? 1 : 0}`);
  if (receipt.status === "scheduled") lines.push("Apply timing: next Host request.");
  if (receipt.deferredTaskIds.length > 0) lines.push(`Deferred tasks: ${receipt.deferredTaskIds.join(", ")}`);
  if (receipt.reasons.length > 0) lines.push(`Reasons: ${receipt.reasons.join(", ")}`);
  return lines.join("\n");
}
