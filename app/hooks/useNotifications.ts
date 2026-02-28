import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { useBoardStore } from './useBoardStore';
import type { Task, TaskStatus } from '../../shared/types';

// Configure notification behavior (foreground display)
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const NOTIFY_STATUSES: TaskStatus[] = ['completed', 'needs_revision', 'blocked', 'approved'];

export function useNotifications() {
  const board = useBoardStore((s) => s.board);
  const prevTasksRef = useRef<Map<string, TaskStatus>>(new Map());
  const pushTokenRegistered = useRef(false);

  // --- Push token registration (runs once on mount) ---
  useEffect(() => {
    if (pushTokenRegistered.current) return;

    (async () => {
      // Request permissions
      const { status } = await Notifications.getPermissionsAsync();
      let finalStatus = status;
      if (status !== 'granted') {
        const { status: newStatus } = await Notifications.requestPermissionsAsync();
        finalStatus = newStatus;
      }
      if (finalStatus !== 'granted') return;

      // Android requires a notification channel
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('default', {
          name: 'Default',
          importance: Notifications.AndroidImportance.HIGH,
          sound: 'default',
        });
      }

      try {
        // Get Expo push token
        const projectId = Constants.expoConfig?.extra?.eas?.projectId;
        const tokenData = await Notifications.getExpoPushTokenAsync({
          projectId: projectId || undefined,
        });
        const pushToken = tokenData.data;

        // Send to server
        const serverUrl = useBoardStore.getState().serverUrl;
        const apiToken = useBoardStore.getState().apiToken;
        if (serverUrl && pushToken) {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;

          fetch(`${serverUrl}/api/push-token`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              token: pushToken,
              deviceName: `${Platform.OS} device`,
            }),
          }).catch(() => {
            // Silent fail — push token registration is best-effort
          });

          pushTokenRegistered.current = true;
        }
      } catch (err) {
        // Push token acquisition can fail on simulators / web
        console.log('[notifications] Push token acquisition failed:', err);
      }
    })();
  }, []);

  // --- Handle notification tap -> deep link navigation ---
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data;
        if (data?.taskId) {
          router.push(`/task/${data.taskId}`);
        }
      }
    );
    return () => subscription.remove();
  }, []);

  // --- Local notification diffing (existing logic) ---
  useEffect(() => {
    if (!board?.taskPlan?.tasks) return;

    const prev = prevTasksRef.current;
    const current = new Map(board.taskPlan.tasks.map((t) => [t.id, t.status]));

    // Skip first load (no previous state to compare)
    if (prev.size === 0) {
      prevTasksRef.current = current;
      return;
    }

    for (const task of board.taskPlan.tasks) {
      const oldStatus = prev.get(task.id);
      if (oldStatus && oldStatus !== task.status && NOTIFY_STATUSES.includes(task.status)) {
        notify(task);
      }
    }

    // Check if all tasks approved
    const allApproved = board.taskPlan.tasks.length > 0 &&
      board.taskPlan.tasks.every((t) => t.status === 'approved');
    const wasAllApproved = prev.size > 0 &&
      board.taskPlan.tasks.every((t) => prev.get(t.id) === 'approved');

    if (allApproved && !wasAllApproved) {
      Notifications.scheduleNotificationAsync({
        content: {
          title: 'All Tasks Complete',
          body: board.taskPlan.goal || 'All tasks have been approved',
        },
        trigger: null,
      });
    }

    prevTasksRef.current = current;
  }, [board]);
}

function notify(task: Task) {
  const messages: Partial<Record<TaskStatus, { title: string; body: string }>> = {
    completed: { title: `${task.id} Completed`, body: `${task.title} — waiting for review` },
    needs_revision: { title: `${task.id} Needs Revision`, body: task.review?.summary || task.title },
    blocked: { title: `${task.id} Blocked`, body: task.blocker?.reason || task.title },
    approved: { title: `${task.id} Approved`, body: task.title },
  };

  const msg = messages[task.status];
  if (!msg) return;

  Notifications.scheduleNotificationAsync({
    content: {
      title: msg.title,
      body: msg.body,
      data: { taskId: task.id },
    },
    trigger: null,
  });
}
