import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { Task } from '../../shared/types';
import { StatusBadge } from './StatusBadge';
import { Card } from './ui/Card';
import { useTheme } from '../hooks/useTheme';
import { StatusColors, Palette } from '../theme/tokens';

function statusAccent(status: string): string {
  return StatusColors[status]?.dot ?? Palette.gray400;
}

export function TaskCard({ task }: { task: Task }) {
  const router = useRouter();
  const t = useTheme();

  return (
    <Card
      accentColor={statusAccent(task.status)}
      onPress={() => router.push(`/task/${task.id}`)}
      style={styles.card}
    >
      <View style={styles.header}>
        <Text style={[styles.id, { color: t.primary }]}>{task.id}</Text>
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
          <Text style={[styles.dispatching, { color: t.warning }]}>dispatching...</Text>
        ) : null}
        {task.review?.score != null ? (
          <Text style={[styles.meta, { color: t.textSecondary }]}>score: {task.review.score}</Text>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 8,
  },
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
  dispatching: { fontSize: 12 },
});
