import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'session-token';

// Native builds keep the session in the OS keychain/keystore; browsers have no equivalent, so the
// web build falls back to localStorage.
export async function loadToken(): Promise<string | null> {
  try {
    if (Platform.OS === 'web') return globalThis.localStorage?.getItem(KEY) ?? null;
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

export async function saveToken(token: string | null): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (token) globalThis.localStorage?.setItem(KEY, token);
      else globalThis.localStorage?.removeItem(KEY);
    } else if (token) await SecureStore.setItemAsync(KEY, token);
    else await SecureStore.deleteItemAsync(KEY);
  } catch {
    // Storage can be unavailable (private browsing); the session then lasts until the app closes.
  }
}
