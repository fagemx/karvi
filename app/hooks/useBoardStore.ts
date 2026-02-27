import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Board } from '../../shared/types';

export type ConnectionStatus = 'connected' | 'polling' | 'reconnecting' | 'disconnected';

interface BoardStore {
  board: Board | null;
  serverUrl: string;
  connectionStatus: ConnectionStatus;
  setBoard: (board: Board) => void;
  setServerUrl: (url: string) => void;
  setConnectionStatus: (s: ConnectionStatus) => void;
}

export const useBoardStore = create<BoardStore>()(
  persist(
    (set) => ({
      board: null,
      serverUrl: '',
      connectionStatus: 'disconnected',
      setBoard: (board) => set({ board }),
      setServerUrl: (serverUrl) => set({ serverUrl }),
      setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
    }),
    {
      name: 'karvi-board',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ board: state.board, serverUrl: state.serverUrl }),
    }
  )
);
