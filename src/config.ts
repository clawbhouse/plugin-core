import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".clawbhouse");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface ClawbhouseConfig {
  agentId: string;
  name: string;
  serverUrl: string;
  privateKey: string;
  publicKey: string;
}

export async function loadConfig(): Promise<ClawbhouseConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as ClawbhouseConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(config: ClawbhouseConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export { CONFIG_DIR, CONFIG_PATH };
