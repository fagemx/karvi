import { useEffect, useRef, useCallback } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import EventSource from 'react-native-sse';

type KarviSSEEvents = 'connected' | 'board' | 'brief' | 'error';
import { useBoardStore } from './useBoardStore';

const POLL_INTERVAL = 15_000; // 15s — longer than web (5s) for battery

export function useSSE() {
  const serverUrl = useBoardStore((s) => s.serverUrl);
  const apiToken = useBoardStore((s) => s.apiToken);
  const setBoard = useBoardStore((s) => s.setBoard);
  const setStatus = useBoardStore((s) => s.setConnectionStatus);
  const esRef = useRef<EventSource | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopAll = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current || !serverUrl) return;
    setStatus('polling');
    const poll = async () => {
      try {
        const headers: Record<string, string> = {};
        if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;
        const res = await fetch(`${serverUrl}/api/board`, { headers });
        if (res.ok) setBoard(await res.json());
      } catch {
        // silent — keep polling
      }
    };
    poll(); // immediate first fetch
    pollingRef.current = setInterval(poll, POLL_INTERVAL);
  }, [serverUrl, apiToken, setBoard, setStatus]);

  const connectSSE = useCallback(() => {
    stopAll();
    if (!serverUrl) {
      setStatus('disconnected');
      return;
    }

    setStatus('reconnecting');

    const sseUrl = apiToken
      ? `${serverUrl}/api/events?token=${encodeURIComponent(apiToken)}`
      : `${serverUrl}/api/events`;
    const es = new EventSource<KarviSSEEvents>(sseUrl);

    es.addEventListener('connected', () => {
      setStatus('connected');
      // Full sync on connect
      const headers: Record<string, string> = {};
      if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;
      fetch(`${serverUrl}/api/board`, { headers })
        .then((r) => r.json())
        .then((b) => setBoard(b))
        .catch((err) => {
          console.warn('[useSSE] initial board fetch failed:', err?.message || err);
        });
    });

    es.addEventListener('board', (e) => {
      try {
        if (e.data) setBoard(JSON.parse(e.data));
      } catch {
        // malformed SSE data — ignore
      }
    });

    es.addEventListener('error', () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      startPolling();
    });

    esRef.current = es;
  }, [serverUrl, apiToken, setBoard, setStatus, stopAll, startPolling]);

  useEffect(() => {
    if (!serverUrl) return;
    connectSSE();

    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        connectSSE();
      } else {
        stopAll();
      }
    });

    return () => {
      stopAll();
      sub.remove();
    };
  }, [serverUrl, connectSSE, stopAll]);
}
