import {
  ANTIGRAVITY_HEADERS,
  LOAD_ENDPOINTS,
  DEFAULT_PROJECT_ID,
} from "./constants";

let cachedProjectId: string | null = null;

async function loadManagedProject(accessToken: string): Promise<string | null> {
  const body = JSON.stringify({
    metadata: {
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  });

  for (const base of LOAD_ENDPOINTS) {
    try {
      const res = await fetch(`${base}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...ANTIGRAVITY_HEADERS,
        },
        body,
      });

      if (!res.ok) continue;

      const data = (await res.json()) as {
        cloudaicompanionProject?: string | { id?: string };
      };

      if (typeof data.cloudaicompanionProject === "string") {
        return data.cloudaicompanionProject;
      }
      if (
        data.cloudaicompanionProject &&
        typeof data.cloudaicompanionProject.id === "string"
      ) {
        return data.cloudaicompanionProject.id;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function getProjectId(accessToken: string): Promise<string> {
  if (cachedProjectId) return cachedProjectId;
  const managed = await loadManagedProject(accessToken);
  cachedProjectId = managed ?? DEFAULT_PROJECT_ID;
  return cachedProjectId;
}
