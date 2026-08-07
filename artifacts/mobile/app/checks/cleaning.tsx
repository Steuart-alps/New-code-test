import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';

const TEAL = '#14b8a6';

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
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function CleaningScreen() {
  const colors = useColors();
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useAuth();

  const date = today();
  const frequency = 'daily';

  // Initials used to record who completed each task. Prompted once, remembered
  // in state for the rest of the session — defaults to the logged-in user name.
  const [initials, setInitials] = useState<string>(user?.name ?? '');

  const { data: tasks = [], isLoading: tasksLoading } = useQuery<CleaningTask[]>({
    queryKey: ['kitchen-cleaning-tasks'],
    queryFn: () => apiFetch<CleaningTask[]>('/api/kitchen-cleaning/tasks'),
  });

  const dailyTasks = useMemo(
    () => tasks.filter((t) => t.frequency === 'daily'),
    [tasks],
  );

  const { data: log, isLoading: logLoading } = useQuery<CleaningLog | null>({
    queryKey: ['kitchen-cleaning-log', date, frequency],
    queryFn: () =>
      apiFetch<CleaningLog>(
        `/api/kitchen-cleaning/logs?date=${date}&frequency=${frequency}`,
      ).catch((err: Error) => {
        // A missing log for the day is expected (404) — treat as no log yet.
        if (/404/.test(err.message) || /not found/i.test(err.message)) return null;
        throw err;
      }),
  });

  // Local map of taskId -> done, seeded from the server log.
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
    // Prompt for initials once if we can (web / iOS). If prompting isn't
    // available (e.g. Android has no Alert.prompt) we proceed anyway —
    // doneBy/signedBy are optional server-side.
    const canPrompt = Platform.OS === 'web' || typeof Alert.prompt === 'function';
    if (!initials.trim() && canPrompt) {
      ensureInitials(() => apply());
      return;
    }
    apply();
  }

  const isLoading = tasksLoading || logLoading;
  const doneCount = dailyTasks.filter((t) => checked[t.id]).length;

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: 40 }}
    >
      {/* Module badge */}
      <View
        style={[
          styles.moduleBadge,
          { backgroundColor: TEAL + '1a', borderColor: TEAL + '44' },
        ]}
      >
        <Feather name="check-circle" size={14} color={TEAL} />
        <Text style={[styles.moduleBadgeText, { color: TEAL }]}>
          Cleaning schedule
        </Text>
      </View>

      {/* Summary / initials */}
      <View style={styles.summaryRow}>
        <Text style={[styles.summaryText, { color: colors.mutedForeground }]}>
          {doneCount}/{dailyTasks.length} completed today
        </Text>
        <TouchableOpacity
          style={styles.initialsBtn}
          onPress={() => ensureInitials(() => {})}
        >
          <Feather name="edit-2" size={12} color={TEAL} />
          <Text style={[styles.initialsText, { color: TEAL }]}>
            {initials.trim() ? initials.trim() : 'Set initials'}
          </Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : dailyTasks.length === 0 ? (
        <View
          style={[
            styles.empty,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Feather name="check-circle" size={32} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            No cleaning tasks
          </Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            Set up the cleaning schedule in KitchenTrack on the web app
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          {dailyTasks.map((t) => {
            const isDone = !!checked[t.id];
            return (
              <TouchableOpacity
                key={t.id}
                style={[
                  styles.taskRow,
                  {
                    backgroundColor: colors.card,
                    borderColor: isDone ? TEAL : colors.border,
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
                      backgroundColor: isDone ? TEAL : 'transparent',
                      borderColor: isDone ? TEAL : colors.border,
                    },
                  ]}
                >
                  {isDone && <Feather name="check" size={15} color="#ffffff" />}
                </View>
                <View style={styles.taskBody}>
                  <Text style={[styles.taskTitle, { color: colors.foreground }]}>
                    {t.task}
                  </Text>
                  <Text style={[styles.taskSub, { color: colors.mutedForeground }]}>
                    {t.area}
                    {t.product ? ` · ${t.product}` : ''}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      <View style={{ paddingHorizontal: 16, marginTop: 16 }}>
        <TouchableOpacity
          style={[styles.doneBtn, { borderColor: colors.border }]}
          onPress={() => router.back()}
        >
          <Text style={[styles.doneBtnText, { color: colors.mutedForeground }]}>
            Done
          </Text>
        </TouchableOpacity>
        <Text style={[styles.footerNote, { color: colors.mutedForeground }]}>
          Ticked tasks are saved instantly. Weekly and monthly schedules can be
          completed and signed off on the web app.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  moduleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    margin: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  moduleBadgeText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  summaryText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  initialsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  initialsText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  list: { paddingHorizontal: 16, gap: 8 },
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
  empty: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 32,
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
  },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  emptyText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
  },
  doneBtn: {
    height: 48,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  footerNote: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 18,
  },
});
