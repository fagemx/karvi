import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { StatusColors, StatusLabels, Palette } from '../../theme/tokens';

type BadgeVariant = 'filled' | 'outline' | 'dot';
type BadgeSize = 'sm' | 'md';

interface BadgeProps {
  label?: string;
  status?: string;
  bg?: string;
  color?: string;
  variant?: BadgeVariant;
  size?: BadgeSize;
  style?: StyleProp<ViewStyle>;
}

export function Badge({ label, status, bg, color, variant = 'filled', size = 'md', style }: BadgeProps) {
  const t = useTheme();

  // 從 status 自動取色，或用自訂色
  const statusColor = status ? StatusColors[status] : undefined;
  const resolvedBg = bg ?? statusColor?.bg ?? Palette.gray100;
  const resolvedColor = color ?? statusColor?.text ?? Palette.gray500;
  const resolvedLabel = label ?? (status ? StatusLabels[status] ?? status : '');

  const isSmall = size === 'sm';

  if (variant === 'dot') {
    return (
      <View style={[styles.dotContainer, style]}>
        <View style={[styles.dot, { backgroundColor: statusColor?.dot ?? resolvedColor }]} />
        <Text style={[styles.dotLabel, { color: resolvedColor, fontSize: isSmall ? 10 : 12 }]}>
          {resolvedLabel}
        </Text>
      </View>
    );
  }

  if (variant === 'outline') {
    return (
      <View
        style={[
          styles.badge,
          {
            backgroundColor: 'transparent',
            borderWidth: 1,
            borderColor: resolvedColor,
            paddingHorizontal: isSmall ? 6 : 10,
            paddingVertical: isSmall ? 2 : 4,
          },
          style,
        ]}
      >
        <Text style={[styles.text, { color: resolvedColor, fontSize: isSmall ? 10 : 12 }]}>
          {resolvedLabel}
        </Text>
      </View>
    );
  }

  // filled (default)
  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: resolvedBg,
          paddingHorizontal: isSmall ? 6 : 10,
          paddingVertical: isSmall ? 2 : 4,
        },
        style,
      ]}
    >
      <Text style={[styles.text, { color: resolvedColor, fontSize: isSmall ? 10 : 12 }]}>
        {resolvedLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: 9999,
    alignSelf: 'flex-start',
  },
  text: {
    fontWeight: '600',
  },
  dotContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotLabel: {
    fontWeight: '500',
  },
});
