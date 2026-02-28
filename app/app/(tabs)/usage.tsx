import { useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useBoardStore } from '../../hooks/useBoardStore';
import { useTheme, type Theme } from '../../hooks/useTheme';
import { Card } from '../../components/ui/Card';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { Badge } from '../../components/ui/Badge';
import type { Task } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Metric card
// ---------------------------------------------------------------------------

function MetricCard({
  icon,
  label,
  value,
  sub,
  color,
  t,
}: {
  icon: string;
  label: string;
  value: string;
  sub?: string;
  color?: string;
  t: Theme;
}) {
  return (
    <Card style={styles.metricCard}>
      <Ionicons name={icon as any} size={20} color={color ?? t.primary} />
      <Text style={[styles.metricValue, { color: t.text }]}>{value}</Text>
      <Text style={[styles.metricLabel, { color: t.textSecondary }]}>{label}</Text>
      {sub && <Text style={[styles.metricSub, { color: color ?? t.textTertiary }]}>{sub}</Text>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function ProgressRow({
  label,
  current,
  total,
  color,
  t,
}: {
  label: string;
  current: number;
  total: number;
  color: string;
  t: Theme;
}) {
  const pct = total > 0 ? Math.min(current / total, 1) : 0;
  const pctDisplay = Math.round(pct * 100);
  return (
    <View style={styles.progressContainer}>
      <View style={styles.progressHeader}>
        <Text style={[styles.progressLabel, { color: t.text }]}>{label}</Text>
        <Text style={[styles.progressValue, { color: t.textSecondary }]}>
          {current} / {total}
        </Text>
      </View>
      <View style={[styles.progressTrack, { backgroundColor: t.bgSubtle }]}>
        <View style={[styles.progressFill, { width: `${pctDisplay}%`, backgroundColor: color }]} />
      </View>
      {pct >= 0.8 && (
        <View style={styles.progressWarning}>
          <Ionicons name="warning" size={12} color={t.warning} />
          <Text style={[styles.progressWarningText, { color: t.warning }]}>
            {pctDisplay}% used
          </Text>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Status breakdown bar (mini stacked chart)
// ---------------------------------------------------------------------------

function StatusBreakdown({ tasks, t }: { tasks: Task[]; t: Theme }) {
  const counts = useMemo(() => {
    const c = { approved: 0, completed: 0, in_progress: 0, blocked: 0, pending: 0, other: 0 };
    tasks.forEach((task) => {
      if (task.status in c) (c as any)[task.status]++;
      else c.other++;
    });
    return c;
  }, [tasks]);

  const total = tasks.length || 1;
  const segments = [
    { key: 'approved', color: t.success, count: counts.approved },
    { key: 'completed', color: t.primary, count: counts.completed },
    { key: 'in_progress', color: t.warning, count: counts.in_progress },
    { key: 'blocked', color: t.danger, count: counts.blocked },
    { key: 'pending', color: t.textTertiary, count: counts.pending },
  ].filter((s) => s.count > 0);

  return (
    <View>
      <View style={[styles.breakdownBar, { backgroundColor: t.bgSubtle }]}>
        {segments.map((seg) => (
          <View
            key={seg.key}
            style={{
              flex: seg.count / total,
              height: 8,
              backgroundColor: seg.color,
            }}
          />
        ))}
      </View>
      <View style={styles.breakdownLegend}>
        {segments.map((seg) => (
          <View key={seg.key} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: seg.color }]} />
            <Text style={[styles.legendText, { color: t.textSecondary }]}>
              {seg.key.replace(/_/g, ' ')} ({seg.count})
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function UsageScreen() {
  const board = useBoardStore((s) => s.board);
  const serverUrl = useBoardStore((s) => s.serverUrl);
  const tasks: Task[] = board?.taskPlan?.tasks ?? [];
  const t = useTheme();

  const stats = useMemo(() => {
    const total = tasks.length;
    const approved = tasks.filter((t) => t.status === 'approved').length;
    const reviewed = tasks.filter((t) => t.review).length;
    const dispatched = tasks.filter((t) =>
      t.history?.some((h) => h.status === 'dispatched'),
    ).length;
    const blocked = tasks.filter((t) => t.status === 'blocked').length;
    const avgScore =
      tasks.reduce((sum, t) => sum + (t.review?.score ?? 0), 0) / (reviewed || 1);

    return { total, approved, reviewed, dispatched, blocked, avgScore };
  }, [tasks]);

  if (!serverUrl) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: t.bg }]}>
        <View style={styles.empty}>
          <Ionicons name="server-outline" size={48} color={t.textTertiary} />
          <Text style={[styles.emptyTitle, { color: t.text }]}>No Server Connected</Text>
          <Text style={[styles.emptyText, { color: t.textSecondary }]}>
            Connect to a Karvi server to see usage stats
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: t.bg }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.title, { color: t.text }]}>Usage</Text>
          <Badge label="Free Plan" bg={t.bgSubtle} color={t.textSecondary} />
        </View>

        {/* Top metrics */}
        <View style={styles.metricsGrid}>
          <MetricCard icon="layers" label="Total Tasks" value={String(stats.total)} t={t} />
          <MetricCard
            icon="checkmark-circle"
            label="Approved"
            value={String(stats.approved)}
            color={t.success}
            t={t}
          />
          <MetricCard
            icon="rocket"
            label="Dispatched"
            value={String(stats.dispatched)}
            color={t.primary}
            t={t}
          />
          <MetricCard
            icon="star"
            label="Avg Score"
            value={stats.avgScore > 0 ? stats.avgScore.toFixed(1) : '-'}
            color={t.warning}
            t={t}
          />
        </View>

        {/* Status breakdown */}
        {tasks.length > 0 && (
          <>
            <SectionHeader label="Status Breakdown" />
            <Card>
              <StatusBreakdown tasks={tasks} t={t} />
            </Card>
          </>
        )}

        {/* Completion progress */}
        <SectionHeader label="Progress" />
        <Card>
          <ProgressRow
            label="Task Completion"
            current={stats.approved}
            total={stats.total}
            color={t.success}
            t={t}
          />
          <View style={{ height: 16 }} />
          <ProgressRow
            label="Reviews Done"
            current={stats.reviewed}
            total={stats.total}
            color={t.primary}
            t={t}
          />
        </Card>

        {/* Blocked alert */}
        {stats.blocked > 0 && (
          <>
            <SectionHeader label="Attention" />
            <Card style={[styles.alertCard, { borderLeftColor: t.danger }]}>
              <View style={styles.alertRow}>
                <Ionicons name="warning" size={18} color={t.danger} />
                <View style={styles.alertInfo}>
                  <Text style={[styles.alertTitle, { color: t.danger }]}>
                    {stats.blocked} task{stats.blocked > 1 ? 's' : ''} blocked
                  </Text>
                  <Text style={[styles.alertDesc, { color: t.textSecondary }]}>
                    Requires manual intervention to continue
                  </Text>
                </View>
              </View>
            </Card>
          </>
        )}

        {/* Pro features preview */}
        <SectionHeader label="Pro Features" />
        <Card style={[styles.proCard, { backgroundColor: t.primaryLight }]}>
          <Ionicons name="diamond-outline" size={24} color={t.primary} />
          <Text style={[styles.proTitle, { color: t.primary }]}>Upgrade to Pro</Text>
          <Text style={[styles.proDesc, { color: t.textSecondary }]}>
            Unlock agent time tracking, token usage analytics, monthly reports, and API-based
            runtimes.
          </Text>
          <View style={styles.proFeatures}>
            {['Agent time tracking', 'Token usage', 'Monthly reports', 'API runtimes'].map((f) => (
              <View key={f} style={styles.proFeatureRow}>
                <Ionicons name="checkmark" size={14} color={t.success} />
                <Text style={[styles.proFeatureText, { color: t.text }]}>{f}</Text>
              </View>
            ))}
          </View>
        </Card>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, paddingBottom: 40 },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: { fontSize: 22, fontWeight: '800' },

  // Metrics grid
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 8,
  },
  metricCard: {
    width: '48%',
    flexGrow: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 16,
  },
  metricValue: { fontSize: 28, fontWeight: '800' },
  metricLabel: { fontSize: 12 },
  metricSub: { fontSize: 11, marginTop: 2 },

  // Breakdown
  breakdownBar: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 12,
  },
  breakdownLegend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11 },

  // Progress
  progressContainer: { marginBottom: 4 },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  progressLabel: { fontSize: 14, fontWeight: '600' },
  progressValue: { fontSize: 13 },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 4 },
  progressWarning: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  progressWarningText: { fontSize: 11, fontWeight: '600' },

  // Alert
  alertCard: { borderLeftWidth: 3 },
  alertRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  alertInfo: { flex: 1 },
  alertTitle: { fontSize: 14, fontWeight: '700' },
  alertDesc: { fontSize: 12, marginTop: 2 },

  // Pro
  proCard: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  proTitle: { fontSize: 18, fontWeight: '800' },
  proDesc: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
  proFeatures: { marginTop: 8, gap: 6, alignSelf: 'flex-start', width: '100%' },
  proFeatureRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  proFeatureText: { fontSize: 14 },

  // Empty
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptyText: { fontSize: 14, textAlign: 'center' },
});
