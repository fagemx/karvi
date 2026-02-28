import { useState, useMemo } from 'react';
import { View, Text, TextInput, FlatList, Pressable, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useBoardStore } from '../../hooks/useBoardStore';
import { useTheme } from '../../hooks/useTheme';
import { SwipeableTaskCard } from '../../components/SwipeableTaskCard';
import { ConnectionIndicator } from '../../components/ConnectionIndicator';
import { FilterChipGroup, type FilterChipItem } from '../../components/ui/FilterChip';
import { dispatchNext } from '../../lib/api';
import type { Task } from '../../../shared/types';

const STATUS_FILTERS: FilterChipItem[] = [
  { id: 'in_progress', label: 'In Progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'reviewing', label: 'Reviewing' },
  { id: 'completed', label: 'Done' },
  { id: 'pending', label: 'Pending' },
];

export default function BoardScreen() {
  const board = useBoardStore((s) => s.board);
  const serverUrl = useBoardStore((s) => s.serverUrl);
  const tasks: Task[] = board?.taskPlan?.tasks ?? [];
  const t = useTheme();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = tasks;
    if (statusFilter) {
      result = result.filter((task) => task.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (task) =>
          task.title.toLowerCase().includes(q) ||
          task.id.toLowerCase().includes(q) ||
          task.assignee?.toLowerCase().includes(q),
      );
    }
    return result;
  }, [tasks, statusFilter, search]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    tasks.forEach((task) => {
      counts[task.status] = (counts[task.status] || 0) + 1;
    });
    return counts;
  }, [tasks]);

  const handleDispatchNext = async () => {
    try {
      const result = await dispatchNext();
      if (result.dispatched) {
        Alert.alert('Dispatched', `Task ${result.taskId} dispatched`);
      } else {
        Alert.alert('No tasks', result.reason || 'Nothing to dispatch');
      }
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  };

  if (!serverUrl) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: t.bg }]}>
        <View style={styles.empty}>
          <Ionicons name="server-outline" size={48} color={t.textTertiary} />
          <Text style={[styles.emptyTitle, { color: t.text }]}>No Server Configured</Text>
          <Text style={[styles.emptyText, { color: t.textSecondary }]}>
            Go to Settings to connect your Karvi server
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: t.bg }]} edges={['top']}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: t.border }]}>
        <View style={styles.headerLeft}>
          <Text style={[styles.title, { color: t.text }]}>Task Board</Text>
          <ConnectionIndicator />
        </View>
        <Pressable
          style={({ pressed }) => [styles.bellBtn, pressed && { opacity: 0.6 }]}
          onPress={() => {}}
        >
          <Ionicons name="notifications-outline" size={22} color={t.text} />
        </Pressable>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <View style={[styles.searchBox, { backgroundColor: t.bgCard, borderColor: t.border }]}>
          <Ionicons name="search-outline" size={18} color={t.textTertiary} />
          <TextInput
            style={[styles.searchInput, { color: t.text }]}
            placeholder="Search tasks..."
            placeholderTextColor={t.placeholder}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch('')}>
              <Ionicons name="close-circle" size={18} color={t.textTertiary} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Filter chips */}
      <FilterChipGroup
        chips={STATUS_FILTERS.map((f) => ({
          ...f,
          label: statusCounts[f.id] ? `${f.label} ${statusCounts[f.id]}` : f.label,
        }))}
        selected={statusFilter}
        onSelect={setStatusFilter}
      />

      {/* Goal banner */}
      {board?.taskPlan?.goal ? (
        <View style={[styles.goalBanner, { backgroundColor: t.primaryLight }]}>
          <Ionicons name="flag-outline" size={14} color={t.primary} />
          <Text style={[styles.goalText, { color: t.primary }]} numberOfLines={1}>
            {board.taskPlan.goal}
          </Text>
        </View>
      ) : null}

      {/* Task list */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <SwipeableTaskCard task={item} />}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.emptyList}>
            <Ionicons name="checkmark-done-outline" size={40} color={t.textTertiary} />
            <Text style={[styles.emptyText, { color: t.textSecondary }]}>
              {statusFilter ? 'No tasks match this filter' : 'No tasks yet'}
            </Text>
          </View>
        }
      />

      {/* FAB */}
      <Pressable
        style={({ pressed }) => [
          styles.fab,
          { backgroundColor: t.primary, ...t.shadow.lg },
          pressed && { opacity: 0.85 },
        ]}
        onPress={handleDispatchNext}
      >
        <Ionicons name="rocket" size={22} color="#fff" />
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { fontSize: 22, fontWeight: '800' },
  bellBtn: { padding: 4 },
  // Search
  searchRow: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  // Goal
  goalBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  goalText: { fontSize: 13, fontWeight: '600', flex: 1 },
  // List
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 100 },
  emptyList: { alignItems: 'center', paddingTop: 60, gap: 12 },
  // Empty state
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptyText: { fontSize: 14, textAlign: 'center' },
  // FAB
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
