import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSSE } from '../hooks/useSSE';
import { useNotifications } from '../hooks/useNotifications';

export default function RootLayout() {
  useSSE();
  useNotifications();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="task/[id]"
          options={{ headerShown: true, title: 'Task Detail', presentation: 'card' }}
        />
      </Stack>
    </GestureHandlerRootView>
  );
}
