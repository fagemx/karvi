import type { TaskStatus } from '../../shared/types';
import { Badge } from './ui/Badge';

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge status={status} />;
}
