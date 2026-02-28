import Constants from 'expo-constants';

/**
 * 從 app.config.ts extra 讀取環境預設 API URL。
 * 由 EXPO_PUBLIC_API_URL 環境變數注入，build-time 解析。
 */
export function getDefaultApiUrl(): string {
  return Constants.expoConfig?.extra?.apiUrl || '';
}
