import { useState } from 'react';
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useBoardStore } from '../../hooks/useBoardStore';
import { useTheme, type Theme } from '../../hooks/useTheme';
import { StatusBadge } from '../../components/StatusBadge';
import { updateTaskStatus, dispatchTask, unblockTask } from '../../lib/api';
import type { Task, TaskStatus } from '../../../shared/types';

function ActionButtons({ task, theme: t }: { task: Task; theme: Theme }) {
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
                style={[styles.feedbackInput, { backgroundColor: t.inputBg, borderColor: t.border, color: t.text }]}
                value={feedback}
                onChangeText={setFeedback}
                placeholder="Unblock message..."
                placeholderTextColor={t.textSecondary}
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

function Section({ title, theme: t, children }: { title: string; theme: Theme; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: t.accent }]}>{title}</Text>
      {children}
    </View>
  );
}

function InfoRow({ label, value, theme: t }: { label: string; value: string | undefined | null; theme: Theme }) {
  if (!value) return null;
  return (
    <View style={styles.infoRow}>
      <Text style={[styles.infoLabel, { color: t.textSecondary }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: t.text }]}>{value}</Text>
    </View>
  );
}

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const board = useBoardStore((s) => s.board);
  const task = board?.taskPlan?.tasks?.find((item) => item.id === id);
  const t = useTheme();

  if (!task) {
    return (
      <View style={[styles.container, { backgroundColor: t.bg }]}>
        <Stack.Screen options={{ title: id ?? 'Task' }} />
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: t.textSecondary }]}>Task {id} not found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: t.bg }]}>
      <Stack.Screen options={{ title: `${task.id} — ${task.title}` }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.titleRow}>
          <StatusBadge status={task.status} />
          <Text style={[styles.taskTitle, { color: t.text }]}>{task.title}</Text>
        </View>

        <Section title="Details" theme={t}>
          <InfoRow label="Assignee" value={task.assignee} theme={t} />
          <InfoRow label="Dependencies" value={task.depends?.join(', ')} theme={t} />
          <InfoRow label="Skill" value={task.skill} theme={t} />
          <InfoRow label="Started" value={task.startedAt?.toString()} theme={t} />
          <InfoRow label="Completed" value={task.completedAt} theme={t} />
        </Section>

        {task.dispatch && (
          <Section title="Dispatch" theme={t}>
            <InfoRow label="State" value={task.dispatch.state} theme={t} />
            <InfoRow label="Runtime" value={task.dispatch.runtime} theme={t} />
            <InfoRow label="Agent" value={task.dispatch.agentId} theme={t} />
            <InfoRow label="Model" value={task.dispatch.model ?? task.lastDispatchModel} theme={t} />
            <InfoRow label="Plan ID" value={task.dispatch.planId} theme={t} />
          </Section>
        )}

        {task.review && (
          <Section title="Review" theme={t}>
            <InfoRow label="Score" value={String(task.review.score)} theme={t} />
            <InfoRow label="Verdict" value={task.review.verdict} theme={t} />
            <InfoRow label="Summary" value={task.review.summary} theme={t} />
            {task.review.issues?.map((issue, i) => (
              <Text key={i} style={styles.issue}>• {issue}</Text>
            ))}
          </Section>
        )}

        {task.lastReply && (
          <Section title="Last Reply" theme={t}>
            <Text style={[styles.reply, { color: t.textSecondary }]} numberOfLines={20}>{task.lastReply}</Text>
          </Section>
        )}

        {task.blocker && (
          <Section title="Blocker" theme={t}>
            <Text style={styles.blockerText}>{task.blocker.reason}</Text>
          </Section>
        )}

        {task.history && task.history.length > 0 && (
          <Section title="History" theme={t}>
            {task.history.slice(-10).reverse().map((h, i) => (
              <View key={i} style={[styles.historyItem, { borderBottomColor: t.bgCard }]}>
                <Text style={[styles.historyStatus, { color: t.text }]}>{h.status}</Text>
                <Text style={[styles.historyMeta, { color: t.textSecondary }]}>
                  {h.by} — {new Date(h.ts).toLocaleTimeString()}
                </Text>
                {h.reason ? <Text style={[styles.historyReason, { color: t.textSecondary }]}>{h.reason}</Text> : null}
              </View>
            ))}
          </Section>
        )}

        <ActionButtons task={task} theme={t} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, paddingBottom: 40 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 16 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  taskTitle: { fontSize: 18, fontWeight: '600', flex: 1 },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 13, fontWeight: '700', marginBottom: 8, textTransform: 'uppercase' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  infoLabel: { fontSize: 13 },
  infoValue: { fontSize: 13, flex: 1, textAlign: 'right' },
  issue: { color: '#ef5350', fontSize: 13, marginTop: 2 },
  reply: { fontSize: 13, fontFamily: 'monospace', lineHeight: 18 },
  blockerText: { color: '#ef5350', fontSize: 14 },
  historyItem: { paddingVertical: 6, borderBottomWidth: 1 },
  historyStatus: { fontSize: 13, fontWeight: '600' },
  historyMeta: { fontSize: 11, marginTop: 2 },
  historyReason: { fontSize: 12, marginTop: 2 },
  actions: { marginTop: 16, gap: 10 },
  actionBtn: { borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  actionBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  feedbackBox: { gap: 10 },
  feedbackInput: {
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: 'top',
    borderWidth: 1,
  },
});
