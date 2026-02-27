import { Stack } from 'expo-router';
import { useSSE } from '../hooks/useSSE';

export default function RootLayout() {
  useSSE();
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="task/[id]"
        options={{ headerShown: true, title: 'Task Detail', presentation: 'card' }}
      />
    </Stack>
  );
}
