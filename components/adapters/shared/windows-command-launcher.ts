import { writeFile } from "node:fs/promises";

function escapeCmdLiteral(value: string): string {
  return value.replaceAll("^", "^^").replaceAll("%", "%%");
}

export async function installWindowsNodeCommandLauncher(params: {
  binPath: string;
  targetPath: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
}): Promise<string | undefined> {
  if ((params.platform ?? process.platform) !== "win32") return undefined;

  const launcherPath = `${params.binPath}.cmd`;
  const nodePath = escapeCmdLiteral(params.nodePath ?? process.execPath);
  const targetPath = escapeCmdLiteral(params.targetPath);
  await writeFile(
    launcherPath,
    `@echo off\r\n"${nodePath}" "${targetPath}" %*\r\n`,
    "utf8",
  );
  return launcherPath;
}
