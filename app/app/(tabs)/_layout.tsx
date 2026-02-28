import { Tabs } from 'expo-router';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../hooks/useTheme';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function TabIcon({ name, focused, color, size }: {
  name: string;
  focused: boolean;
  color: string;
  size: number;
}) {
  const iconName = (focused ? name : `${name}-outline`) as IoniconName;
  return <Ionicons name={iconName} size={size} color={color} />;
}

export default function TabLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.headerBg },
        headerTintColor: t.text,
        headerShadowVisible: false,
        headerTitleStyle: { fontWeight: '700', fontSize: t.fontSize.lg },
        tabBarStyle: {
          backgroundColor: t.tabBg,
          borderTopColor: t.tabBorder,
          borderTopWidth: 1,
          paddingBottom: Platform.OS === 'ios' ? 8 : 4,
          height: Platform.OS === 'ios' ? 84 : 64,
        },
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.textSecondary,
        tabBarLabelStyle: {
          fontSize: t.fontSize.xs,
          fontWeight: '500',
          marginTop: 2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Tasks',
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="layers" focused={focused} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="reviews"
        options={{
          title: 'Reviews',
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="git-pull-request" focused={focused} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="usage"
        options={{
          title: 'Usage',
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="bar-chart" focused={focused} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="settings" focused={focused} color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
