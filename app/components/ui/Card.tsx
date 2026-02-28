import { View, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../hooks/useTheme';

interface CardProps {
  children: React.ReactNode;
  accentColor?: string;
  noPadding?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function Card({ children, accentColor, noPadding, onPress, style, accessibilityLabel }: CardProps) {
  const t = useTheme();

  const cardStyle: ViewStyle[] = [
    styles.card,
    {
      backgroundColor: t.bgCard,
      borderColor: t.border,
      borderRadius: t.radius.xl,
      ...t.shadow.sm,
    },
    accentColor ? { borderLeftWidth: 3, borderLeftColor: accentColor } : undefined,
    noPadding ? { padding: 0 } : undefined,
    style as ViewStyle,
  ].filter(Boolean) as ViewStyle[];

  if (onPress) {
    return (
      <Pressable
        style={({ pressed }) => [...cardStyle, pressed && styles.pressed]}
        onPress={onPress}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View style={cardStyle} accessibilityLabel={accessibilityLabel}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  pressed: { opacity: 0.7 },
});
