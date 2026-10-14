import React from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import {
  canMarkDone,
  isViewer,
  taskDetail,
  taskStatusLabel,
  tasksPath,
  todayTasks,
  type TaskItem,
  type TasksResponse,
} from '@/components/task-list-logic';

/**
 * Today's staff tasks (the web's "My tasks today") with "Mark done".
 * Viewers see the business's tasks for today without any action.
 */
export function TodayTasks() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const viewer = isViewer(user?.role);

  const tasks = useQuery<TasksResponse>({
    queryKey: ['tasks', user?.clientId, viewer ? 'all' : 'mine'],
    queryFn: () => apiFetch(tasksPath(user?.role)),
    enabled: !!user,
  });

  const complete = useMutation({
    mutationFn: (task: TaskItem) => apiFetch(`/api/tasks/${task.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ date: task.occurrenceDate }),
    }),
    onSuccess: async () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: async (err: Error & { status?: number }) => {
      // Someone else already ticked it: show the current state.
      if (err.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ['tasks'] });
        Alert.alert('Already updated', err.message);
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Not marked done', err.status ? err.message : 'No connection. Try again when you are back online.');
    },
  });

  // An API without staff tasks (or no access) hides the section.
  if (tasks.isError) return null;
  const list = todayTasks(tasks.data);

  return (
    <View style={styles.section} testID="today-tasks">
      <Text style={[styles.sectionTitle, { color: colors.foreground }]} accessibilityRole="header">
        {viewer ? 'Tasks today' : 'My tasks today'}
      </Text>
      {tasks.isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
      ) : list.length === 0 ? (
        <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="check-circle" size={20} color={colors.success} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            {viewer ? 'No tasks are due today' : 'No tasks for you today'}
          </Text>
        </View>
      ) : (
        list.map((task) => {
          const done = !!task.completion;
          const pending = complete.isPending && complete.variables?.id === task.id;
          return (
            <View
              key={`${task.id}:${task.occurrenceDate}`}
              testID={`task-${task.id}`}
              style={[styles.card, { backgroundColor: colors.card, borderColor: task.overdue && !done ? colors.destructive + '66' : colors.border }]}
            >
              <View style={styles.cardBody}>
                <Text style={[styles.title, { color: colors.foreground }, done && styles.doneTitle]}>{task.title}</Text>
                <Text style={[styles.meta, { color: colors.mutedForeground }]}>{taskDetail(task, viewer)}</Text>
                {task.instruction ? (
                  <Text style={[styles.instruction, { color: colors.foreground }]}>{task.instruction}</Text>
                ) : null}
                <Text
                  style={[styles.status, { color: done ? colors.success : task.overdue ? colors.destructive : colors.mutedForeground }]}
                >
                  {taskStatusLabel(task)}
                </Text>
              </View>
              {canMarkDone(task, user?.role) ? (
                <TouchableOpacity
                  testID={`task-done-${task.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Mark ${task.title} done`}
                  disabled={complete.isPending}
                  onPress={() => complete.mutate(task)}
                  style={[styles.doneButton, { backgroundColor: colors.navy }, complete.isPending && { opacity: 0.6 }]}
                >
                  {pending ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.doneButtonText}>Mark done</Text>}
                </TouchableOpacity>
              ) : done ? (
                <Feather name="check-circle" size={22} color={colors.success} accessibilityLabel="Done" />
              ) : null}
            </View>
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 16, paddingTop: 20 },
  sectionTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', marginBottom: 12 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 8, padding: 14, marginBottom: 10 },
  cardBody: { flex: 1, gap: 3 },
  title: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  doneTitle: { textDecorationLine: 'line-through' },
  meta: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  instruction: { fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 2 },
  status: { fontSize: 12, fontFamily: 'Inter_500Medium', marginTop: 2 },
  doneButton: { minHeight: 40, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  doneButtonText: { color: '#ffffff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  emptyCard: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 8, padding: 16 },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular' },
});
