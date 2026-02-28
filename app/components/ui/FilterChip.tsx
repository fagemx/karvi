import { ScrollView, Pressable, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../hooks/useTheme';

export interface FilterChipItem {
  id: string;
  label: string;
}

interface FilterChipGroupProps {
  chips: FilterChipItem[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  style?: StyleProp<ViewStyle>;
}

export function FilterChipGroup({ chips, selected, onSelect, style }: FilterChipGroupProps) {
  const t = useTheme();

  const allChips: FilterChipItem[] = [{ id: '__all__', label: 'All' }, ...chips];

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.container, style]}
    >
      {allChips.map((chip) => {
        const isSelected = chip.id === '__all__' ? selected === null : selected === chip.id;

        return (
          <Pressable
            key={chip.id}
            style={[
              styles.chip,
              {
                backgroundColor: isSelected ? t.primary : t.bgSubtle,
                borderColor: isSelected ? t.primary : t.border,
              },
            ]}
            onPress={() => onSelect(chip.id === '__all__' ? null : chip.id)}
          >
            <Text
              style={[
                styles.chipText,
                { color: isSelected ? t.textInverse : t.textSecondary },
              ]}
            >
              {chip.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 9999,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
