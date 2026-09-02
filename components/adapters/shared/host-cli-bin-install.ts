import { chmod, copyFile, mkdir, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CliHostId } from "../../products/cli/src/hosts/registry.js";
import { installWindowsNodeCommandLauncher } from "./windows-command-launcher.js";

function hostCliDistPathFromAdapterRoot(adapterRoot: string): string {
  return resolve(adapterRoot, "dist", "cli.js");
}

function hostCliBinName(host: CliHostId): string {
  if (host === "codex") return "tokenpilot-codex";
  if (host === "claude-code") return "tokenpilot-claude-code";
  throw new Error(`unsupported host CLI bin install: ${host}`);
}

async function createCliLink(targetPath: string, binPath: string): Promise<void> {
  try {
    await symlink(targetPath, binPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (process.platform !== "win32" || !["EACCES", "EPERM", "UNKNOWN"].includes(code ?? "")) {
      throw error;
    }
    await copyFile(targetPath, binPath);
  }
}

export async function installHostCliBin(params: {
  adapterRoot: string;
  host: "codex" | "claude-code";
  binDir: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
}): Promise<{
  installed: boolean;
  binPath: string;
  launcherPath?: string;
  binName: string;
  cliDistPath: string;
}> {
  const binName = hostCliBinName(params.host);
  const cliDistPath = hostCliDistPathFromAdapterRoot(params.adapterRoot);
  const binPath = join(params.binDir, binName);

  await mkdir(dirname(binPath), { recursive: true });
  await chmod(cliDistPath, 0o755).catch(() => undefined);
  await unlink(binPath).catch(() => undefined);
  await createCliLink(cliDistPath, binPath);
  await chmod(binPath, 0o755).catch(() => undefined);
  const launcherPath = await installWindowsNodeCommandLauncher({
    binPath,
    targetPath: cliDistPath,
    platform: params.platform,
    nodePath: params.nodePath,
  });

  return {
    installed: true,
    binPath,
    launcherPath,
    binName,
    cliDistPath,
  };
}
