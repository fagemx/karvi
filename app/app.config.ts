import { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Karvi',
  slug: 'karvi',
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL || '',
  },
});
