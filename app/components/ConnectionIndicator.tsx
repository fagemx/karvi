import { useBoardStore, type ConnectionStatus } from '../hooks/useBoardStore';
import { Badge } from './ui/Badge';

export function ConnectionIndicator() {
  const status = useBoardStore((s) => s.connectionStatus);
  return <Badge status={status} variant="dot" size="sm" />;
}
