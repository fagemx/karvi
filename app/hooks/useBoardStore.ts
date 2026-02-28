import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Board } from '../../shared/types';
import { getDefaultApiUrl } from '../lib/config';

const DEFAULT_API_URL = getDefaultApiUrl();

export type ConnectionStatus = 'connected' | 'polling' | 'reconnecting' | 'disconnected';

interface BoardStore {
  board: Board | null;
  serverUrl: string;
  apiToken: string;
  defaultApiUrl: string;
  connectionStatus: ConnectionStatus;
  setBoard: (board: Board) => void;
  setServerUrl: (url: string) => void;
  setApiToken: (token: string) => void;
  setConnectionStatus: (s: ConnectionStatus) => void;
  resetServerUrl: () => void;
}

export const useBoardStore = create<BoardStore>()(
  persist(
    (set) => ({
      board: null,
      serverUrl: DEFAULT_API_URL,
      apiToken: '',
      defaultApiUrl: DEFAULT_API_URL,
      connectionStatus: 'disconnected',
      setBoard: (board) => set({ board }),
      setServerUrl: (serverUrl) => set({ serverUrl }),
      setApiToken: (apiToken) => set({ apiToken }),
      setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
      resetServerUrl: () => set({ serverUrl: DEFAULT_API_URL }),
    }),
    {
      name: 'karvi-board',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ board: state.board, serverUrl: state.serverUrl, apiToken: state.apiToken }),
      merge: (persisted, current) => {
        const p = persisted as Partial<BoardStore> | undefined;
        return {
          ...current,
          ...p,
          // 若已持久化的 serverUrl 為空且有環境預設值，使用預設值
          serverUrl: (p?.serverUrl || '') === '' ? DEFAULT_API_URL : p!.serverUrl,
        };
      },
    }
  )
);
