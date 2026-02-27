import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useTheme } from '../../hooks/useTheme';

export default function TabLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.headerBg },
        headerTintColor: t.text,
        tabBarStyle: { backgroundColor: t.tabBg, borderTopColor: t.border },
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.textSecondary,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Board',
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>{'📋'}</Text>,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>{'⚙️'}</Text>,
        }}
      />
    </Tabs>
  );
}
