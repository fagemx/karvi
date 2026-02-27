import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useBoardStore } from './useBoardStore';
import type { Task, TaskStatus } from '../../shared/types';

// Configure notification behavior
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

  useEffect(() => {
    (async () => {
      const { status } = await Notifications.getPermissionsAsync();
      if (status !== 'granted') {
        await Notifications.requestPermissionsAsync();
      }
    })();
  }, []);

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
    content: { title: msg.title, body: msg.body },
    trigger: null,
  });
}
