import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { Task } from '../../shared/types';
import { StatusBadge } from './StatusBadge';

export function TaskCard({ task }: { task: Task }) {
  const router = useRouter();

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      onPress={() => router.push(`/task/${task.id}`)}
    >
      <View style={styles.header}>
        <Text style={styles.id}>{task.id}</Text>
        <StatusBadge status={task.status} />
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {task.title}
      </Text>
      <View style={styles.footer}>
        {task.assignee ? (
          <Text style={styles.meta}>{task.assignee}</Text>
        ) : null}
        {task.dispatch?.state === 'dispatching' ? (
          <Text style={styles.dispatching}>dispatching...</Text>
        ) : null}
        {task.review?.score != null ? (
          <Text style={styles.meta}>score: {task.review.score}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#252540',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#4fc3f7',
  },
  pressed: { opacity: 0.7 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  id: { color: '#4fc3f7', fontSize: 13, fontWeight: '700', fontFamily: 'monospace' },
  title: { color: '#e0e0e0', fontSize: 15, marginBottom: 6 },
  footer: { flexDirection: 'row', gap: 12 },
  meta: { color: '#888', fontSize: 12 },
  dispatching: { color: '#ffa726', fontSize: 12 },
});
