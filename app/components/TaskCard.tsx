import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { Task } from '../../shared/types';
import { StatusBadge } from './StatusBadge';
import { useTheme } from '../hooks/useTheme';

export function TaskCard({ task }: { task: Task }) {
  const router = useRouter();
  const t = useTheme();

  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: t.bgCard, borderLeftColor: t.accent },
        pressed && styles.pressed,
      ]}
      onPress={() => router.push(`/task/${task.id}`)}
    >
      <View style={styles.header}>
        <Text style={[styles.id, { color: t.accent }]}>{task.id}</Text>
        <StatusBadge status={task.status} />
      </View>
      <Text style={[styles.title, { color: t.text }]} numberOfLines={2}>
        {task.title}
      </Text>
      <View style={styles.footer}>
        {task.assignee ? (
          <Text style={[styles.meta, { color: t.textSecondary }]}>{task.assignee}</Text>
        ) : null}
        {task.dispatch?.state === 'dispatching' ? (
          <Text style={styles.dispatching}>dispatching...</Text>
        ) : null}
        {task.review?.score != null ? (
          <Text style={[styles.meta, { color: t.textSecondary }]}>score: {task.review.score}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderLeftWidth: 3,
  },
  pressed: { opacity: 0.7 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  id: { fontSize: 13, fontWeight: '700', fontFamily: 'monospace' },
  title: { fontSize: 15, marginBottom: 6 },
  footer: { flexDirection: 'row', gap: 12 },
  meta: { fontSize: 12 },
  dispatching: { color: '#ffa726', fontSize: 12 },
});
