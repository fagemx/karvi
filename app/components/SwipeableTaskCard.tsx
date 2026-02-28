import { View, Text, StyleSheet, Alert } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import type { Task } from '../../shared/types';
import { TaskCard } from './TaskCard';
import { updateTaskStatus, dispatchTask } from '../lib/api';
import { useTheme } from '../hooks/useTheme';

const SWIPE_THRESHOLD = 100;

export function SwipeableTaskCard({ task }: { task: Task }) {
  const t = useTheme();
  const translateX = useSharedValue(0);

  const canApprove = task.status === 'completed' || task.status === 'reviewing' || task.status === 'needs_revision';
  const canDispatch = task.status === 'dispatched' || task.status === 'pending';

  const handleSwipeLeft = async () => {
    if (!canApprove) return;
    try {
      await updateTaskStatus(task.id, 'approved');
    } catch (err: any) {
      Alert.alert('Approve failed', err.message);
    }
  };

  const handleSwipeRight = async () => {
    if (!canDispatch) return;
    try {
      await dispatchTask(task.id);
    } catch (err: any) {
      Alert.alert('Dispatch failed', err.message);
    }
  };

  const gesture = Gesture.Pan()
    .onUpdate((e) => {
      translateX.value = e.translationX;
    })
    .onEnd((e) => {
      if (e.translationX < -SWIPE_THRESHOLD && canApprove) {
        runOnJS(handleSwipeLeft)();
      } else if (e.translationX > SWIPE_THRESHOLD && canDispatch) {
        runOnJS(handleSwipeRight)();
      }
      translateX.value = withSpring(0);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View style={styles.wrapper}>
      <View style={styles.backgroundActions}>
        {canDispatch && (
          <View style={[styles.action, styles.actionRight, { backgroundColor: t.primary }]}>
            <Ionicons name="rocket-outline" size={20} color="#fff" />
            <Text style={styles.actionText}>Dispatch</Text>
          </View>
        )}
        {canApprove && (
          <View style={[styles.action, styles.actionLeft, { backgroundColor: t.success }]}>
            <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />
            <Text style={styles.actionText}>Approve</Text>
          </View>
        )}
      </View>

      <GestureDetector gesture={gesture}>
        <Animated.View style={animatedStyle}>
          <TaskCard task={task} />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: 'relative' },
  backgroundActions: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: 16,
    overflow: 'hidden',
  },
  action: {
    width: 100,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
  },
  actionRight: {},
  actionLeft: { position: 'absolute', right: 0 },
  actionText: { color: '#fff', fontWeight: '700', fontSize: 12 },
});
