import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

/**
 * Platform-aware key/value storage for auth session material.
 *
 * Native: expo-secure-store (Keychain on iOS, EncryptedSharedPreferences on
 * Android) — the values are actual tokens so we want the OS secure store.
 *
 * Web QA: localStorage. Browser secure storage doesn't exist in a form we can
 * rely on across all target browsers; localStorage is the pragmatic choice
 * for internal alpha. Users log out to end their session — same as the
 * native app.
 *
 * The API mirrors SecureStore's async signature so callers don't need to
 * branch on platform.
 */

const isWeb = Platform.OS === "web";

function webStorage(): Storage | null {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return null;
  }
  return window.localStorage;
}

export async function getItem(key: string): Promise<string | null> {
  if (isWeb) {
    return webStorage()?.getItem(key) ?? null;
  }
  return SecureStore.getItemAsync(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  if (isWeb) {
    webStorage()?.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export async function deleteItem(key: string): Promise<void> {
  if (isWeb) {
    webStorage()?.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}
