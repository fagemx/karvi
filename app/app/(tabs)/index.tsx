import { View, Text, FlatList, Pressable, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBoardStore } from '../../hooks/useBoardStore';
import { useTheme } from '../../hooks/useTheme';
import { SwipeableTaskCard } from '../../components/SwipeableTaskCard';
import { ConnectionIndicator } from '../../components/ConnectionIndicator';
import { dispatchNext } from '../../lib/api';
import type { Task } from '../../../shared/types';

export default function BoardScreen() {
  const board = useBoardStore((s) => s.board);
  const serverUrl = useBoardStore((s) => s.serverUrl);
  const tasks: Task[] = board?.taskPlan?.tasks ?? [];
  const t = useTheme();

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
          <Text style={[styles.emptyTitle, { color: t.text }]}>No Server Configured</Text>
          <Text style={[styles.emptyText, { color: t.textSecondary }]}>
            Go to Settings tab to enter your Karvi server URL
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: t.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: t.text }]}>Karvi</Text>
        <ConnectionIndicator />
      </View>

      {board?.taskPlan?.goal ? (
        <Text style={[styles.goal, { color: t.textSecondary }]}>{board.taskPlan.goal}</Text>
      ) : null}

      <FlatList
        data={tasks}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <SwipeableTaskCard task={item} />}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: t.textSecondary }]}>No tasks yet</Text>
        }
      />

      <Pressable
        style={({ pressed }) => [styles.dispatchBtn, { backgroundColor: t.accent }, pressed && styles.btnPressed]}
        onPress={handleDispatchNext}
      >
        <Text style={styles.dispatchText}>Dispatch Next</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 22, fontWeight: '700' },
  goal: { fontSize: 13, paddingHorizontal: 16, marginBottom: 8 },
  list: { paddingHorizontal: 16, paddingBottom: 80 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  emptyText: { fontSize: 14, textAlign: 'center' },
  dispatchBtn: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnPressed: { opacity: 0.7 },
  dispatchText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
