import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../hooks/useTheme';

interface IconButtonProps {
  icon: React.ReactNode;
  onPress: () => void;
  size?: number;
  variant?: 'ghost' | 'filled' | 'outlined';
  color?: string;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({
  icon,
  onPress,
  size = 40,
  variant = 'ghost',
  color,
  accessibilityLabel,
  style,
}: IconButtonProps) {
  const t = useTheme();

  const bgColor =
    variant === 'filled' ? (color ?? t.primary) :
    variant === 'outlined' ? 'transparent' :
    'transparent';

  const borderColor = variant === 'outlined' ? (color ?? t.border) : 'transparent';

  return (
    <Pressable
      style={({ pressed }) => [
        styles.btn,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bgColor,
          borderColor,
          borderWidth: variant === 'outlined' ? 1.5 : 0,
        },
        pressed && styles.pressed,
        style as ViewStyle,
      ]}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
    >
      {icon}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
});
