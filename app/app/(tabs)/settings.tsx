import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBoardStore } from '../../hooks/useBoardStore';
import { ConnectionIndicator } from '../../components/ConnectionIndicator';

export default function SettingsScreen() {
  const serverUrl = useBoardStore((s) => s.serverUrl);
  const setServerUrl = useBoardStore((s) => s.setServerUrl);
  const [draft, setDraft] = useState(serverUrl);

  const handleSave = () => {
    const url = draft.replace(/\/+$/, ''); // trim trailing slashes
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
    <SafeAreaView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.label}>Server URL</Text>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="http://192.168.1.100:3461"
          placeholderTextColor="#666"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <View style={styles.row}>
          <Pressable
            style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
            onPress={handleSave}
          >
            <Text style={styles.btnText}>Save</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.btn, styles.btnSecondary, pressed && styles.btnPressed]}
            onPress={handleTest}
          >
            <Text style={styles.btnTextSecondary}>Test Connection</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Connection Status</Text>
        <ConnectionIndicator />
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Current Server</Text>
        <Text style={styles.value}>{serverUrl || '(not configured)'}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e', padding: 16 },
  section: { marginBottom: 24 },
  label: { color: '#aaa', fontSize: 13, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase' },
  input: {
    backgroundColor: '#252540',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#e0e0e0',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#333',
    marginBottom: 12,
  },
  row: { flexDirection: 'row', gap: 12 },
  btn: {
    flex: 1,
    backgroundColor: '#4fc3f7',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  btnSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#4fc3f7' },
  btnPressed: { opacity: 0.7 },
  btnText: { color: '#1a1a2e', fontSize: 15, fontWeight: '600' },
  btnTextSecondary: { color: '#4fc3f7', fontSize: 15, fontWeight: '600' },
  value: { color: '#e0e0e0', fontSize: 14, fontFamily: 'monospace' },
});
