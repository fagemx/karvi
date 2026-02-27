import { View, Text, StyleSheet } from 'react-native';
import type { TaskStatus } from '../../shared/types';

const STATUS_CONFIG: Record<TaskStatus, { color: string; label: string }> = {
  pending: { color: '#666', label: 'Pending' },
  dispatched: { color: '#42a5f5', label: 'Dispatched' },
  in_progress: { color: '#ffa726', label: 'Running' },
  completed: { color: '#ff9800', label: 'Completed' },
  reviewing: { color: '#ab47bc', label: 'Reviewing' },
  approved: { color: '#66bb6a', label: 'Approved' },
  needs_revision: { color: '#ef5350', label: 'Needs Revision' },
  blocked: { color: '#ef5350', label: 'Blocked' },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const config = STATUS_CONFIG[status] ?? { color: '#666', label: status };
  return (
    <View style={[styles.badge, { backgroundColor: config.color }]}>
      <Text style={styles.text}>{config.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  text: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
});
