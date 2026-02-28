import { useState } from 'react';
import { View, Text, TextInput, ScrollView, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useBoardStore } from '../../hooks/useBoardStore';
import { useTheme } from '../../hooks/useTheme';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { Badge } from '../../components/ui/Badge';
import { ConnectionIndicator } from '../../components/ConnectionIndicator';

export default function SettingsScreen() {
  const serverUrl = useBoardStore((s) => s.serverUrl);
  const setServerUrl = useBoardStore((s) => s.setServerUrl);
  const connectionStatus = useBoardStore((s) => s.connectionStatus);
  const [draft, setDraft] = useState(serverUrl);
  const [testing, setTesting] = useState(false);
  const t = useTheme();

  const handleSave = () => {
    const url = draft.replace(/\/+$/, '');
    setServerUrl(url);
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
      const res = await fetch(`${url}/api/board`, { signal: AbortSignal.timeout(5000) });
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
              placeholder="http://192.168.1.100:3461"
              placeholderTextColor={t.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
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
          <View style={styles.integrationRow}>
            <Ionicons name="logo-github" size={24} color={t.text} />
            <View style={styles.integrationInfo}>
              <Text style={[styles.integrationName, { color: t.text }]}>GitHub</Text>
              <Text style={[styles.integrationStatus, { color: t.textSecondary }]}>Not connected</Text>
            </View>
            <Badge label="Soon" bg={t.bgSubtle} color={t.textTertiary} size="sm" />
          </View>
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
});
