import { useState } from 'react';
import { View, Text, ScrollView, TextInput, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useBoardStore } from '../../hooks/useBoardStore';
import { useTheme, type Theme } from '../../hooks/useTheme';
import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { BottomSheet } from '../../components/ui/BottomSheet';
import { updateTaskStatus, dispatchTask, unblockTask } from '../../lib/api';
import { StatusColors, Palette } from '../../theme/tokens';
import type { Task } from '../../../shared/types';

// ---------------------------------------------------------------------------
// PR URL detection
// ---------------------------------------------------------------------------

const PR_URL_RE = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

function extractPrUrl(task: Task): { owner: string; repo: string; number: string; url: string } | null {
  // Check structured field first
  if (task.result?.prUrl) {
    const match = task.result.prUrl.match(PR_URL_RE);
    if (match) return { owner: match[1], repo: match[2], number: match[3], url: task.result.prUrl };
  }
  // Fallback: scan lastReply
  if (task.lastReply) {
    const match = task.lastReply.match(PR_URL_RE);
    if (match) return { owner: match[1], repo: match[2], number: match[3], url: match[0] };
  }
  // Fallback: scan result.summary
  if (task.result?.summary) {
    const match = task.result.summary.match(PR_URL_RE);
    if (match) return { owner: match[1], repo: match[2], number: match[3], url: match[0] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timeline item
// ---------------------------------------------------------------------------

function TimelineItem({
  status,
  label,
  meta,
  reason,
  isLast,
  t,
}: {
  status: string;
  label: string;
  meta: string;
  reason?: string;
  isLast: boolean;
  t: Theme;
}) {
  const dotColor = StatusColors[status]?.dot ?? Palette.gray400;
  return (
    <View style={styles.timelineRow}>
      {/* Dot + line */}
      <View style={styles.timelineLeft}>
        <View style={[styles.timelineDot, { backgroundColor: dotColor }]} />
        {!isLast && <View style={[styles.timelineLine, { backgroundColor: t.border }]} />}
      </View>
      {/* Content */}
      <View style={styles.timelineContent}>
        <Text style={[styles.timelineLabel, { color: t.text }]}>{label}</Text>
        <Text style={[styles.timelineMeta, { color: t.textSecondary }]}>{meta}</Text>
        {reason ? (
          <View style={[styles.timelineReason, { backgroundColor: t.bgSubtle }]}>
            <Ionicons name="chatbubble-ellipses-outline" size={12} color={t.textSecondary} />
            <Text style={[styles.timelineReasonText, { color: t.textSecondary }]}>{reason}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Metric card (for review results)
// ---------------------------------------------------------------------------

function MetricCard({ label, value, color, t }: { label: string; value: string; color: string; t: Theme }) {
  return (
    <View style={[styles.metricCard, { backgroundColor: t.bgCard, borderColor: t.border }]}>
      <Text style={[styles.metricValue, { color }]}>{value}</Text>
      <Text style={[styles.metricLabel, { color: t.textSecondary }]}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Info row inside card
// ---------------------------------------------------------------------------

function InfoRow({ icon, label, value, t }: { icon: string; label: string; value: string; t: Theme }) {
  return (
    <View style={styles.infoRow}>
      <Ionicons name={icon as any} size={16} color={t.textSecondary} />
      <Text style={[styles.infoLabel, { color: t.textSecondary }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: t.text }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const board = useBoardStore((s) => s.board);
  const task = board?.taskPlan?.tasks?.find((item) => item.id === id);
  const t = useTheme();

  const router = useRouter();
  const [showUnblock, setShowUnblock] = useState(false);
  const [unblockMsg, setUnblockMsg] = useState('');
  const prInfo = task ? extractPrUrl(task) : null;

  if (!task) {
    return (
      <View style={[styles.container, { backgroundColor: t.bg }]}>
        <Stack.Screen options={{ title: id ?? 'Task' }} />
        <View style={styles.empty}>
          <Ionicons name="document-outline" size={48} color={t.textTertiary} />
          <Text style={[styles.emptyText, { color: t.textSecondary }]}>Task {id} not found</Text>
        </View>
      </View>
    );
  }

  const act = async (action: () => Promise<any>, label: string) => {
    try {
      await action();
    } catch (err: any) {
      Alert.alert(`${label} failed`, err.message);
    }
  };

  const handleUnblock = () => {
    act(() => unblockTask(task.id, unblockMsg), 'Unblock');
    setShowUnblock(false);
    setUnblockMsg('');
  };

  const s = task.status;

  return (
    <View style={[styles.container, { backgroundColor: t.bg }]}>
      <Stack.Screen
        options={{
          title: task.id,
          headerStyle: { backgroundColor: t.headerBg },
          headerTintColor: t.text,
          headerShadowVisible: false,
        }}
      />

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Title + badges */}
        <Text style={[styles.taskTitle, { color: t.text }]}>{task.title}</Text>
        <View style={styles.badgeRow}>
          <Badge status={task.status} />
          {task.track && <Badge label={task.track} bg={t.bgSubtle} color={t.textSecondary} />}
          {task.skill && <Badge label={task.skill} variant="outline" color={t.primary} />}
        </View>

        {/* Description */}
        {task.description ? (
          <Text style={[styles.description, { color: t.textSecondary }]}>{task.description}</Text>
        ) : null}

        {/* Details card */}
        <Card style={styles.detailCard}>
          {task.dispatch?.runtime && (
            <InfoRow icon="server-outline" label="Runtime" value={task.dispatch.runtime} t={t} />
          )}
          {task.assignee && (
            <InfoRow icon="person-outline" label="Assignee" value={task.assignee} t={t} />
          )}
          {task.depends && task.depends.length > 0 && (
            <InfoRow icon="git-branch-outline" label="Depends" value={task.depends.join(', ')} t={t} />
          )}
          {(task.dispatch?.model ?? task.lastDispatchModel) && (
            <InfoRow icon="hardware-chip-outline" label="Model" value={task.dispatch?.model ?? task.lastDispatchModel ?? ''} t={t} />
          )}
          {task.startedAt && (
            <InfoRow icon="time-outline" label="Started" value={new Date(task.startedAt).toLocaleString()} t={t} />
          )}
        </Card>

        {/* PR Review card */}
        {prInfo && (
          <Card
            onPress={() => router.push(`/pr/${prInfo.owner}/${prInfo.repo}/${prInfo.number}`)}
            style={styles.prCard}
          >
            <View style={styles.prCardRow}>
              <Ionicons name="git-pull-request" size={20} color={t.primary} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.prCardTitle, { color: t.text }]}>
                  Review PR #{prInfo.number}
                </Text>
                <Text style={[styles.prCardSub, { color: t.textSecondary }]}>
                  {prInfo.owner}/{prInfo.repo}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={t.textTertiary} />
            </View>
          </Card>
        )}

        {/* Review results */}
        {task.review && (
          <>
            <SectionHeader label="Review Results" />
            <View style={styles.metricsRow}>
              <MetricCard
                label="Score"
                value={String(task.review.score ?? '-')}
                color={t.primary}
                t={t}
              />
              <MetricCard
                label="Verdict"
                value={task.review.verdict ?? '-'}
                color={task.review.verdict === 'approved' ? t.success : t.danger}
                t={t}
              />
            </View>
            {task.review.summary && (
              <Card style={styles.summaryCard}>
                <Text style={[styles.summaryText, { color: t.text }]}>{task.review.summary}</Text>
              </Card>
            )}
            {task.review.issues && task.review.issues.length > 0 && (
              <Card style={styles.issueCard}>
                <SectionHeader label="Issues" compact />
                {task.review.issues.map((issue, i) => (
                  <View key={i} style={styles.issueRow}>
                    <Ionicons name="alert-circle" size={14} color={t.danger} />
                    <Text style={[styles.issueText, { color: t.text }]}>{issue}</Text>
                  </View>
                ))}
              </Card>
            )}
          </>
        )}

        {/* Blocker */}
        {task.blocker && (
          <Card style={[styles.blockerCard, { borderLeftColor: t.danger }]}>
            <View style={styles.blockerHeader}>
              <Ionicons name="warning" size={16} color={t.danger} />
              <Text style={[styles.blockerTitle, { color: t.danger }]}>Blocked</Text>
            </View>
            <Text style={[styles.blockerReason, { color: t.text }]}>{task.blocker.reason}</Text>
          </Card>
        )}

        {/* Last reply */}
        {task.lastReply && (
          <>
            <SectionHeader label="Last Reply" />
            <Card style={styles.replyCard}>
              <Text style={[styles.replyText, { color: t.textSecondary }]} numberOfLines={20}>
                {task.lastReply}
              </Text>
            </Card>
          </>
        )}

        {/* Activity timeline */}
        {task.history && task.history.length > 0 && (
          <>
            <SectionHeader label="Activity Timeline" />
            {task.history
              .slice(-10)
              .reverse()
              .map((h, i, arr) => (
                <TimelineItem
                  key={i}
                  status={h.status}
                  label={h.status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                  meta={`${h.by ?? 'system'} \u00B7 ${new Date(h.ts).toLocaleString()}`}
                  reason={h.reason}
                  isLast={i === arr.length - 1}
                  t={t}
                />
              ))}
          </>
        )}

        {/* Bottom spacer for action buttons */}
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Sticky bottom actions */}
      <View style={[styles.bottomBar, { backgroundColor: t.bgCard, borderTopColor: t.border, ...t.shadow.md }]}>
        {(s === 'dispatched' || s === 'pending') && (
          <Button label="Dispatch" icon={<Ionicons name="rocket-outline" size={18} color="#fff" />} onPress={() => act(() => dispatchTask(task.id), 'Dispatch')} fullWidth />
        )}
        {(s === 'completed' || s === 'reviewing') && (
          <View style={styles.actionRow}>
            <Button label="Reject" variant="danger" onPress={() => act(() => updateTaskStatus(task.id, 'needs_revision'), 'Reject')} style={styles.actionBtn} icon={<Ionicons name="close" size={18} color="#fff" />} />
            <Button label="Approve" onPress={() => act(() => updateTaskStatus(task.id, 'approved'), 'Approve')} style={styles.actionBtn} icon={<Ionicons name="checkmark" size={18} color="#fff" />} />
          </View>
        )}
        {s === 'needs_revision' && (
          <View style={styles.actionRow}>
            <Button label="Approve Override" onPress={() => act(() => updateTaskStatus(task.id, 'approved'), 'Approve')} style={styles.actionBtn} icon={<Ionicons name="checkmark" size={18} color="#fff" />} />
            <Button label="Redispatch" variant="secondary" onPress={() => act(() => dispatchTask(task.id), 'Redispatch')} style={styles.actionBtn} icon={<Ionicons name="refresh-outline" size={18} color="#2563EB" />} />
          </View>
        )}
        {s === 'blocked' && (
          <Button label="Unblock" variant="secondary" onPress={() => setShowUnblock(true)} fullWidth icon={<Ionicons name="lock-open-outline" size={18} color="#2563EB" />} />
        )}
        {s === 'approved' && (
          <View style={styles.approvedBar}>
            <Ionicons name="checkmark-circle" size={20} color={t.success} />
            <Text style={[styles.approvedText, { color: t.success }]}>Approved</Text>
          </View>
        )}
      </View>

      {/* Unblock bottom sheet */}
      <BottomSheet visible={showUnblock} onClose={() => setShowUnblock(false)} title="Unblock Task">
        <Text style={[styles.sheetLabel, { color: t.textSecondary }]}>FEEDBACK</Text>
        <TextInput
          style={[styles.sheetInput, { backgroundColor: t.bgSubtle, borderColor: t.border, color: t.text }]}
          value={unblockMsg}
          onChangeText={setUnblockMsg}
          placeholder="Provide guidance to unblock..."
          placeholderTextColor={t.placeholder}
          multiline
        />
        <Text style={[styles.charCount, { color: t.textTertiary }]}>{unblockMsg.length} / 500</Text>
        <View style={{ gap: 10, marginTop: 12 }}>
          <Button label="Send & Unblock" onPress={handleUnblock} fullWidth />
          <Button label="Cancel" variant="ghost" onPress={() => setShowUnblock(false)} fullWidth />
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, paddingBottom: 40 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  emptyText: { fontSize: 16 },

  // Title area
  taskTitle: { fontSize: 24, fontWeight: '800', marginBottom: 10 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  description: { fontSize: 14, lineHeight: 20, marginBottom: 16 },

  // PR card
  prCard: { marginBottom: 16 },
  prCardRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12 },
  prCardTitle: { fontSize: 15, fontWeight: '600' as const },
  prCardSub: { fontSize: 12, marginTop: 2 },

  // Detail card
  detailCard: { marginBottom: 16 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  infoLabel: { fontSize: 13, width: 70 },
  infoValue: { fontSize: 13, fontWeight: '500', flex: 1, textAlign: 'right' },

  // Metrics
  metricsRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  metricCard: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    alignItems: 'center',
  },
  metricValue: { fontSize: 28, fontWeight: '800' },
  metricLabel: { fontSize: 12, marginTop: 4 },

  // Summary / issues
  summaryCard: { marginBottom: 12 },
  summaryText: { fontSize: 14, lineHeight: 20 },
  issueCard: { marginBottom: 12 },
  issueRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingVertical: 3 },
  issueText: { fontSize: 13, flex: 1 },

  // Blocker
  blockerCard: { borderLeftWidth: 3, marginBottom: 16 },
  blockerHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  blockerTitle: { fontSize: 14, fontWeight: '700' },
  blockerReason: { fontSize: 14, lineHeight: 20 },

  // Reply
  replyCard: { marginBottom: 16 },
  replyText: { fontSize: 13, fontFamily: 'monospace', lineHeight: 18 },

  // Timeline
  timelineRow: { flexDirection: 'row', minHeight: 56 },
  timelineLeft: { alignItems: 'center', width: 24, marginRight: 12 },
  timelineDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  timelineLine: { width: 2, flex: 1, marginTop: 4 },
  timelineContent: { flex: 1, paddingBottom: 16 },
  timelineLabel: { fontSize: 14, fontWeight: '600' },
  timelineMeta: { fontSize: 12, marginTop: 2 },
  timelineReason: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 6,
    padding: 8,
    borderRadius: 8,
  },
  timelineReasonText: { fontSize: 12, flex: 1, lineHeight: 16 },

  // Bottom action bar
  bottomBar: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
  },
  actionRow: { flexDirection: 'row', gap: 12 },
  actionBtn: { flex: 1 },
  approvedBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8 },
  approvedText: { fontSize: 16, fontWeight: '700' },

  // Bottom sheet
  sheetLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  sheetInput: {
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    minHeight: 100,
    textAlignVertical: 'top',
    borderWidth: 1,
  },
  charCount: { fontSize: 11, textAlign: 'right', marginTop: 4 },
});
