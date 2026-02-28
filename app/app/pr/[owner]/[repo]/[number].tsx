import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Alert,
  Linking,
  useColorScheme,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type Theme } from '../../../../hooks/useTheme';
import { Card } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Badge } from '../../../../components/ui/Badge';
import { BottomSheet } from '../../../../components/ui/BottomSheet';
import { fetchPR, approvePR, requestChangesPR, mergePR } from '../../../../lib/api';
import { Palette } from '../../../../theme/tokens';
import type { GitHubPRSummary, GitHubPRFile } from '../../../../../shared/types';

// ---------------------------------------------------------------------------
// Diff line rendering
// ---------------------------------------------------------------------------

function DiffLine({ line, t, isDark }: { line: string; t: Theme; isDark: boolean }) {
  let bg = 'transparent';
  let color = t.text;

  if (line.startsWith('+')) {
    bg = isDark ? 'rgba(34,197,94,0.15)' : '#DCFCE7';
    color = isDark ? '#86EFAC' : '#166534';
  } else if (line.startsWith('-')) {
    bg = isDark ? 'rgba(239,68,68,0.15)' : '#FEE2E2';
    color = isDark ? '#FCA5A5' : '#991B1B';
  } else if (line.startsWith('@@')) {
    bg = isDark ? 'rgba(96,165,250,0.1)' : '#EFF6FF';
    color = isDark ? '#93C5FD' : '#1D4ED8';
  }

  return (
    <Text style={[styles.diffLine, { backgroundColor: bg, color }]} numberOfLines={1}>
      {line}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Collapsible file diff
// ---------------------------------------------------------------------------

function FileDiff({
  file,
  t,
  isDark,
}: {
  file: GitHubPRFile;
  t: Theme;
  isDark: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon: Record<string, { icon: string; color: string }> = {
    added: { icon: 'add-circle', color: Palette.green500 },
    removed: { icon: 'remove-circle', color: Palette.red500 },
    modified: { icon: 'create', color: Palette.amber500 },
    renamed: { icon: 'arrow-forward-circle', color: Palette.sky500 },
  };
  const si = statusIcon[file.status] || statusIcon.modified;

  const lines = file.patch ? file.patch.split('\n') : [];
  const truncated = lines.length > 500;
  const displayLines = truncated ? lines.slice(0, 500) : lines;

  return (
    <Card style={styles.fileCard}>
      <Pressable style={styles.fileHeader} onPress={() => setExpanded(!expanded)}>
        <Ionicons
          name={expanded ? 'chevron-down' : 'chevron-forward'}
          size={16}
          color={t.textSecondary}
        />
        <Ionicons name={si.icon as any} size={14} color={si.color} />
        <Text style={[styles.fileName, { color: t.text }]} numberOfLines={1}>
          {file.filename}
        </Text>
        <Text style={[styles.fileStats, { color: t.textTertiary }]}>
          +{file.additions} -{file.deletions}
        </Text>
      </Pressable>

      {expanded && (
        <View style={[styles.diffContainer, { backgroundColor: t.bgSubtle, borderColor: t.border }]}>
          {displayLines.length > 0 ? (
            displayLines.map((line, i) => <DiffLine key={i} line={line} t={t} isDark={isDark} />)
          ) : (
            <Text style={[styles.noPatch, { color: t.textTertiary }]}>
              Binary file or no diff available
            </Text>
          )}
          {truncated && (
            <Text style={[styles.truncatedMsg, { color: t.textSecondary }]}>
              ... truncated ({lines.length} lines total). View full diff on GitHub.
            </Text>
          )}
        </View>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Additions/Deletions bar
// ---------------------------------------------------------------------------

function ChangeBar({ additions, deletions, t }: { additions: number; deletions: number; t: Theme }) {
  const total = additions + deletions || 1;
  const addPct = (additions / total) * 100;

  return (
    <View style={styles.changeBarContainer}>
      <Text style={[styles.changeBarText, { color: Palette.green500 }]}>+{additions}</Text>
      <View style={[styles.changeBarTrack, { backgroundColor: t.bgSubtle }]}>
        <View style={[styles.changeBarFillAdd, { width: `${addPct}%` }]} />
        <View style={[styles.changeBarFillDel, { width: `${100 - addPct}%` }]} />
      </View>
      <Text style={[styles.changeBarText, { color: Palette.red500 }]}>-{deletions}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main PR Review Screen
// ---------------------------------------------------------------------------

export default function PRReviewScreen() {
  const { owner, repo, number } = useLocalSearchParams<{
    owner: string;
    repo: string;
    number: string;
  }>();

  const t = useTheme();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pr, setPr] = useState<GitHubPRSummary | null>(null);
  const [files, setFiles] = useState<GitHubPRFile[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showRequestChanges, setShowRequestChanges] = useState(false);
  const [requestChangesBody, setRequestChangesBody] = useState('');

  const loadPR = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPR(owner!, repo!, number!);
      setPr(data.pr);
      setFiles(data.files || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load PR');
    } finally {
      setLoading(false);
    }
  }, [owner, repo, number]);

  useEffect(() => {
    loadPR();
  }, [loadPR]);

  const handleApprove = async () => {
    setActionLoading('approve');
    try {
      await approvePR(owner!, repo!, number!);
      Alert.alert('Approved', `PR #${number} has been approved.`);
      loadPR();
    } catch (err: any) {
      Alert.alert('Approve Failed', err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRequestChanges = async () => {
    if (!requestChangesBody.trim()) {
      Alert.alert('Error', 'Please provide feedback for the changes requested.');
      return;
    }
    setActionLoading('request-changes');
    try {
      await requestChangesPR(owner!, repo!, number!, requestChangesBody.trim());
      Alert.alert('Changes Requested', `Changes requested on PR #${number}.`);
      setShowRequestChanges(false);
      setRequestChangesBody('');
      loadPR();
    } catch (err: any) {
      Alert.alert('Request Changes Failed', err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleMerge = async () => {
    Alert.alert(
      'Merge PR',
      `Are you sure you want to squash merge PR #${number}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Merge',
          style: 'destructive',
          onPress: async () => {
            setActionLoading('merge');
            try {
              await mergePR(owner!, repo!, number!);
              Alert.alert('Merged', `PR #${number} has been merged.`);
              loadPR();
            } catch (err: any) {
              Alert.alert('Merge Failed', err.message);
            } finally {
              setActionLoading(null);
            }
          },
        },
      ],
    );
  };

  const handleOpenGitHub = () => {
    Linking.openURL(`https://github.com/${owner}/${repo}/pull/${number}`);
  };

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const isMerged = pr?.merged === true;
  const isClosed = pr?.state === 'closed' && !isMerged;
  const isOpen = pr?.state === 'open';
  const actionsDisabled = !isOpen || !!actionLoading;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <View style={[styles.container, { backgroundColor: t.bg }]}>
      <Stack.Screen
        options={{
          title: `PR #${number}`,
          headerStyle: { backgroundColor: t.headerBg },
          headerTintColor: t.text,
          headerShadowVisible: false,
          headerRight: () => (
            <Pressable onPress={handleOpenGitHub} hitSlop={8}>
              <Ionicons name="open-outline" size={20} color={t.primary} />
            </Pressable>
          ),
        }}
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={t.primary} />
          <Text style={[styles.loadingText, { color: t.textSecondary }]}>
            Loading PR...
          </Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Ionicons name="alert-circle" size={48} color={t.danger} />
          <Text style={[styles.errorText, { color: t.text }]}>{error}</Text>
          <Button label="Retry" onPress={loadPR} style={{ marginTop: 16 }} />
          {error.includes('token') && (
            <Text style={[styles.errorHint, { color: t.textSecondary }]}>
              Configure your GitHub token in Settings {'>'} Integrations.
            </Text>
          )}
        </View>
      ) : pr ? (
        <>
          <ScrollView contentContainerStyle={styles.scroll}>
            {/* PR Header */}
            <Text style={[styles.prTitle, { color: t.text }]}>{pr.title}</Text>
            <View style={styles.metaRow}>
              <Text style={[styles.metaText, { color: t.textSecondary }]}>
                {pr.user?.login}
              </Text>
              <Text style={[styles.metaDot, { color: t.textTertiary }]}>{'\u00B7'}</Text>
              {isMerged && <Badge label="Merged" bg={Palette.purple100} color={Palette.purple500} size="sm" />}
              {isClosed && <Badge label="Closed" bg={Palette.red100} color={Palette.red500} size="sm" />}
              {isOpen && <Badge label="Open" bg={Palette.green100} color={Palette.green500} size="sm" />}
              <Text style={[styles.metaDot, { color: t.textTertiary }]}>{'\u00B7'}</Text>
              <Text style={[styles.metaText, { color: t.textSecondary }]}>
                {files.length} file{files.length !== 1 ? 's' : ''}
              </Text>
            </View>

            {/* Branch info */}
            <Card style={styles.branchCard}>
              <View style={styles.branchRow}>
                <Ionicons name="git-branch-outline" size={16} color={t.textSecondary} />
                <Text style={[styles.branchText, { color: t.text }]}>{pr.base?.ref}</Text>
                <Ionicons name="arrow-back" size={14} color={t.textTertiary} />
                <Text style={[styles.branchText, { color: t.primary }]}>{pr.head?.ref}</Text>
              </View>
            </Card>

            {/* Changes bar */}
            <ChangeBar additions={totalAdditions} deletions={totalDeletions} t={t} />

            {/* File list */}
            {files.map((file, i) => (
              <FileDiff key={i} file={file} t={t} isDark={isDark} />
            ))}

            {/* Bottom spacer for action bar */}
            <View style={{ height: 120 }} />
          </ScrollView>

          {/* Bottom action bar */}
          <View style={[styles.bottomBar, { backgroundColor: t.bgCard, borderTopColor: t.border, ...t.shadow.md }]}>
            {isMerged ? (
              <View style={styles.mergedBar}>
                <Ionicons name="git-merge" size={20} color={Palette.purple500} />
                <Text style={[styles.mergedText, { color: Palette.purple500 }]}>Merged</Text>
              </View>
            ) : isClosed ? (
              <View style={styles.mergedBar}>
                <Ionicons name="close-circle" size={20} color={Palette.red500} />
                <Text style={[styles.mergedText, { color: Palette.red500 }]}>Closed</Text>
              </View>
            ) : (
              <>
                <View style={styles.actionRow}>
                  <Button
                    label="Approve"
                    onPress={handleApprove}
                    disabled={actionsDisabled}
                    loading={actionLoading === 'approve'}
                    style={styles.actionBtn}
                    icon={<Ionicons name="checkmark" size={18} color="#fff" />}
                  />
                  <Button
                    label="Request Changes"
                    variant="secondary"
                    onPress={() => setShowRequestChanges(true)}
                    disabled={actionsDisabled}
                    style={styles.actionBtn}
                    icon={<Ionicons name="create-outline" size={18} color={t.primary} />}
                  />
                </View>
                <Button
                  label="Merge (Squash)"
                  variant="danger"
                  onPress={handleMerge}
                  disabled={actionsDisabled}
                  loading={actionLoading === 'merge'}
                  fullWidth
                  icon={<Ionicons name="git-merge" size={18} color="#fff" />}
                  style={{ marginTop: 8 }}
                />
              </>
            )}
          </View>

          {/* Request Changes bottom sheet */}
          <BottomSheet
            visible={showRequestChanges}
            onClose={() => setShowRequestChanges(false)}
            title="Request Changes"
          >
            <Text style={[styles.sheetLabel, { color: t.textSecondary }]}>FEEDBACK</Text>
            <TextInput
              style={[
                styles.sheetInput,
                { backgroundColor: t.bgSubtle, borderColor: t.border, color: t.text },
              ]}
              value={requestChangesBody}
              onChangeText={setRequestChangesBody}
              placeholder="Describe what changes are needed..."
              placeholderTextColor={t.placeholder}
              multiline
            />
            <View style={{ gap: 10, marginTop: 12 }}>
              <Button
                label="Submit Review"
                onPress={handleRequestChanges}
                loading={actionLoading === 'request-changes'}
                fullWidth
              />
              <Button
                label="Cancel"
                variant="ghost"
                onPress={() => setShowRequestChanges(false)}
                fullWidth
              />
            </View>
          </BottomSheet>
        </>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  loadingText: { fontSize: 14, marginTop: 8 },
  errorText: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  errorHint: { fontSize: 13, textAlign: 'center', marginTop: 8 },

  // PR header
  prTitle: { fontSize: 22, fontWeight: '800', marginBottom: 8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16, flexWrap: 'wrap' },
  metaText: { fontSize: 13 },
  metaDot: { fontSize: 13 },

  // Branch
  branchCard: { marginBottom: 12 },
  branchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  branchText: { fontSize: 13, fontFamily: 'monospace' },

  // Change bar
  changeBarContainer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16, paddingHorizontal: 4 },
  changeBarText: { fontSize: 12, fontWeight: '700', fontFamily: 'monospace', minWidth: 40 },
  changeBarTrack: { flex: 1, height: 8, borderRadius: 4, flexDirection: 'row', overflow: 'hidden' },
  changeBarFillAdd: { backgroundColor: Palette.green500, height: '100%' },
  changeBarFillDel: { backgroundColor: Palette.red500, height: '100%' },

  // File card
  fileCard: { marginBottom: 8 },
  fileHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fileName: { fontSize: 13, fontFamily: 'monospace', flex: 1 },
  fileStats: { fontSize: 12, fontFamily: 'monospace' },

  // Diff
  diffContainer: {
    marginTop: 10,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
    maxHeight: 600,
  },
  diffLine: {
    fontFamily: 'monospace',
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 1,
    lineHeight: 16,
  },
  noPatch: { padding: 16, textAlign: 'center', fontSize: 13 },
  truncatedMsg: { padding: 12, textAlign: 'center', fontSize: 12, fontStyle: 'italic' },

  // Bottom bar
  bottomBar: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
  },
  actionRow: { flexDirection: 'row', gap: 10 },
  actionBtn: { flex: 1 },
  mergedBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8 },
  mergedText: { fontSize: 16, fontWeight: '700' },

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
});
