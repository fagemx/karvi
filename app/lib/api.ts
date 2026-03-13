import { useBoardStore } from '../hooks/useBoardStore';

function getBaseUrl(): string {
  return useBoardStore.getState().serverUrl;
}

function authHeaders(): Record<string, string> {
  const token = useBoardStore.getState().apiToken;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

export async function fetchBoard() {
  const res = await fetch(`${getBaseUrl()}/api/board`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`fetchBoard: ${res.status}`);
  return res.json();
}

export async function dispatchNext() {
  const res = await fetch(`${getBaseUrl()}/api/dispatch-next`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`dispatchNext: ${res.status}`);
  return res.json();
}

export async function updateTaskStatus(taskId: string, status: string, reason?: string) {
  const res = await fetch(`${getBaseUrl()}/api/tasks/${taskId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ status, reason }),
  });
  if (!res.ok) throw new Error(`updateTaskStatus: ${res.status}`);
  return res.json();
}

export async function dispatchTask(taskId: string) {
  const res = await fetch(`${getBaseUrl()}/api/tasks/${taskId}/dispatch`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`dispatchTask: ${res.status}`);
  return res.json();
}

export async function fetchBrief(taskId: string) {
  const res = await fetch(`${getBaseUrl()}/api/brief/${taskId}`, { headers: authHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchBrief: ${res.status}`);
  return res.json();
}

export async function unblockTask(taskId: string, message: string) {
  const res = await fetch(`${getBaseUrl()}/api/tasks/${taskId}/unblock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`unblockTask: ${res.status}`);
  return res.json();
}

export async function registerPushToken(token: string, deviceName: string) {
  const res = await fetch(`${getBaseUrl()}/api/push-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ token, deviceName }),
  });
  if (!res.ok) throw new Error(`registerPushToken: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// GitHub API (proxied through Karvi server)
// ---------------------------------------------------------------------------

export async function fetchPR(owner: string, repo: string, number: string) {
  const res = await fetch(`${getBaseUrl()}/api/github/pr/${owner}/${repo}/${number}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `fetchPR: ${res.status}`);
  }
  return res.json();
}

export async function approvePR(owner: string, repo: string, number: string) {
  const res = await fetch(`${getBaseUrl()}/api/github/pr/${owner}/${repo}/${number}/approve`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `approvePR: ${res.status}`);
  }
  return res.json();
}

export async function requestChangesPR(owner: string, repo: string, number: string, body: string) {
  const res = await fetch(`${getBaseUrl()}/api/github/pr/${owner}/${repo}/${number}/request-changes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(errBody.error || `requestChangesPR: ${res.status}`);
  }
  return res.json();
}

export async function mergePR(owner: string, repo: string, number: string) {
  const res = await fetch(`${getBaseUrl()}/api/github/pr/${owner}/${repo}/${number}/merge`, {
    method: 'PUT',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `mergePR: ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// GitHub Token Management
// ---------------------------------------------------------------------------

export async function storeGithubToken(token: string) {
  const res = await fetch(`${getBaseUrl()}/api/vault/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ userId: 'default', keyName: 'github_pat', value: token }),
  });
  if (!res.ok) throw new Error(`storeGithubToken: ${res.status}`);
  return res.json();
}

export async function checkGithubToken() {
  const res = await fetch(`${getBaseUrl()}/api/github/token/status`, {
    headers: authHeaders(),
  });
  if (!res.ok) return { configured: false };
  return res.json();
}

export async function testGithubToken() {
  const res = await fetch(`${getBaseUrl()}/api/github/token/test`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `testGithubToken: ${res.status}`);
  }
  return res.json();
}

export async function deleteGithubToken() {
  const res = await fetch(`${getBaseUrl()}/api/vault/delete/default/github_pat`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`deleteGithubToken: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// GitHub Integration Config (webhook settings)
// ---------------------------------------------------------------------------

export async function getGithubIntegration() {
  const res = await fetch(`${getBaseUrl()}/api/integrations/github`, {
    headers: authHeaders(),
  });
  if (!res.ok) return { enabled: false, webhookSecretConfigured: false };
  return res.json();
}

export async function updateGithubIntegration(config: Record<string, any>) {
  const res = await fetch(`${getBaseUrl()}/api/integrations/github`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `updateGithubIntegration: ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Task Creation
// ---------------------------------------------------------------------------

export interface CreateTaskPayload {
  title: string;
  description?: string;
  assignee?: string;
  priority?: string;
}

export async function createTask(task: CreateTaskPayload) {
  const taskId = `MOBILE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const descParts: string[] = [];
  if (task.priority && task.priority !== 'medium') {
    descParts.push(`[${task.priority.toUpperCase()}]`);
  }
  if (task.description) descParts.push(task.description);
  const description = descParts.join(' ') || undefined;

  const res = await fetch(`${getBaseUrl()}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      title: task.title,
      goal: task.description || task.title,
      tasks: [
        {
          id: taskId,
          title: task.title,
          description,
          assignee: task.assignee || 'engineer_lite',
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `createTask: ${res.status}`);
  }
  return res.json();
}
