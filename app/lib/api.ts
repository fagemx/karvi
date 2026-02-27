import { useBoardStore } from '../hooks/useBoardStore';

function getBaseUrl(): string {
  return useBoardStore.getState().serverUrl;
}

export async function fetchBoard() {
  const res = await fetch(`${getBaseUrl()}/api/board`);
  if (!res.ok) throw new Error(`fetchBoard: ${res.status}`);
  return res.json();
}

export async function dispatchNext() {
  const res = await fetch(`${getBaseUrl()}/api/dispatch-next`, { method: 'POST' });
  if (!res.ok) throw new Error(`dispatchNext: ${res.status}`);
  return res.json();
}

export async function updateTaskStatus(taskId: string, status: string, reason?: string) {
  const res = await fetch(`${getBaseUrl()}/api/tasks/${taskId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, reason }),
  });
  if (!res.ok) throw new Error(`updateTaskStatus: ${res.status}`);
  return res.json();
}

export async function dispatchTask(taskId: string) {
  const res = await fetch(`${getBaseUrl()}/api/tasks/${taskId}/dispatch`, { method: 'POST' });
  if (!res.ok) throw new Error(`dispatchTask: ${res.status}`);
  return res.json();
}

export async function fetchBrief(taskId: string) {
  const res = await fetch(`${getBaseUrl()}/api/brief/${taskId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchBrief: ${res.status}`);
  return res.json();
}

export async function unblockTask(taskId: string, message: string) {
  const res = await fetch(`${getBaseUrl()}/api/tasks/${taskId}/unblock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`unblockTask: ${res.status}`);
  return res.json();
}
