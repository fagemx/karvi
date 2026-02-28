import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../hooks/useTheme';

interface SectionHeaderProps {
  label: string;
  right?: React.ReactNode;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function SectionHeader({ label, right, compact, style }: SectionHeaderProps) {
  const t = useTheme();

  return (
    <View style={[styles.container, compact && styles.compact, style]}>
      <Text style={[styles.label, { color: t.textSecondary }]}>{label}</Text>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    marginTop: 8,
  },
  compact: {
    marginBottom: 8,
    marginTop: 4,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
});
