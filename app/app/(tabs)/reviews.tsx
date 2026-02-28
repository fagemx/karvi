import { useState, useMemo } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useBoardStore } from '../../hooks/useBoardStore';
import { useTheme, type Theme } from '../../hooks/useTheme';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { updateTaskStatus } from '../../lib/api';
import type { Task } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Review tabs — filter tasks by review-relevant status
// ---------------------------------------------------------------------------

type ReviewTab = 'active' | 'approved' | 'revision';

const TABS: { id: ReviewTab; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'approved', label: 'Approved' },
  { id: 'revision', label: 'Revision' },
];

function tabFilter(tab: ReviewTab): (t: Task) => boolean {
  switch (tab) {
    case 'active':
      return (t) => t.status === 'completed' || t.status === 'reviewing';
    case 'approved':
      return (t) => t.status === 'approved';
    case 'revision':
      return (t) => t.status === 'needs_revision';
  }
}

// ---------------------------------------------------------------------------
// PR-style review card
// ---------------------------------------------------------------------------

function ReviewCard({ task, theme: t }: { task: Task; theme: Theme }) {
  const router = useRouter();
  const review = task.review;
  const hasReview = review && review.score != null;

  const handleApprove = async () => {
    try {
      await updateTaskStatus(task.id, 'approved');
    } catch {}
  };

  const handleReject = async () => {
    try {
      await updateTaskStatus(task.id, 'needs_revision');
    } catch {}
  };

  return (
    <Card onPress={() => router.push(`/task/${task.id}`)} style={styles.reviewCard}>
      <View style={styles.cardHeader}>
        <View style={[styles.cardIcon, { backgroundColor: t.primaryLight }]}>
          <Ionicons name="git-pull-request" size={18} color={t.primary} />
        </View>
        <View style={styles.cardTitleArea}>
          <Text style={[styles.cardTitle, { color: t.text }]} numberOfLines={1}>
            {task.title}
          </Text>
          <Text style={[styles.cardMeta, { color: t.textSecondary }]}>
            {task.id} {task.assignee ? `\u00B7 ${task.assignee}` : ''}{' '}
            {task.completedAt ? `\u00B7 ${timeAgo(task.completedAt)}` : ''}
          </Text>
        </View>
        <Badge status={task.status} size="sm" />
      </View>

      {/* Review stats row */}
      {hasReview && (
        <View style={[styles.statsRow, { borderTopColor: t.border }]}>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: t.textSecondary }]}>Score</Text>
            <Text style={[styles.statValue, { color: t.text }]}>{review.score}</Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: t.border }]} />
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: t.textSecondary }]}>Verdict</Text>
            <Text
              style={[
                styles.statValue,
                { color: review.verdict === 'approved' ? t.success : review.verdict === 'needs_revision' ? t.danger : t.text },
              ]}
            >
              {review.verdict ?? '-'}
            </Text>
          </View>
          {review.issues && review.issues.length > 0 && (
            <>
              <View style={[styles.statDivider, { backgroundColor: t.border }]} />
              <View style={styles.stat}>
                <Text style={[styles.statLabel, { color: t.textSecondary }]}>Issues</Text>
                <Text style={[styles.statValue, { color: t.danger }]}>{review.issues.length}</Text>
              </View>
            </>
          )}
        </View>
      )}

      {/* Review summary */}
      {review?.summary && (
        <Text style={[styles.summaryText, { color: t.textSecondary }]} numberOfLines={2}>
          {review.summary}
        </Text>
      )}

      {/* Action buttons — only for active reviews */}
      {(task.status === 'completed' || task.status === 'reviewing') && (
        <View style={styles.cardActions}>
          <Button
            label="Approve"
            size="sm"
            onPress={handleApprove}
            icon={<Ionicons name="checkmark" size={16} color="#fff" />}
            style={styles.cardBtn}
          />
          <Button
            label="Reject"
            variant="danger"
            size="sm"
            onPress={handleReject}
            icon={<Ionicons name="close" size={16} color="#fff" />}
            style={styles.cardBtn}
          />
        </View>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function ReviewsScreen() {
  const board = useBoardStore((s) => s.board);
  const serverUrl = useBoardStore((s) => s.serverUrl);
  const tasks: Task[] = board?.taskPlan?.tasks ?? [];
  const t = useTheme();

  const [activeTab, setActiveTab] = useState<ReviewTab>('active');

  // Only show tasks that have been through review or are ready for review
  const reviewTasks = useMemo(() => {
    return tasks.filter(tabFilter(activeTab));
  }, [tasks, activeTab]);

  const tabCounts = useMemo(() => {
    return {
      active: tasks.filter(tabFilter('active')).length,
      approved: tasks.filter(tabFilter('approved')).length,
      revision: tasks.filter(tabFilter('revision')).length,
    };
  }, [tasks]);

  if (!serverUrl) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: t.bg }]}>
        <View style={styles.empty}>
          <Ionicons name="server-outline" size={48} color={t.textTertiary} />
          <Text style={[styles.emptyTitle, { color: t.text }]}>No Server Connected</Text>
          <Text style={[styles.emptyText, { color: t.textSecondary }]}>
            Connect to a Karvi server to see reviews
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: t.bg }]} edges={['top']}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: t.border }]}>
        <Text style={[styles.title, { color: t.text }]}>Reviews</Text>
        <Ionicons name="search-outline" size={22} color={t.text} />
      </View>

      {/* Tab bar */}
      <View style={[styles.tabBar, { borderBottomColor: t.border }]}>
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const count = tabCounts[tab.id];
          return (
            <Pressable key={tab.id} style={styles.tab} onPress={() => setActiveTab(tab.id)}>
              <View style={styles.tabInner}>
                <Text
                  style={[
                    styles.tabLabel,
                    { color: isActive ? t.primary : t.textSecondary },
                    isActive && styles.tabLabelActive,
                  ]}
                >
                  {tab.label}
                </Text>
                {count > 0 && (
                  <View style={[styles.tabCount, { backgroundColor: isActive ? t.primary : t.bgSubtle }]}>
                    <Text style={[styles.tabCountText, { color: isActive ? '#fff' : t.textSecondary }]}>
                      {count}
                    </Text>
                  </View>
                )}
              </View>
              {isActive && <View style={[styles.tabIndicator, { backgroundColor: t.primary }]} />}
            </Pressable>
          );
        })}
      </View>

      {/* List */}
      <FlatList
        data={reviewTasks}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ReviewCard task={item} theme={t} />}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.emptyList}>
            <Ionicons
              name={activeTab === 'active' ? 'checkmark-done-outline' : 'archive-outline'}
              size={40}
              color={t.textTertiary}
            />
            <Text style={[styles.emptyText, { color: t.textSecondary }]}>
              {activeTab === 'active'
                ? 'No tasks waiting for review'
                : activeTab === 'approved'
                  ? 'No approved tasks yet'
                  : 'No tasks needing revision'}
            </Text>
          </View>
        }
      />
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
  title: { fontSize: 22, fontWeight: '800' },

  // Tab bar
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    position: 'relative',
  },
  tabInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tabLabel: { fontSize: 14, fontWeight: '500' },
  tabLabelActive: { fontWeight: '700' },
  tabCount: {
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 10,
    minWidth: 20,
    alignItems: 'center',
  },
  tabCountText: { fontSize: 11, fontWeight: '700' },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    left: '20%',
    right: '20%',
    height: 3,
    borderRadius: 2,
  },

  // List
  list: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  emptyList: { alignItems: 'center', paddingTop: 60, gap: 12 },

  // Review card
  reviewCard: { marginBottom: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitleArea: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardMeta: { fontSize: 12, marginTop: 2 },

  // Stats
  statsRow: {
    flexDirection: 'row',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  stat: { flex: 1, alignItems: 'center' },
  statLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: { fontSize: 18, fontWeight: '800', marginTop: 2 },
  statDivider: { width: 1, alignSelf: 'stretch' },

  // Summary
  summaryText: { fontSize: 13, lineHeight: 18, marginTop: 10 },

  // Actions
  cardActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  cardBtn: { flex: 1 },

  // Empty
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptyText: { fontSize: 14, textAlign: 'center' },
});
