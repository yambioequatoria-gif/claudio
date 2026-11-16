import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

/** Loads data when the screen gains focus and keeps it fresh while the screen stays open. */
export function usePolled<T>(load: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
      const timer = setInterval(refresh, intervalMs);
      return () => clearInterval(timer);
    }, [refresh, intervalMs]),
  );

  return { data, error, refresh, setData };
}
