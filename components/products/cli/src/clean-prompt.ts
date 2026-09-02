import { emitKeypressEvents } from "node:readline";

import { estimateCleanSelection, renderCleanPlan, type CleanPlanView } from "./clean-renderer.js";

export type CleanTaskPrompt = (plan: CleanPlanView) => Promise<string[] | undefined>;

export function createInitialCleanPromptState(plan: CleanPlanView): {
  selectedTaskIds: string[];
  text: string;
} {
  return {
    selectedTaskIds: [],
    text: renderCleanPlan(plan),
  };
}

export async function promptForCleanTasks(plan: CleanPlanView): Promise<string[] | undefined> {
  const choices = plan.tasks.filter((task) => task.selectable);
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;

  const initial = createInitialCleanPromptState(plan);
  process.stdout.write(`${initial.text}\n\n`);
  if (choices.length === 0) return [];

  const selected = new Set(initial.selectedTaskIds);
  let cursor = 0;
  emitKeypressEvents(process.stdin);
  const render = (first: boolean) => {
    if (!first) process.stdout.write(`\u001b[${choices.length + 2}A`);
    process.stdout.write("Select tasks to clean (up/down move, space toggle, enter confirm, q cancel)\n");
    for (const [index, task] of choices.entries()) {
      const marker = index === cursor ? ">" : " ";
      const checked = selected.has(task.taskId) ? "x" : " ";
      process.stdout.write(`${marker} [${checked}] ${task.taskId} - ${task.label}\u001b[K\n`);
    }
    const estimate = estimateCleanSelection(plan, [...selected]);
    const estimateText = estimate.tokens === null ? `${estimate.chars} chars` : `${estimate.tokens} tok`;
    process.stdout.write(`Selected estimated release: ${estimateText}\u001b[K\n`);
  };

  return new Promise<string[] | undefined>((resolve, reject) => {
    const previousRaw = process.stdin.isRaw;
    let confirming = false;
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode?.(Boolean(previousRaw));
      process.stdin.pause();
      if (confirming) process.stdout.write("\n");
      process.stdout.write("\u001b[?25h");
    };
    const finish = (value: string[] | undefined) => {
      cleanup();
      resolve(value);
    };
    const onKeypress = (_value: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("clean_selection_interrupted"));
        return;
      }
      if (confirming) {
        if (key.name === "y") return finish(
          choices.filter((task) => selected.has(task.taskId)).map((task) => task.taskId),
        );
        if (key.name === "return" || key.name === "enter" || key.name === "n"
          || key.name === "escape" || key.name === "q") return finish(undefined);
        return;
      }
      if (key.name === "q" || key.name === "escape") return finish(undefined);
      if (key.name === "return" || key.name === "enter") {
        if (selected.size === 0) return finish([]);
        confirming = true;
        process.stdout.write("Confirm clean? [y/N] ");
        return;
      }
      if (key.name === "up") cursor = (cursor + choices.length - 1) % choices.length;
      else if (key.name === "down") cursor = (cursor + 1) % choices.length;
      else if (key.name === "space") {
        const taskId = choices[cursor]!.taskId;
        if (selected.has(taskId)) selected.delete(taskId);
        else selected.add(taskId);
      } else return;
      render(false);
    };
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    process.stdout.write("\u001b[?25l");
    render(true);
  });
}
