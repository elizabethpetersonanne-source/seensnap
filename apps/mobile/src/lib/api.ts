import Constants from "expo-constants";
import { Platform } from "react-native";

/**
 * Resolve the SeenSnap API base URL for the current runtime.
 *
 * Precedence:
 *   1. `EXPO_PUBLIC_API_BASE_URL` env var — always wins. This is what
 *      Netlify/EAS/staging/prod sets. Never a "silent fallback".
 *   2. `Constants.expoConfig.hostUri` — Metro dev-tunnel derivation.
 *      ONLY used for native dev with `expo start`, and NEVER on web.
 *      This is the local-dev convenience path so you don't have to
 *      configure an env var every time your LAN IP changes.
 *
 * If neither produces a URL, we return `null`. Callers see this as an
 * unconfigured state: `apiRequest()` throws with a clear message, and
 * `resolvedApiBaseUrl` exports `""` so sign-in surfaces can display it
 * verbatim (they already read `resolvedApiBaseUrl`). There is
 * intentionally no `127.0.0.1` / `localhost` / `trycloudflare.com`
 * fallback — that historically caused staging bundles to silently
 * point at a developer's laptop.
 */
function resolveApiBaseUrl(): string | null {
  const configured = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  if (configured) return configured;

  // Web bundles have no dev-tunnel fallback — hostUri only exists inside
  // Metro's runtime. If EXPO_PUBLIC_API_BASE_URL wasn't set at build time,
  // the browser build has no API to talk to and should say so out loud.
  if (Platform.OS === "web") return null;

  const expoManifest = Constants as typeof Constants & {
    manifest2?: { extra?: { expoClient?: { hostUri?: string } } };
  };
  const hostUri =
    Constants.expoConfig?.hostUri ?? expoManifest.manifest2?.extra?.expoClient?.hostUri;
  const host = hostUri?.split(":")[0];
  if (host) return `http://${host}:8000/api/v1`;

  return null;
}

const apiBaseUrl = resolveApiBaseUrl();
export const resolvedApiBaseUrl = apiBaseUrl ?? "";

function resolveApiOrigin(): string | null {
  if (!apiBaseUrl) return null;
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    return null;
  }
}

const apiOrigin = resolveApiOrigin();

const MISSING_API_URL_MESSAGE =
  "SeenSnap API URL is not configured. Set EXPO_PUBLIC_API_BASE_URL to your staging or production API (including /api/v1). See apps/mobile/.env.example.";

type ApiRequestOptions = RequestInit & {
  token?: string | null;
};

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  if (!apiBaseUrl) {
    throw new Error(MISSING_API_URL_MESSAGE);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const headers = new Headers(options.headers);
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (!headers.has("Content-Type") && !isFormData) {
    headers.set("Content-Type", "application/json");
  }

  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  if (apiBaseUrl.includes(".loca.lt")) {
    headers.set("bypass-tunnel-reminder", "true");
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers,
      signal: options.signal ?? controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out (${apiBaseUrl})`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function resolveMediaUrl(uri?: string | null): string | null {
  if (!uri) return null;
  if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
  if (!apiOrigin) return null;
  if (uri.startsWith("/")) return `${apiOrigin}${uri}`;
  return `${apiOrigin}/${uri}`;
}
