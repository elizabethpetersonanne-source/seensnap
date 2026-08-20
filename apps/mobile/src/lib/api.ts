import Constants from "expo-constants";

function isLoopbackApiUrl(value?: string | null) {
  if (!value?.trim()) {
    return false;
  }
  try {
    const host = new URL(value.trim()).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

function resolveApiBaseUrl() {
  const configApiBaseUrl =
    (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl?.trim() ?? "";
  const configured = process.env.EXPO_PUBLIC_API_BASE_URL;

  if (configured?.trim() && !isLoopbackApiUrl(configured)) {
    return configured.trim();
  }

  if (configApiBaseUrl && !isLoopbackApiUrl(configApiBaseUrl)) {
    return configApiBaseUrl;
  }

  const expoManifest = Constants as typeof Constants & {
    manifest2?: { extra?: { expoClient?: { hostUri?: string } } };
  };
  const hostUri = Constants.expoConfig?.hostUri ?? expoManifest.manifest2?.extra?.expoClient?.hostUri;
  const host = hostUri?.split(":")[0];
  if (host) {
    return `http://${host}:8000/api/v1`;
  }

  return configured?.trim() || configApiBaseUrl || "http://127.0.0.1:8000/api/v1";
}

const apiBaseUrl = resolveApiBaseUrl();
export const resolvedApiBaseUrl = apiBaseUrl;

function resolveApiOrigin() {
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    return "http://127.0.0.1:8000";
  }
}

const apiOrigin = resolveApiOrigin();

type ApiRequestOptions = RequestInit & {
  token?: string | null;
};

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
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
  if (!uri) {
    return null;
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    return uri;
  }
  if (uri.startsWith("/")) {
    return `${apiOrigin}${uri}`;
  }
  return `${apiOrigin}/${uri}`;
}
