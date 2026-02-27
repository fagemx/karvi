import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBoardStore } from '../../hooks/useBoardStore';
import { useTheme } from '../../hooks/useTheme';
import { ConnectionIndicator } from '../../components/ConnectionIndicator';

export default function SettingsScreen() {
  const serverUrl = useBoardStore((s) => s.serverUrl);
  const setServerUrl = useBoardStore((s) => s.setServerUrl);
  const [draft, setDraft] = useState(serverUrl);
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
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: t.bg }]}>
      <View style={styles.section}>
        <Text style={[styles.label, { color: t.textSecondary }]}>Server URL</Text>
        <TextInput
          style={[styles.input, { backgroundColor: t.inputBg, borderColor: t.border, color: t.text }]}
          value={draft}
          onChangeText={setDraft}
          placeholder="http://192.168.1.100:3461"
          placeholderTextColor={t.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <View style={styles.row}>
          <Pressable
            style={({ pressed }) => [styles.btn, { backgroundColor: t.accent }, pressed && styles.btnPressed]}
            onPress={handleSave}
          >
            <Text style={styles.btnText}>Save</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.btn,
              styles.btnSecondary,
              { borderColor: t.accent },
              pressed && styles.btnPressed,
            ]}
            onPress={handleTest}
          >
            <Text style={[styles.btnTextSecondary, { color: t.accent }]}>Test Connection</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={[styles.label, { color: t.textSecondary }]}>Connection Status</Text>
        <ConnectionIndicator />
      </View>

      <View style={styles.section}>
        <Text style={[styles.label, { color: t.textSecondary }]}>Current Server</Text>
        <Text style={[styles.value, { color: t.text }]}>{serverUrl || '(not configured)'}</Text>
      </View>

      <View style={styles.section}>
        <Text style={[styles.label, { color: t.textSecondary }]}>Swipe Gestures</Text>
        <Text style={[styles.hint, { color: t.textSecondary }]}>
          Swipe right on a task card to dispatch{'\n'}
          Swipe left to approve
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  section: { marginBottom: 24 },
  label: { fontSize: 13, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase' },
  input: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    marginBottom: 12,
  },
  row: { flexDirection: 'row', gap: 12 },
  btn: { flex: 1, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  btnSecondary: { backgroundColor: 'transparent', borderWidth: 1 },
  btnPressed: { opacity: 0.7 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  btnTextSecondary: { fontSize: 15, fontWeight: '600' },
  value: { fontSize: 14, fontFamily: 'monospace' },
  hint: { fontSize: 13, lineHeight: 20 },
});
