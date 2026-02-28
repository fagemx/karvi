import { Pressable, Text, ActivityIndicator, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme, type Theme } from '../../hooks/useTheme';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

function getVariantStyles(variant: ButtonVariant, t: Theme) {
  switch (variant) {
    case 'primary':
      return { bg: t.primary, text: t.textInverse, border: 'transparent' };
    case 'secondary':
      return { bg: 'transparent', text: t.primary, border: t.primary };
    case 'danger':
      return { bg: t.danger, text: t.textInverse, border: 'transparent' };
    case 'ghost':
      return { bg: 'transparent', text: t.primary, border: 'transparent' };
  }
}

function getSizeStyles(size: ButtonSize, t: Theme) {
  switch (size) {
    case 'sm':
      return { pv: 8, ph: 14, fs: t.fontSize.sm, radius: t.radius.md };
    case 'md':
      return { pv: 12, ph: 20, fs: t.fontSize.base, radius: t.radius.lg };
    case 'lg':
      return { pv: 16, ph: 24, fs: t.fontSize.lg, radius: t.radius.lg };
  }
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  loading,
  fullWidth,
  icon,
  style,
}: ButtonProps) {
  const t = useTheme();
  const v = getVariantStyles(variant, t);
  const s = getSizeStyles(size, t);
  const isDisabled = disabled || loading;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: v.bg,
          borderColor: v.border,
          borderWidth: variant === 'secondary' ? 1.5 : 0,
          borderRadius: s.radius,
          paddingVertical: s.pv,
          paddingHorizontal: s.ph,
        },
        fullWidth && styles.fullWidth,
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
        style as ViewStyle,
      ]}
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled }}
    >
      {loading ? (
        <ActivityIndicator size="small" color={v.text} />
      ) : (
        <>
          {icon}
          <Text style={[styles.label, { color: v.text, fontSize: s.fs }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  fullWidth: {
    width: '100%',
  },
  label: {
    fontWeight: '600',
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
