import { useColorScheme } from 'react-native';

export interface Theme {
  bg: string;
  bgCard: string;
  text: string;
  textSecondary: string;
  accent: string;
  border: string;
  headerBg: string;
  tabBg: string;
  inputBg: string;
}

const dark: Theme = {
  bg: '#1a1a2e',
  bgCard: '#252540',
  text: '#e0e0e0',
  textSecondary: '#888',
  accent: '#4fc3f7',
  border: '#333',
  headerBg: '#1a1a2e',
  tabBg: '#1a1a2e',
  inputBg: '#252540',
};

const light: Theme = {
  bg: '#f5f5f5',
  bgCard: '#ffffff',
  text: '#1a1a2e',
  textSecondary: '#666',
  accent: '#0288d1',
  border: '#ddd',
  headerBg: '#ffffff',
  tabBg: '#ffffff',
  inputBg: '#f0f0f0',
};

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'light' ? light : dark;
}
