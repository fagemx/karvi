import { useState } from 'react';
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useBoardStore } from '../../hooks/useBoardStore';
import { StatusBadge } from '../../components/StatusBadge';
import { updateTaskStatus, dispatchTask, unblockTask } from '../../lib/api';
import type { Task, TaskStatus } from '../../../shared/types';

function ActionButtons({ task }: { task: Task }) {
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);

  const act = async (action: () => Promise<any>, label: string) => {
    try {
      await action();
    } catch (err: any) {
      Alert.alert(`${label} failed`, err.message);
    }
  };

  const s = task.status;

  return (
    <View style={styles.actions}>
      {(s === 'dispatched' || s === 'pending') && (
        <ActionBtn label="Dispatch" color="#42a5f5" onPress={() => act(() => dispatchTask(task.id), 'Dispatch')} />
      )}

      {(s === 'completed' || s === 'reviewing') && (
        <ActionBtn label="Approve" color="#66bb6a" onPress={() => act(() => updateTaskStatus(task.id, 'approved'), 'Approve')} />
      )}

      {s === 'needs_revision' && (
        <>
          <ActionBtn label="Approve Override" color="#66bb6a" onPress={() => act(() => updateTaskStatus(task.id, 'approved'), 'Approve')} />
          <ActionBtn label="Redispatch" color="#42a5f5" onPress={() => act(() => dispatchTask(task.id), 'Redispatch')} />
        </>
      )}

      {s === 'blocked' && (
        <>
          {!showFeedback ? (
            <ActionBtn label="Unblock" color="#ffa726" onPress={() => setShowFeedback(true)} />
          ) : (
            <View style={styles.feedbackBox}>
              <TextInput
                style={styles.feedbackInput}
                value={feedback}
                onChangeText={setFeedback}
                placeholder="Unblock message..."
                placeholderTextColor="#666"
                multiline
              />
              <ActionBtn
                label="Send & Unblock"
                color="#ffa726"
                onPress={() => {
                  act(() => unblockTask(task.id, feedback), 'Unblock');
                  setShowFeedback(false);
                  setFeedback('');
                }}
              />
            </View>
          )}
        </>
      )}
    </View>
  );
}

function ActionBtn({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.actionBtn, { backgroundColor: color }, pressed && { opacity: 0.7 }]}
      onPress={onPress}
    >
      <Text style={styles.actionBtnText}>{label}</Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string | undefined | null }) {
  if (!value) return null;
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const board = useBoardStore((s) => s.board);
  const task = board?.taskPlan?.tasks?.find((t) => t.id === id);

  if (!task) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: id ?? 'Task' }} />
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Task {id} not found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: `${task.id} — ${task.title}` }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Status + Title */}
        <View style={styles.titleRow}>
          <StatusBadge status={task.status} />
          <Text style={styles.taskTitle}>{task.title}</Text>
        </View>

        {/* Info */}
        <Section title="Details">
          <InfoRow label="Assignee" value={task.assignee} />
          <InfoRow label="Dependencies" value={task.depends?.join(', ')} />
          <InfoRow label="Skill" value={task.skill} />
          <InfoRow label="Started" value={task.startedAt?.toString()} />
          <InfoRow label="Completed" value={task.completedAt} />
        </Section>

        {/* Dispatch */}
        {task.dispatch && (
          <Section title="Dispatch">
            <InfoRow label="State" value={task.dispatch.state} />
            <InfoRow label="Runtime" value={task.dispatch.runtime} />
            <InfoRow label="Agent" value={task.dispatch.agentId} />
            <InfoRow label="Model" value={task.dispatch.model ?? task.lastDispatchModel} />
            <InfoRow label="Plan ID" value={task.dispatch.planId} />
          </Section>
        )}

        {/* Review */}
        {task.review && (
          <Section title="Review">
            <InfoRow label="Score" value={String(task.review.score)} />
            <InfoRow label="Verdict" value={task.review.verdict} />
            <InfoRow label="Summary" value={task.review.summary} />
            {task.review.issues?.map((issue, i) => (
              <Text key={i} style={styles.issue}>• {issue}</Text>
            ))}
          </Section>
        )}

        {/* Last Reply */}
        {task.lastReply && (
          <Section title="Last Reply">
            <Text style={styles.reply} numberOfLines={20}>{task.lastReply}</Text>
          </Section>
        )}

        {/* Blocker */}
        {task.blocker && (
          <Section title="Blocker">
            <Text style={styles.blockerText}>{task.blocker.reason}</Text>
          </Section>
        )}

        {/* History */}
        {task.history && task.history.length > 0 && (
          <Section title="History">
            {task.history.slice(-10).reverse().map((h, i) => (
              <View key={i} style={styles.historyItem}>
                <Text style={styles.historyStatus}>{h.status}</Text>
                <Text style={styles.historyMeta}>
                  {h.by} — {new Date(h.ts).toLocaleTimeString()}
                </Text>
                {h.reason ? <Text style={styles.historyReason}>{h.reason}</Text> : null}
              </View>
            ))}
          </Section>
        )}

        {/* Actions */}
        <ActionButtons task={task} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  scroll: { padding: 16, paddingBottom: 40 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: '#888', fontSize: 16 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  taskTitle: { color: '#e0e0e0', fontSize: 18, fontWeight: '600', flex: 1 },
  section: { marginBottom: 20 },
  sectionTitle: { color: '#4fc3f7', fontSize: 13, fontWeight: '700', marginBottom: 8, textTransform: 'uppercase' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  infoLabel: { color: '#888', fontSize: 13 },
  infoValue: { color: '#e0e0e0', fontSize: 13, flex: 1, textAlign: 'right' },
  issue: { color: '#ef5350', fontSize: 13, marginTop: 2 },
  reply: { color: '#ccc', fontSize: 13, fontFamily: 'monospace', lineHeight: 18 },
  blockerText: { color: '#ef5350', fontSize: 14 },
  historyItem: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#252540' },
  historyStatus: { color: '#e0e0e0', fontSize: 13, fontWeight: '600' },
  historyMeta: { color: '#888', fontSize: 11, marginTop: 2 },
  historyReason: { color: '#aaa', fontSize: 12, marginTop: 2 },
  actions: { marginTop: 16, gap: 10 },
  actionBtn: { borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  actionBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  feedbackBox: { gap: 10 },
  feedbackInput: {
    backgroundColor: '#252540',
    borderRadius: 8,
    padding: 12,
    color: '#e0e0e0',
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: '#333',
  },
});
