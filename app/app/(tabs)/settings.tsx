import { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet, Alert, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useBoardStore } from '../../hooks/useBoardStore';
import { useTheme } from '../../hooks/useTheme';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { Badge } from '../../components/ui/Badge';
import { BottomSheet } from '../../components/ui/BottomSheet';
import { ConnectionIndicator } from '../../components/ConnectionIndicator';
import {
  storeGithubToken,
  checkGithubToken,
  testGithubToken,
  deleteGithubToken,
  getGithubIntegration,
  updateGithubIntegration,
} from '../../lib/api';

export default function SettingsScreen() {
  const serverUrl = useBoardStore((s) => s.serverUrl);
  const setServerUrl = useBoardStore((s) => s.setServerUrl);
  const apiToken = useBoardStore((s) => s.apiToken);
  const setApiToken = useBoardStore((s) => s.setApiToken);
  const connectionStatus = useBoardStore((s) => s.connectionStatus);
  const defaultApiUrl = useBoardStore((s) => s.defaultApiUrl);
  const resetServerUrl = useBoardStore((s) => s.resetServerUrl);
  const [draft, setDraft] = useState(serverUrl);
  const [draftToken, setDraftToken] = useState(apiToken);
  const [testing, setTesting] = useState(false);
  const t = useTheme();

  // GitHub token management state
  const [showGitHub, setShowGitHub] = useState(false);
  const [ghTokenDraft, setGhTokenDraft] = useState('');
  const [ghConfigured, setGhConfigured] = useState(false);
  const [ghUsername, setGhUsername] = useState<string | null>(null);
  const [ghSaving, setGhSaving] = useState(false);
  const [ghTesting, setGhTesting] = useState(false);

  // GitHub webhook integration state
  const [whEnabled, setWhEnabled] = useState(false);
  const [whSecretDraft, setWhSecretDraft] = useState('');
  const [whSecretConfigured, setWhSecretConfigured] = useState(false);
  const [whAssignee, setWhAssignee] = useState('engineer_lite');
  const [whTargetRepos, setWhTargetRepos] = useState('');
  const [whIgnoreLabels, setWhIgnoreLabels] = useState('');
  const [whSaving, setWhSaving] = useState(false);

  const refreshGhStatus = useCallback(async () => {
    try {
      const status = await checkGithubToken();
      setGhConfigured(status.configured === true);
    } catch {
      setGhConfigured(false);
    }
    try {
      const wh = await getGithubIntegration();
      setWhEnabled(wh.enabled === true);
      setWhSecretConfigured(wh.webhookSecretConfigured === true);
      setWhAssignee(wh.assignee || 'engineer_lite');
      setWhTargetRepos((wh.targetRepos || []).join(', '));
      setWhIgnoreLabels((wh.ignoreLabels || []).join(', '));
    } catch { /* server may not have integration config yet */ }
  }, []);

  useEffect(() => {
    refreshGhStatus();
  }, [refreshGhStatus]);

  const handleGhSaveAndTest = async () => {
    const token = ghTokenDraft.trim();
    if (!token) {
      Alert.alert('Error', 'Please enter a GitHub Personal Access Token.');
      return;
    }
    setGhSaving(true);
    try {
      await storeGithubToken(token);
      setGhConfigured(true);
      setGhTokenDraft('');
      // Test the token
      setGhTesting(true);
      const result = await testGithubToken();
      setGhUsername(result.username || null);
      Alert.alert('Connected', `GitHub token saved and verified.\nLogged in as: ${result.username}`);
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setGhSaving(false);
      setGhTesting(false);
    }
  };

  const handleGhTest = async () => {
    setGhTesting(true);
    try {
      const result = await testGithubToken();
      setGhUsername(result.username || null);
      Alert.alert('Token Valid', `Logged in as: ${result.username}`);
    } catch (err: any) {
      Alert.alert('Test Failed', err.message);
    } finally {
      setGhTesting(false);
    }
  };

  const handleGhRemove = async () => {
    Alert.alert('Remove Token', 'Remove your GitHub Personal Access Token?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteGithubToken();
            setGhConfigured(false);
            setGhUsername(null);
            Alert.alert('Removed', 'GitHub token has been removed.');
          } catch (err: any) {
            Alert.alert('Error', err.message);
          }
        },
      },
    ]);
  };

  const handleWhSave = async () => {
    setWhSaving(true);
    try {
      const payload: Record<string, any> = {
        enabled: whEnabled,
        assignee: whAssignee.trim() || 'engineer_lite',
        targetRepos: whTargetRepos.split(',').map((s: string) => s.trim()).filter(Boolean),
        ignoreLabels: whIgnoreLabels.split(',').map((s: string) => s.trim()).filter(Boolean),
      };
      if (whSecretDraft.trim()) {
        payload.webhookSecret = whSecretDraft.trim();
      }
      const result = await updateGithubIntegration(payload);
      setWhSecretConfigured(result.webhookSecretConfigured === true);
      setWhSecretDraft('');
      Alert.alert('Saved', 'GitHub webhook settings updated.');
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setWhSaving(false);
    }
  };

  const isUsingDefault = defaultApiUrl !== '' && draft === defaultApiUrl;
  const hasOverridden = defaultApiUrl !== '' && draft !== defaultApiUrl;

  const handleSave = () => {
    const url = draft.replace(/\/+$/, '');
    setServerUrl(url);
    setApiToken(draftToken.trim());
    Alert.alert('Saved', url ? `Server: ${url}` : 'Server URL cleared');
  };

  const handleTest = async () => {
    const url = draft.replace(/\/+$/, '');
    if (!url) {
      Alert.alert('Error', 'Enter a server URL first');
      return;
    }
    setTesting(true);
    try {
      const headers: Record<string, string> = {};
      const token = draftToken.trim();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${url}/api/board`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const board = await res.json();
        const taskCount = board?.taskPlan?.tasks?.length ?? 0;
        Alert.alert('Connected', `Server reachable. ${taskCount} task(s) on board.`);
      } else {
        Alert.alert('Error', `Server returned ${res.status}`);
      }
    } catch (err: any) {
      Alert.alert('Connection Failed', err.message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: t.bg }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Connection status card */}
        <Card style={[styles.statusCard, { backgroundColor: connectionStatus === 'connected' ? t.successBg : t.bgCard }]}>
          <View style={styles.statusRow}>
            <ConnectionIndicator />
            <Text style={[styles.statusLabel, { color: t.text }]}>
              {serverUrl || 'No server configured'}
            </Text>
          </View>
        </Card>

        {/* Server connection */}
        <SectionHeader label="Server Connection" />
        <Card>
          <Text style={[styles.inputLabel, { color: t.textSecondary }]}>Server URL</Text>
          <View style={[styles.inputBox, { backgroundColor: t.bgSubtle, borderColor: t.border }]}>
            <Ionicons name="link-outline" size={16} color={t.textTertiary} />
            <TextInput
              style={[styles.input, { color: t.text }]}
              value={draft}
              onChangeText={setDraft}
              placeholder={defaultApiUrl || 'http://192.168.1.100:3461'}
              placeholderTextColor={t.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
          {isUsingDefault && (
            <Text style={[styles.defaultHint, { color: t.success }]}>
              Using default: {defaultApiUrl}
            </Text>
          )}
          {hasOverridden && (
            <Button
              label="Reset to default"
              variant="secondary"
              onPress={() => {
                resetServerUrl();
                setDraft(defaultApiUrl);
              }}
              style={styles.resetBtn}
            />
          )}
          <Text style={[styles.inputLabel, { color: t.textSecondary }]}>API Token</Text>
          <View style={[styles.inputBox, { backgroundColor: t.bgSubtle, borderColor: t.border }]}>
            <Ionicons name="key-outline" size={16} color={t.textTertiary} />
            <TextInput
              style={[styles.input, { color: t.text }]}
              value={draftToken}
              onChangeText={setDraftToken}
              placeholder="Optional — leave empty if no auth"
              placeholderTextColor={t.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
          </View>
          <View style={styles.btnRow}>
            <Button label="Save" onPress={handleSave} style={styles.btn} />
            <Button
              label="Test Connection"
              variant="secondary"
              onPress={handleTest}
              loading={testing}
              style={styles.btn}
              icon={<Ionicons name="wifi-outline" size={16} color={t.primary} />}
            />
          </View>
        </Card>

        {/* Integrations (future) */}
        <SectionHeader label="Integrations" />
        <Card>
          <Pressable style={styles.integrationRow} onPress={() => setShowGitHub(true)}>
            <Ionicons name="logo-github" size={24} color={t.text} />
            <View style={styles.integrationInfo}>
              <Text style={[styles.integrationName, { color: t.text }]}>GitHub</Text>
              <Text style={[styles.integrationStatus, { color: ghConfigured ? t.success : t.textSecondary }]}>
                {ghConfigured ? (ghUsername ? `Connected as ${ghUsername}` : 'Connected') : 'Not connected'}
              </Text>
            </View>
            {ghConfigured && whEnabled ? (
              <Badge label="Connected" bg={t.successBg} color={t.success} size="sm" />
            ) : ghConfigured ? (
              <Badge label="PAT Only" bg={t.bgSubtle} color={t.textSecondary} size="sm" />
            ) : (
              <Ionicons name="chevron-forward" size={18} color={t.textTertiary} />
            )}
          </Pressable>
          <View style={[styles.divider, { backgroundColor: t.border }]} />
          <View style={styles.integrationRow}>
            <Ionicons name="cube-outline" size={24} color={t.text} />
            <View style={styles.integrationInfo}>
              <Text style={[styles.integrationName, { color: t.text }]}>Jira</Text>
              <Text style={[styles.integrationStatus, { color: t.textSecondary }]}>Not connected</Text>
            </View>
            <Badge label="Soon" bg={t.bgSubtle} color={t.textTertiary} size="sm" />
          </View>
        </Card>

        {/* Gestures help */}
        <SectionHeader label="Quick Actions" />
        <Card>
          <View style={styles.gestureRow}>
            <Ionicons name="arrow-forward" size={18} color={t.primary} />
            <View style={styles.gestureInfo}>
              <Text style={[styles.gestureName, { color: t.text }]}>Swipe right</Text>
              <Text style={[styles.gestureDesc, { color: t.textSecondary }]}>Dispatch task</Text>
            </View>
          </View>
          <View style={[styles.divider, { backgroundColor: t.border }]} />
          <View style={styles.gestureRow}>
            <Ionicons name="arrow-back" size={18} color={t.success} />
            <View style={styles.gestureInfo}>
              <Text style={[styles.gestureName, { color: t.text }]}>Swipe left</Text>
              <Text style={[styles.gestureDesc, { color: t.textSecondary }]}>Approve task</Text>
            </View>
          </View>
        </Card>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* GitHub Token BottomSheet */}
      <BottomSheet visible={showGitHub} onClose={() => setShowGitHub(false)} title="GitHub Integration">
        {ghConfigured ? (
          <>
            <View style={styles.ghConnectedRow}>
              <Ionicons name="checkmark-circle" size={20} color={t.success} />
              <Text style={[styles.ghConnectedText, { color: t.text }]}>
                {ghUsername ? `Connected as ${ghUsername}` : 'Token configured'}
              </Text>
            </View>
            <View style={{ gap: 10, marginTop: 16 }}>
              <Button
                label="Test Connection"
                variant="secondary"
                onPress={handleGhTest}
                loading={ghTesting}
                fullWidth
                icon={<Ionicons name="wifi-outline" size={16} color={t.primary} />}
              />
              <Button
                label="Remove Token"
                variant="danger"
                onPress={handleGhRemove}
                fullWidth
                icon={<Ionicons name="trash-outline" size={16} color="#fff" />}
              />
            </View>
          </>
        ) : (
          <>
            <Text style={[styles.ghHint, { color: t.textSecondary }]}>
              Enter a GitHub Personal Access Token with the <Text style={{ fontWeight: '700' }}>repo</Text> scope.
              Your token is encrypted and stored securely on the server.
            </Text>
            <Text style={[styles.inputLabel, { color: t.textSecondary }]}>Personal Access Token</Text>
            <View style={[styles.inputBox, { backgroundColor: t.bgSubtle, borderColor: t.border }]}>
              <Ionicons name="key-outline" size={16} color={t.textTertiary} />
              <TextInput
                style={[styles.input, { color: t.text }]}
                value={ghTokenDraft}
                onChangeText={setGhTokenDraft}
                placeholder="ghp_xxxxxxxxxxxx"
                placeholderTextColor={t.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
            </View>
            <View style={{ gap: 10, marginTop: 4 }}>
              <Button
                label="Save & Test"
                onPress={handleGhSaveAndTest}
                loading={ghSaving}
                fullWidth
                icon={<Ionicons name="save-outline" size={16} color="#fff" />}
              />
              <Button
                label="Cancel"
                variant="ghost"
                onPress={() => setShowGitHub(false)}
                fullWidth
              />
            </View>
          </>
        )}

        {/* Divider between PAT and Webhook sections */}
        <View style={[styles.divider, { backgroundColor: t.border, marginVertical: 16 }]} />

        {/* Webhook Integration Section */}
        <Text style={[styles.inputLabel, { color: t.textSecondary }]}>WEBHOOK INTEGRATION</Text>

        <View style={styles.toggleRow}>
          <Text style={[styles.toggleLabel, { color: t.text }]}>Enabled</Text>
          <Switch value={whEnabled} onValueChange={setWhEnabled} />
        </View>

        <Text style={[styles.inputLabel, { color: t.textSecondary }]}>Webhook URL</Text>
        <View style={[styles.inputBox, { backgroundColor: t.bgSubtle, borderColor: t.border }]}>
          <Ionicons name="link-outline" size={16} color={t.textTertiary} />
          <TextInput
            style={[styles.input, { color: t.textSecondary }]}
            value={`${serverUrl}/api/webhooks/github`}
            editable={false}
            selectTextOnFocus
          />
        </View>

        <Text style={[styles.inputLabel, { color: t.textSecondary }]}>Webhook Secret</Text>
        <View style={[styles.inputBox, { backgroundColor: t.bgSubtle, borderColor: t.border }]}>
          <Ionicons name="key-outline" size={16} color={t.textTertiary} />
          <TextInput
            style={[styles.input, { color: t.text }]}
            value={whSecretDraft}
            onChangeText={setWhSecretDraft}
            placeholder={whSecretConfigured ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022  (configured)' : 'Enter webhook secret'}
            placeholderTextColor={t.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
        </View>
        {whSecretConfigured && (
          <View style={styles.secretHintRow}>
            <Ionicons name="checkmark-circle" size={14} color={t.success} />
            <Text style={{ color: t.success, fontSize: 12 }}>Secret configured</Text>
          </View>
        )}

        <Text style={[styles.inputLabel, { color: t.textSecondary }]}>Default Assignee</Text>
        <View style={[styles.inputBox, { backgroundColor: t.bgSubtle, borderColor: t.border }]}>
          <TextInput
            style={[styles.input, { color: t.text }]}
            value={whAssignee}
            onChangeText={setWhAssignee}
            placeholder="engineer_lite"
            placeholderTextColor={t.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <Text style={[styles.inputLabel, { color: t.textSecondary }]}>Target Repos</Text>
        <View style={[styles.inputBox, { backgroundColor: t.bgSubtle, borderColor: t.border }]}>
          <TextInput
            style={[styles.input, { color: t.text }]}
            value={whTargetRepos}
            onChangeText={setWhTargetRepos}
            placeholder="owner/repo, org/repo (empty = all)"
            placeholderTextColor={t.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <Text style={[styles.inputLabel, { color: t.textSecondary }]}>Ignore Labels</Text>
        <View style={[styles.inputBox, { backgroundColor: t.bgSubtle, borderColor: t.border }]}>
          <TextInput
            style={[styles.input, { color: t.text }]}
            value={whIgnoreLabels}
            onChangeText={setWhIgnoreLabels}
            placeholder="wontfix, question (empty = none)"
            placeholderTextColor={t.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <Button
          label="Save Webhook Settings"
          onPress={handleWhSave}
          loading={whSaving}
          fullWidth
          style={{ marginTop: 4 }}
          icon={<Ionicons name="save-outline" size={16} color="#fff" />}
        />
      </BottomSheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, paddingBottom: 40 },

  // Status card
  statusCard: { marginBottom: 8 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusLabel: { fontSize: 13, fontFamily: 'monospace', flex: 1 },

  // Input
  inputLabel: { fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  inputBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 12,
  },
  input: { flex: 1, fontSize: 15, padding: 0 },

  // Default URL hint + reset
  defaultHint: { fontSize: 12, marginBottom: 12, fontStyle: 'italic' },
  resetBtn: { marginBottom: 12 },

  // Buttons
  btnRow: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1 },

  // Integrations
  integrationRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  integrationInfo: { flex: 1 },
  integrationName: { fontSize: 15, fontWeight: '600' },
  integrationStatus: { fontSize: 12, marginTop: 1 },
  divider: { height: 1, marginVertical: 10 },

  // Gestures
  gestureRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  gestureInfo: { flex: 1 },
  gestureName: { fontSize: 15, fontWeight: '600' },
  gestureDesc: { fontSize: 12, marginTop: 1 },

  // GitHub BottomSheet
  ghConnectedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  ghConnectedText: { fontSize: 15, fontWeight: '600' },
  ghHint: { fontSize: 13, lineHeight: 19, marginBottom: 16 },

  // Webhook settings
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  toggleLabel: { fontSize: 15, fontWeight: '600' },
  secretHintRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 12, marginTop: -8 },
});
