import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, symlink, unlink } from "node:fs/promises";
import { join, resolve, delimiter } from "node:path";
import { installWindowsNodeCommandLauncher } from "./windows-command-launcher.js";

function cliDistPathFromAdapterRoot(adapterRoot: string): string {
  const bundledPath = resolve(adapterRoot, "dist", "lightrsi.js");
  if (existsSync(bundledPath)) return bundledPath;
  return resolve(adapterRoot, "..", "..", "products", "cli", "dist", "cli.js");
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

export async function installLightRsiCliBin(params: {
  adapterRoot: string;
  homeDir?: string;
  binDir?: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
}): Promise<{
  installed: boolean;
  binPath: string;
  launcherPath?: string;
  legacyLauncherPath?: string;
  binDir: string;
  cliDistPath: string;
  binDirOnPath: boolean;
}> {
  const homeDir = params.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const binDir = params.binDir
    ?? process.env.LIGHTRSI_BIN_DIR
    ?? process.env.LIGHTMEM2_BIN_DIR
    ?? join(homeDir, ".local", "bin");
  const cliDistPath = cliDistPathFromAdapterRoot(params.adapterRoot);
  const binPath = join(binDir, "lightrsi");
  const legacyBinPath = join(binDir, "lightmem2");
  const binDirOnPath = String(process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => resolve(entry) === resolve(binDir));

  if (!existsSync(cliDistPath)) {
    return {
      installed: false,
      binPath,
      binDir,
      cliDistPath,
      binDirOnPath,
    };
  }

  await mkdir(binDir, { recursive: true });
  await chmod(cliDistPath, 0o755).catch(() => undefined);
  await unlink(binPath).catch(() => undefined);
  await createCliLink(cliDistPath, binPath);
  await chmod(binPath, 0o755).catch(() => undefined);
  await unlink(legacyBinPath).catch(() => undefined);
  await createCliLink(cliDistPath, legacyBinPath);
  await chmod(legacyBinPath, 0o755).catch(() => undefined);
  const launcherPath = await installWindowsNodeCommandLauncher({
    binPath,
    targetPath: cliDistPath,
    platform: params.platform,
    nodePath: params.nodePath,
  });
  const legacyLauncherPath = await installWindowsNodeCommandLauncher({
    binPath: legacyBinPath,
    targetPath: cliDistPath,
    platform: params.platform,
    nodePath: params.nodePath,
  });

  return {
    installed: true,
    binPath,
    launcherPath,
    legacyLauncherPath,
    binDir,
    cliDistPath,
    binDirOnPath,
  };
}
