/**
 * Cleaning Schedule Screen
 * Lets staff tick off daily cleaning tasks during a shift.
 * Shows progress indicator and recent history.
 * Gated behind hasService("kitchentrack").
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';

const MODULE_COLOR = '#14b8a6';

interface CleaningTask {
  id: number;
  area: string;
  task: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  method: string | null;
  product: string | null;
  responsible: string | null;
}

interface CompletionItem {
  taskId?: number;
  taskArea?: string;
  taskName: string;
  done: boolean;
  doneBy?: string;
  notes?: string;
}

interface CleaningLog {
  id: number;
  log_date: string;
  frequency: string;
  completions: CompletionItem[] | null;
  signed_by: string | null;
  completed_count?: number;
  total_count?: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export default function CleaningScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const { user, hasService } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const date = today();
  const frequency = 'daily';

  // Initials used to record who completed each task
  const [initials, setInitials] = useState<string>(user?.name ?? '');
  const [refreshing, setRefreshing] = useState(false);

  // Service gate
  if (!hasService('kitchentrack')) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>Cleaning Schedule</Text>
        <Text style={[styles.gatedSub, { color: colors.mutedForeground }]}>
          KitchenTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  const {
    data: tasks = [],
    isLoading: tasksLoading,
    refetch: refetchTasks,
  } = useQuery<CleaningTask[]>({
    queryKey: ['kitchen-cleaning-tasks'],
    queryFn: () => apiFetch<CleaningTask[]>('/api/kitchen-cleaning/tasks'),
  });

  const dailyTasks = useMemo(
    () => tasks.filter((t) => t.frequency === 'daily'),
    [tasks],
  );

  const {
    data: log,
    isLoading: logLoading,
    refetch: refetchLog,
  } = useQuery<CleaningLog | null>({
    queryKey: ['kitchen-cleaning-log', date, frequency],
    queryFn: () =>
      apiFetch<CleaningLog>(
        `/api/kitchen-cleaning/logs?date=${date}&frequency=${frequency}`,
      ).catch((err: Error) => {
        if (/404/.test(err.message) || /not found/i.test(err.message)) return null;
        throw err;
      }),
  });

  const {
    data: history = [],
    isLoading: historyLoading,
    refetch: refetchHistory,
  } = useQuery<CleaningLog[]>({
    queryKey: ['kitchen-cleaning-history'],
    queryFn: () => apiFetch<CleaningLog[]>('/api/kitchen-cleaning/logs/history'),
  });

  // Local map of taskId -> done, seeded from the server log
  const [checked, setChecked] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (log?.completions) {
      const next: Record<number, boolean> = {};
      for (const c of log.completions) {
        if (typeof c.taskId === 'number') next[c.taskId] = !!c.done;
      }
      setChecked(next);
    }
  }, [log]);

  const { mutate, isPending } = useMutation({
    mutationFn: (nextChecked: Record<number, boolean>) => {
      const completions: CompletionItem[] = dailyTasks.map((t) => ({
        taskId: t.id,
        taskArea: t.area,
        taskName: t.task,
        done: !!nextChecked[t.id],
        ...(nextChecked[t.id] && initials ? { doneBy: initials } : {}),
      }));
      return apiFetch('/api/kitchen-cleaning/logs', {
        method: 'POST',
        body: JSON.stringify({
          logDate: date,
          frequency,
          completions,
          signedBy: initials || null,
        }),
      });
    },
    onSuccess: async (_data, vars) => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['kitchen-cleaning-log', date, frequency] });
      qc.invalidateQueries({ queryKey: ['kitchen-cleaning-history'] });
      setChecked(vars);
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message);
    },
  });

  function ensureInitials(afterSet: (value: string) => void) {
    if (initials.trim()) {
      afterSet(initials.trim());
      return;
    }
    if (Platform.OS === 'web') {
      const entered =
        typeof window !== 'undefined'
          ? window.prompt('Enter your initials to record who completed the task')
          : '';
      const value = (entered ?? '').trim();
      if (!value) return;
      setInitials(value);
      afterSet(value);
      return;
    }
    Alert.prompt?.(
      'Your initials',
      'Enter your initials to record who completed the task',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: (value?: string) => {
            const v = (value ?? '').trim();
            if (!v) return;
            setInitials(v);
            afterSet(v);
          },
        },
      ],
      'plain-text',
      initials,
    );
  }

  function toggle(taskId: number) {
    const apply = () => {
      const next = { ...checked, [taskId]: !checked[taskId] };
      setChecked(next);
      mutate(next);
    };
    const canPrompt = Platform.OS === 'web' || typeof Alert.prompt === 'function';
    if (!initials.trim() && canPrompt) {
      ensureInitials(() => apply());
      return;
    }
    apply();
  }

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([refetchTasks(), refetchLog(), refetchHistory()]);
    setRefreshing(false);
  }

  const isLoading = tasksLoading || logLoading;
  const doneCount = dailyTasks.filter((t) => checked[t.id]).length;
  const total = dailyTasks.length;
  const progress = total > 0 ? doneCount / total : 0;
  const recentHistory = history.filter((h) => h.frequency === 'daily').slice(0, 7);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 40 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
    >
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 16 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()}>
            <Feather name="arrow-left" size={22} color="#ffffff" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={[styles.moduleBadge, { backgroundColor: MODULE_COLOR + '22' }]}>
              <Feather name="check-circle" size={14} color={MODULE_COLOR} />
              <Text style={[styles.moduleBadgeText, { color: MODULE_COLOR }]}>Cleaning</Text>
            </View>
            <Text style={styles.headerTitle}>Today&apos;s Cleaning Tasks</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
      </View>

      {/* Progress card */}
      <View style={styles.section}>
        <View style={[styles.progressCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.progressHeader}>
            <View>
              <Text style={[styles.progressTitle, { color: colors.foreground }]}>
                {formatDate(date)}
              </Text>
              <Text style={[styles.progressSub, { color: colors.mutedForeground }]}>
                {doneCount} of {total} tasks completed
              </Text>
            </View>
            <TouchableOpacity
              style={styles.initialsBtn}
              onPress={() => ensureInitials(() => {})}
            >
              <Feather name="edit-2" size={12} color={MODULE_COLOR} />
              <Text style={[styles.initialsText, { color: MODULE_COLOR }]}>
                {initials.trim() ? initials.trim() : 'Set name'}
              </Text>
            </TouchableOpacity>
          </View>
          {/* Progress bar */}
          <View style={[styles.progressBarBg, { backgroundColor: colors.border }]}>
            <View
              style={[
                styles.progressBarFill,
                {
                  backgroundColor: progress === 1 ? '#22c55e' : MODULE_COLOR,
                  width: `${Math.round(progress * 100)}%` as any,
                },
              ]}
            />
          </View>
          <Text style={[styles.progressPct, { color: progress === 1 ? '#22c55e' : MODULE_COLOR }]}>
            {Math.round(progress * 100)}%
            {progress === 1 ? ' — All done! ✓' : ' complete'}
          </Text>
        </View>
      </View>

      {/* Task list */}
      <View style={[styles.section, { gap: 8 }]}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Daily tasks</Text>
        {isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : dailyTasks.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="check-circle" size={32} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No cleaning tasks</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              Set up the cleaning schedule in KitchenTrack on the web app
            </Text>
          </View>
        ) : (
          dailyTasks.map((t) => {
            const isDone = !!checked[t.id];
            return (
              <TouchableOpacity
                key={t.id}
                style={[
                  styles.taskRow,
                  {
                    backgroundColor: colors.card,
                    borderColor: isDone ? MODULE_COLOR : colors.border,
                  },
                ]}
                activeOpacity={0.7}
                onPress={() => toggle(t.id)}
                disabled={isPending}
              >
                <View
                  style={[
                    styles.checkbox,
                    {
                      backgroundColor: isDone ? MODULE_COLOR : 'transparent',
                      borderColor: isDone ? MODULE_COLOR : colors.border,
                    },
                  ]}
                >
                  {isDone && <Feather name="check" size={15} color="#ffffff" />}
                </View>
                <View style={styles.taskBody}>
                  <Text style={[styles.taskTitle, { color: colors.foreground }]}>{t.task}</Text>
                  <Text style={[styles.taskSub, { color: colors.mutedForeground }]}>
                    {t.area}
                    {t.product ? ` · ${t.product}` : ''}
                    {t.method ? ` · ${t.method}` : ''}
                  </Text>
                </View>
                {isDone && (
                  <Feather name="check-circle" size={18} color={MODULE_COLOR} />
                )}
              </TouchableOpacity>
            );
          })
        )}
      </View>

      <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
        <Text style={[styles.footerNote, { color: colors.mutedForeground }]}>
          Ticked tasks are saved instantly. Pull down to refresh. Weekly and monthly schedules can be signed off on the web app.
        </Text>
      </View>

      {/* Recent history */}
      {!historyLoading && recentHistory.length > 0 && (
        <View style={[styles.section, { marginTop: 8 }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent daily logs</Text>
          {recentHistory.map((h) => {
            const done = h.completed_count ?? 0;
            const tot = h.total_count ?? 0;
            const pct = tot > 0 ? Math.round((done / tot) * 100) : 0;
            const isComplete = done === tot && tot > 0;
            return (
              <View
                key={h.id}
                style={[styles.historyRow, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <Feather
                  name={isComplete ? 'check-circle' : 'circle'}
                  size={18}
                  color={isComplete ? '#22c55e' : colors.mutedForeground}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.historyDate, { color: colors.foreground }]}>
                    {formatDate(h.log_date)}
                  </Text>
                  <Text style={[styles.historySub, { color: colors.mutedForeground }]}>
                    {done}/{tot} tasks · {pct}%
                    {h.signed_by ? ` · ${h.signed_by}` : ''}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  gated: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  gatedTitle: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
  },
  gatedSub: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerCenter: {
    alignItems: 'center',
    gap: 6,
  },
  moduleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  moduleBadgeText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    color: '#ffffff',
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 20,
    gap: 10,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 2,
  },
  progressCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    gap: 12,
  },
  progressHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  progressTitle: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 2,
  },
  progressSub: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  initialsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  initialsText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  progressBarBg: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: 8,
    borderRadius: 4,
    minWidth: 4,
  },
  progressPct: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    textAlign: 'right',
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    gap: 12,
  },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  taskBody: { flex: 1 },
  taskTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
  taskSub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 32,
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  emptyText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
  },
  footerNote: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 18,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
  },
  historyDate: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  historySub: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
});
