import { View, Text, StyleSheet } from 'react-native';
import { useBoardStore, type ConnectionStatus } from '../hooks/useBoardStore';

const STATUS_DISPLAY: Record<ConnectionStatus, { color: string; label: string }> = {
  connected: { color: '#66bb6a', label: 'Live' },
  polling: { color: '#ffa726', label: 'Polling' },
  reconnecting: { color: '#ffa726', label: 'Reconnecting...' },
  disconnected: { color: '#ef5350', label: 'Disconnected' },
};

export function ConnectionIndicator() {
  const status = useBoardStore((s) => s.connectionStatus);
  const display = STATUS_DISPLAY[status];

  return (
    <View style={styles.container}>
      <View style={[styles.dot, { backgroundColor: display.color }]} />
      <Text style={[styles.label, { color: display.color }]}>{display.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontSize: 12, fontWeight: '500' },
});
