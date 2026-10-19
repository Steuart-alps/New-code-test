/**
 * Tasks for managers: the website's "All tasks" tab (pages/tasks.tsx) on the
 * phone. List and filter every task, create one (saved on this phone and sent
 * automatically when there is no signal: the API recognises a resend by its
 * entry ID), and edit, reassign, archive or restore a task (these change the
 * live task, so they need a connection). Staff mark their own tasks done on
 * Today. There is no delete on the website either: archive keeps the history.
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { OutboxEntries } from '@/components/OutboxEntries';
import { AquaChoiceRow, AquaEmptyState, AquaField, AquaInput, aquaUiStyles as ui } from '@/components/aqua-track-ui';
import { isManagerRole } from '@/components/manage-items';
import { onlineActionMessage } from '@/components/outbox-status-logic';
import { localIsoDate } from '@/components/date-stepper-logic';
import {
  ALL_TASKS_PATH,
  ASSIGNEES_PATH,
  DEFAULT_FILTERS,
  DUE_FILTERS,
  RECURRENCE_OPTIONS,
  STATUS_FILTERS,
  addDays,
  assigneeFilterOptions,
  buildTaskPayload,
  describeRecurrence,
  draftFromTask,
  filterTasks,
  formatDay,
  isCalendarDay,
  moduleOptions,
  newTaskDraft,
  taskCreateLabel,
  taskDetailLine,
  taskStatus,
  type ManagedTask,
  type ManagedTasksResponse,
  type TaskAssignee,
  type TaskDraft,
  type TaskFilters,
  type TaskPayload,
  type TaskSite,
} from '@/components/manage-tasks-logic';

const EDIT_NEEDS_CONNECTION =
  'Changing a task needs an internet connection. Nothing was changed — your edits are still here, try again when you have signal.';
const ARCHIVE_NEEDS_CONNECTION =
  'Archiving or restoring a task needs an internet connection. Nothing was changed — try again when you have signal.';

export default function ManageTasksScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, hasService } = useAuth();
  const manager = isManagerRole(user?.role);
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_FILTERS);
  const [refreshing, setRefreshing] = useState(false);

  const tasksQuery = useQuery<ManagedTasksResponse>({
    queryKey: ['tasks', user?.clientId, 'all'],
    queryFn: () => apiFetch(ALL_TASKS_PATH),
    enabled: manager,
  });
  const sitesQuery = useQuery<TaskSite[]>({
    queryKey: ['sites', user?.clientId],
    queryFn: () => apiFetch('/api/sites'),
    enabled: manager,
  });
  const assigneesQuery = useQuery<TaskAssignee[]>({
    queryKey: ['tasks-assignees', user?.clientId],
    queryFn: () => apiFetch(ASSIGNEES_PATH),
    enabled: manager,
  });
  const today = tasksQuery.data?.today ?? localIsoDate();

  const outbox = useRecordOutbox('task-create');
  const save = useMutation({
    mutationFn: async ({ id, payload }: { id?: number; payload: TaskPayload }) => {
      if (id) {
        await apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        return 'updated' as const;
      }
      const result = await outbox.send(payload, taskCreateLabel(payload));
      if (result.state === 'rejected') throw new Error(result.error);
      return result.state;
    },
    onSuccess: async (state) => {
      setDraft(null);
      if (state === 'queued') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert('Saved on this phone', 'No connection right now. The new task is saved on this phone and will be sent automatically when you are back online.');
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      Alert.alert(state === 'updated' ? 'Task updated' : 'Task created');
    },
    onError: (err: Error, variables) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Could not save task', variables.id ? onlineActionMessage(err, 'Please try again.', EDIT_NEEDS_CONNECTION) : err.message);
    },
  });

  const archive = useMutation({
    mutationFn: ({ task, active }: { task: ManagedTask; active: boolean }) =>
      apiFetch(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ active }) }),
    onSuccess: async () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Could not update task', onlineActionMessage(err, 'Please try again.', ARCHIVE_NEEDS_CONNECTION));
    },
  });

  function confirmArchive(task: ManagedTask) {
    if (!task.active) {
      archive.mutate({ task, active: true });
      return;
    }
    Alert.alert('Archive this task?', `${task.title} stops appearing on staff lists. Its history is kept and you can restore it.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Archive', style: 'destructive', onPress: () => archive.mutate({ task, active: false }) },
    ]);
  }

  function submit() {
    if (!draft) return;
    const built = buildTaskPayload(draft);
    if (!built.ok) {
      Alert.alert(built.title, built.message);
      return;
    }
    save.mutate({ id: draft.id, payload: built.payload });
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks-assignees'] }),
        queryClient.invalidateQueries({ queryKey: ['sites'] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  const header = (
    <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
      <TouchableOpacity testID="manage-tasks-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
        <Feather name="arrow-left" size={22} color="#ffffff" />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Tasks</Text>
      <Text style={styles.headerSub}>Routine jobs for your team, one-off or repeating. {formatDay(today)}</Text>
    </View>
  );

  if (!manager) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {header}
        <View style={styles.content}>
          <AquaEmptyState colors={colors} message="Only managers can set and assign tasks. Your own tasks are on Today." />
        </View>
      </View>
    );
  }

  const sites = sitesQuery.data ?? [];
  const assignees = assigneesQuery.data ?? [];
  const allTasks = tasksQuery.data?.tasks ?? [];
  const shown = filterTasks(allTasks, filters, today);
  const pending = save.isPending;
  const modules = moduleOptions(hasService);

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: 40 }}
      bottomOffset={20}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.primary} />}
    >
      {header}
      <View style={styles.content}>
        <OutboxEntries entries={outbox.entries} readError={outbox.readError} />

        {!draft && (
          <TouchableOpacity
            testID="manage-tasks-new"
            accessibilityRole="button"
            style={[ui.primaryButton, { backgroundColor: colors.navy }]}
            onPress={() => setDraft(newTaskDraft(today, sites))}
          >
            <Feather name="plus" size={18} color="#ffffff" />
            <Text style={ui.primaryButtonText}>New task</Text>
          </TouchableOpacity>
        )}

        {draft && (
          <View
            testID="manage-tasks-form"
            accessibilityLabel={draft.id ? 'Edit task' : 'New task'}
            style={[styles.formCard, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text style={[styles.formTitle, { color: colors.foreground }]} accessibilityRole="header">
              {draft.id ? 'Edit task' : 'New task'}
            </Text>
            {draft.id ? (
              <Text style={[ui.detail, { color: colors.mutedForeground, marginTop: 0, marginBottom: 12 }]}>
                Changes to a task need a connection.
              </Text>
            ) : null}
            <AquaField label="Task">
              <AquaInput value={draft.title} onChangeText={(title) => setDraft({ ...draft, title })} placeholder="e.g. Kitchen opening checklist" colors={colors} disabled={pending} testID="manage-tasks-title" />
            </AquaField>
            <AquaField label="Instructions (optional)">
              <AquaInput value={draft.instruction} onChangeText={(instruction) => setDraft({ ...draft, instruction })} multiline colors={colors} disabled={pending} testID="manage-tasks-instruction" />
            </AquaField>
            <AquaChoiceRow
              label="Assign to"
              options={[
                { value: 'role:client_staff', label: 'All staff' },
                { value: 'role:managers', label: 'All managers' },
                ...assignees.map((a) => ({ value: `user:${a.id}`, label: a.name })),
              ]}
              value={draft.assignee}
              onChange={(assignee) => setDraft({ ...draft, assignee })}
              colors={colors}
              testIDPrefix="manage-tasks-assignee"
              disabled={pending}
            />
            <AquaChoiceRow
              label="Site"
              options={[{ value: '', label: 'All sites' }, ...sites.map((s) => ({ value: String(s.id), label: s.name }))]}
              value={draft.siteId}
              onChange={(siteId) => setDraft({ ...draft, siteId })}
              colors={colors}
              testIDPrefix="manage-tasks-site"
              disabled={pending}
            />
            <AquaChoiceRow
              label="Repeats"
              options={RECURRENCE_OPTIONS}
              value={draft.recurrence}
              onChange={(recurrence) => setDraft({ ...draft, recurrence: recurrence as TaskDraft['recurrence'] })}
              colors={colors}
              testIDPrefix="manage-tasks-recurrence"
              disabled={pending}
            />
            <AquaField label={draft.recurrence === 'once' ? 'Due date' : 'Starting'}>
              <View style={styles.dateRow}>
                <TouchableOpacity
                  testID="manage-tasks-date-previous"
                  accessibilityRole="button"
                  accessibilityLabel="Previous day"
                  disabled={pending || !isCalendarDay(draft.startsOn)}
                  onPress={() => setDraft({ ...draft, startsOn: addDays(draft.startsOn, -1) })}
                  style={[styles.dateStep, { borderColor: colors.border, backgroundColor: colors.card }]}
                >
                  <Feather name="chevron-left" size={20} color={colors.primary} />
                </TouchableOpacity>
                <View style={{ flex: 1 }}>
                  <AquaInput value={draft.startsOn} onChangeText={(startsOn) => setDraft({ ...draft, startsOn })} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" colors={colors} disabled={pending} testID="manage-tasks-date" />
                </View>
                <TouchableOpacity
                  testID="manage-tasks-date-next"
                  accessibilityRole="button"
                  accessibilityLabel="Next day"
                  disabled={pending || !isCalendarDay(draft.startsOn)}
                  onPress={() => setDraft({ ...draft, startsOn: addDays(draft.startsOn, 1) })}
                  style={[styles.dateStep, { borderColor: colors.border, backgroundColor: colors.card }]}
                >
                  <Feather name="chevron-right" size={20} color={colors.primary} />
                </TouchableOpacity>
              </View>
              {isCalendarDay(draft.startsOn) ? (
                <Text style={[ui.detail, { color: colors.mutedForeground }]}>
                  {draft.recurrence === 'once' ? formatDay(draft.startsOn) : `${describeRecurrence(draft)}, from ${formatDay(draft.startsOn)}`}
                </Text>
              ) : null}
            </AquaField>
            <AquaChoiceRow
              label="Link to a module (optional)"
              options={[{ value: '', label: 'No link' }, ...modules.map((m) => ({ value: m.key, label: m.label }))]}
              value={draft.module}
              onChange={(module) => setDraft({ ...draft, module })}
              colors={colors}
              testIDPrefix="manage-tasks-module"
              disabled={pending}
            />
            <Text style={[ui.detail, { color: colors.mutedForeground, marginTop: -8, marginBottom: 14 }]}>
              Staff get a link straight to that module to record the check.
            </Text>
            <View style={styles.formActions}>
              <TouchableOpacity
                testID="manage-tasks-cancel"
                accessibilityRole="button"
                disabled={pending}
                onPress={() => setDraft(null)}
                style={[styles.secondaryButton, { borderColor: colors.border }, pending && ui.disabled]}
              >
                <Text style={[styles.secondaryButtonText, { color: colors.foreground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="manage-tasks-save"
                accessibilityRole="button"
                disabled={pending || !draft.title.trim() || !draft.startsOn}
                onPress={submit}
                style={[ui.primaryButton, { flex: 1, backgroundColor: colors.navy }, (pending || !draft.title.trim() || !draft.startsOn) && ui.disabled]}
              >
                {pending ? <ActivityIndicator color="#ffffff" /> : <Feather name="check" size={18} color="#ffffff" />}
                <Text style={ui.primaryButtonText}>{pending ? 'Saving…' : 'Save task'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View>
          <AquaChoiceRow
            label="Assigned to"
            options={assigneeFilterOptions(allTasks, assignees)}
            value={filters.assignee}
            onChange={(assignee) => setFilters({ ...filters, assignee })}
            colors={colors}
            testIDPrefix="manage-tasks-filter-assignee"
          />
          <AquaChoiceRow
            label="Site"
            options={[
              { value: 'all', label: 'Any site' },
              { value: 'none', label: 'All sites tasks' },
              ...sites.map((s) => ({ value: String(s.id), label: s.name })),
            ]}
            value={filters.site}
            onChange={(site) => setFilters({ ...filters, site })}
            colors={colors}
            testIDPrefix="manage-tasks-filter-site"
          />
          <AquaChoiceRow
            label="Status"
            options={STATUS_FILTERS}
            value={filters.status}
            onChange={(status) => setFilters({ ...filters, status: status as TaskFilters['status'] })}
            colors={colors}
            testIDPrefix="manage-tasks-filter-status"
          />
          <AquaChoiceRow
            label="Due"
            options={DUE_FILTERS}
            value={filters.due}
            onChange={(due) => setFilters({ ...filters, due: due as TaskFilters['due'] })}
            colors={colors}
            testIDPrefix="manage-tasks-filter-due"
          />
        </View>

        {tasksQuery.isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : tasksQuery.isError ? (
          <AquaEmptyState
            colors={colors}
            error
            message={onlineActionMessage(tasksQuery.error, 'Could not load tasks', 'Loading tasks needs a connection. Pull down to try again when you have signal.')}
          >
            <TouchableOpacity accessibilityRole="button" onPress={() => void tasksQuery.refetch()}>
              <Text style={{ color: colors.primary }}>Try again</Text>
            </TouchableOpacity>
          </AquaEmptyState>
        ) : (
          <>
            <Text testID="manage-tasks-count" style={[styles.count, { color: colors.mutedForeground }]}>
              {`${shown.length} task${shown.length === 1 ? '' : 's'}. Status shown for today.`}
            </Text>
            {allTasks.length === 0 ? (
              <AquaEmptyState colors={colors} message="No tasks yet. Create one, such as “Kitchen opening checklist” every day or “Weekly fire alarm test”." />
            ) : shown.length === 0 ? (
              <AquaEmptyState colors={colors} message="No tasks match these filters." />
            ) : shown.map((task) => {
              const status = taskStatus(task);
              const statusColor = status.tone === 'done' ? colors.success : status.tone === 'overdue' ? colors.destructive
                : status.tone === 'due' ? colors.warning : colors.mutedForeground;
              const busy = archive.isPending && archive.variables?.task.id === task.id;
              return (
                <View
                  key={task.id}
                  testID={`manage-task-${task.id}`}
                  style={[ui.card, { backgroundColor: colors.card, borderColor: colors.border }, !task.active && { opacity: 0.6 }]}
                >
                  <View style={styles.taskRow}>
                    <Feather
                      name={status.tone === 'done' ? 'check-circle' : status.tone === 'overdue' ? 'alert-triangle' : 'circle'}
                      size={20}
                      color={statusColor}
                      accessibilityLabel={status.tone === 'done' ? 'Done today' : status.tone === 'overdue' ? 'Overdue' : undefined}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={[ui.cardTitle, { color: colors.foreground }]}>
                        {task.title}{!task.active ? <Text style={{ color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }}>  Archived</Text> : null}
                      </Text>
                      <Text style={[ui.detail, { color: colors.mutedForeground }]}>{taskDetailLine(task)}</Text>
                      {task.instruction ? <Text style={[ui.detail, { color: colors.foreground }]} numberOfLines={3}>{task.instruction}</Text> : null}
                      <Text style={[ui.detail, { color: statusColor, fontFamily: 'Inter_500Medium' }]}>{status.label}</Text>
                    </View>
                  </View>
                  {task.canManage ? (
                    <View style={styles.taskActions}>
                      <TouchableOpacity
                        testID={`manage-task-edit-${task.id}`}
                        accessibilityRole="button"
                        accessibilityLabel={`Edit ${task.title}`}
                        disabled={pending || busy}
                        onPress={() => setDraft(draftFromTask(task))}
                        style={[styles.actionButton, { borderColor: colors.border }]}
                      >
                        <Feather name="edit-2" size={15} color={colors.primary} />
                        <Text style={[styles.actionText, { color: colors.primary }]}>Edit or reassign</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        testID={`manage-task-archive-${task.id}`}
                        accessibilityRole="button"
                        accessibilityLabel={task.active ? `Archive ${task.title}` : `Restore ${task.title}`}
                        disabled={busy}
                        onPress={() => confirmArchive(task)}
                        style={[styles.actionButton, { borderColor: colors.border }, busy && ui.disabled]}
                      >
                        {busy ? <ActivityIndicator color={colors.mutedForeground} /> : (
                          <Feather name={task.active ? 'archive' : 'rotate-ccw'} size={15} color={colors.mutedForeground} />
                        )}
                        <Text style={[styles.actionText, { color: colors.mutedForeground }]}>{task.active ? 'Archive' : 'Restore'}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </>
        )}
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  back: { marginBottom: 10, alignSelf: 'flex-start', padding: 2 },
  headerTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: '#ffffff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter_400Regular' },
  content: { padding: 16, gap: 12 },
  formCard: { borderWidth: 1, borderRadius: 10, padding: 14 },
  formTitle: { fontSize: 17, fontFamily: 'Inter_600SemiBold', marginBottom: 12 },
  formActions: { flexDirection: 'row', gap: 10 },
  secondaryButton: { minHeight: 48, borderWidth: 1, borderRadius: 8, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dateStep: { width: 46, height: 46, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  count: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  taskRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  taskActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, marginLeft: 30 },
  actionButton: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8 },
  actionText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
});
