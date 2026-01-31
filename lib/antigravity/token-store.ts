import { promises as fs } from "node:fs";
import path from "node:path";

export interface AntigravityTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number | null;
  tokenType: string | null;
  scope: string | null;
  obtainedAt: number;
}

const APP_DIR = ".antigravity-chat";
const TOKEN_FILE = "auth.json";

function getHome(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error("Cannot resolve home directory");
  return home;
}

export function getTokenFilePath(): string {
  return path.join(getHome(), APP_DIR, TOKEN_FILE);
}

export async function saveTokens(tokens: AntigravityTokens): Promise<void> {
  const filePath = getTokenFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(tokens, null, 2), "utf8");
}

export async function loadTokens(): Promise<AntigravityTokens | null> {
  try {
    const raw = await fs.readFile(getTokenFilePath(), "utf8");
    return JSON.parse(raw) as AntigravityTokens;
  } catch {
    return null;
  }
}

export async function tokensExist(): Promise<boolean> {
  try {
    await fs.access(getTokenFilePath());
    return true;
  } catch {
    return false;
  }
}
