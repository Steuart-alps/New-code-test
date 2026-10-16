/**
 * Cleaning Schedule Screen
 * Lets staff tick off cleaning tasks during a shift.
 * Shows progress indicator and recent history.
 * Gated behind hasService("kitchentrack").
 *
 * Unsaved ticks are kept on the device per user, kitchen, frequency and period
 * (restored when the screen reopens), and draft saves and sign-offs go through
 * the device check outbox: saved on the phone first, then sent, and resent
 * automatically with the same entry ID after a lost connection, which the
 * server recognises, so a resend never applies twice.
 */
import React, { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
import { ApiError, apiFetch } from '@/lib/api';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { OutboxEntries } from '@/components/OutboxEntries';
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import { useCheckOutbox } from '@/lib/checkOutbox';
import {
  cleaningPeriodDate,
  type CleaningFrequency,
} from '@/components/cleaning-schedule-logic';
import {
  buildCleaningLogPayload,
  cleaningDraftKey,
  cleaningSyncStatus,
  discardCleaningDraft,
  hydrateCleaningDraft,
  loadCleaningDraft,
  pendingCleaningEntry,
  requestCleaningFrequencyChange,
  requestCleaningSiteChange,
  saveCleaningDraft,
  type CleaningDraftCompletion,
  type CleaningDraftLog,
  type CleaningDraftScope,
} from '@/components/cleaning-draft-logic';

const MODULE_COLOR = '#14b8a6';

interface CleaningTask {
  id: number;
  site_id?: number | null;
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
  site_id?: number | null;
  log_date: string;
  frequency: string;
  completions: CompletionItem[] | null;
  signed_by: string | null;
  submitted_at?: string | null;
  completed_count?: number;
  total_count?: number;
}

interface Site {
  id: number;
  name: string;
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

  const [frequency, setFrequency] = useState<CleaningFrequency>('daily');
  const date = cleaningPeriodDate(frequency);
  const [siteId, setSiteId] = useState<number | null>(null);

  // Initials used to record who completed each task
  const [initials, setInitials] = useState<string>(user?.name ?? '');
  const [refreshing, setRefreshing] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Storage key of the schedule whose device draft has been looked up (and
  // restored if there was one); nothing is written to the device before that.
  const [draftCheckedKey, setDraftCheckedKey] = useState<string | null>(null);
  const [restoredDraft, setRestoredDraft] = useState(false);

  const owner = useMemo(
    () => (user?.clientId ? { clientId: user.clientId, userId: user.id } : null),
    [user?.clientId, user?.id],
  );
  const scope = useMemo<CleaningDraftScope>(
    () => ({ siteId, frequency, logDate: date }),
    [siteId, frequency, date],
  );
  const draftKey = owner && siteId !== null ? cleaningDraftKey(owner, scope) : null;
  const discardDeviceDraft = (target: CleaningDraftScope) => {
    if (owner && target.siteId !== null) void discardCleaningDraft(AsyncStorage, owner, target).catch(() => {});
  };

  // Saves made on this device that the server has not confirmed yet.
  const outbox = useRecordOutbox('cleaning-log');
  const deviceEntries = useCheckOutbox().entries;
  const pending = siteId === null ? null : pendingCleaningEntry(outbox.entries, scope);
  const syncStatus = siteId === null ? { kind: 'none' as const } : cleaningSyncStatus(deviceEntries, scope);

  const {
    data: sites = [],
    isLoading: sitesLoading,
    refetch: refetchSites,
  } = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch<Site[]>('/api/sites'),
  });

  useEffect(() => {
    if (sites.length === 1 && siteId === null) {
      setSiteId(sites[0].id);
      return;
    }
    if (siteId !== null && !sites.some((site) => site.id === siteId)) {
      setSiteId(sites.length === 1 ? sites[0].id : null);
      setChecked({});
      setDoneBy({});
      setDirty(false);
    }
  }, [siteId, sites]);

  const {
    data: tasks = [],
    isLoading: tasksLoading,
    isFetching: tasksFetching,
    refetch: refetchTasks,
  } = useQuery<CleaningTask[]>({
    queryKey: ['kitchen-cleaning-tasks', siteId],
    enabled: siteId !== null,
    queryFn: () => apiFetch<CleaningTask[]>(`/api/kitchen-cleaning/tasks?siteId=${siteId}`),
  });

  const visibleTasks = useMemo(
    () => tasks.filter((t) => t.frequency === frequency),
    [frequency, tasks],
  );

  const {
    data: log,
    status: logStatus,
    isLoading: logLoading,
    isFetching: logFetching,
    refetch: refetchLog,
  } = useQuery<CleaningLog | null>({
    queryKey: ['kitchen-cleaning-log', siteId, date, frequency],
    enabled: siteId !== null,
    queryFn: () =>
      apiFetch<CleaningLog>(
        `/api/kitchen-cleaning/logs?date=${date}&frequency=${frequency}&siteId=${siteId}`,
      ).catch((err: Error) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
  });

  const {
    data: history = [],
    isLoading: historyLoading,
    refetch: refetchHistory,
  } = useQuery<CleaningLog[]>({
    queryKey: ['kitchen-cleaning-history', siteId],
    enabled: siteId !== null,
    queryFn: () => apiFetch<CleaningLog[]>(`/api/kitchen-cleaning/logs/history?siteId=${siteId}`),
  });

  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [doneBy, setDoneBy] = useState<Record<number, string>>({});

  // A save waiting on the device is newer than the server copy, so the screen
  // shows its ticks until it has been delivered.
  const pendingId = pending?.entryId;
  const savedSource = useMemo<CleaningDraftLog | null | undefined>(
    () => (pending
      ? { completions: pending.body.completions as CleaningDraftCompletion[], signed_by: pending.body.signedBy as string }
      : log),
    // The body of an entry never changes, so its ID identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingId, log],
  );

  useEffect(() => {
    const hydrated = hydrateCleaningDraft(savedSource, user?.name, dirty);
    if (!hydrated) return;
    setChecked(hydrated.checked);
    setDoneBy(hydrated.doneBy);
    setInitials(hydrated.initials);
    setDirty(false);
  }, [dirty, savedSource, user?.name]);

  // Restore unsaved ticks kept on the device once the server copy has loaded
  // (or failed to load, e.g. with no signal), so the draft is applied on top.
  const logSettled = logStatus !== 'pending';
  const serverSignedOff = !!log?.submitted_at;
  useEffect(() => {
    if (!owner || !draftKey || !logSettled || draftCheckedKey === draftKey) return;
    let cancelled = false;
    const target = scope;
    loadCleaningDraft(AsyncStorage, owner, target).then((draft) => {
      if (cancelled) return;
      setDraftCheckedKey(draftKey);
      setRestoredDraft(false);
      if (!draft) return;
      if (serverSignedOff) {
        // Signed off elsewhere meanwhile: the schedule can no longer change.
        discardDeviceDraft(target);
        Alert.alert('Already signed off', 'This schedule was signed off before your unsaved changes on this device could be saved, so they were not applied.');
        return;
      }
      setChecked(draft.checked);
      setDoneBy(draft.doneBy);
      setInitials(draft.initials);
      setDirty(true);
      setRestoredDraft(true);
    }, () => {
      if (!cancelled) setDraftCheckedKey(draftKey);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, draftKey, logSettled, draftCheckedKey, serverSignedOff]);

  // Keep unsaved ticks on the device as they are made.
  useEffect(() => {
    if (!owner || !draftKey || !dirty || draftCheckedKey !== draftKey) return;
    void saveCleaningDraft(AsyncStorage, {
      version: 1, owner, ...scope, checked, doneBy, initials, savedAt: new Date().toISOString(),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, draftKey, dirty, draftCheckedKey, checked, doneBy, initials]);

  const { mutate, isPending } = useMutation({
    mutationFn: async ({ submit }: { submit: boolean }) => {
      const staffName = initials.trim();
      if (!staffName) throw new Error('Enter your name before saving.');
      const payload = buildCleaningLogPayload({
        logDate: date,
        frequency,
        siteId,
        tasks: visibleTasks,
        checked,
        doneBy,
        staffName,
        submit,
      });
      const kitchen = sites.find((site) => site.id === siteId)?.name ?? 'Kitchen';
      const label = `Cleaning ${submit ? 'sign-off' : 'draft'} · ${kitchen} · ${frequency} · ${formatDate(date)}`;
      const outcome = await outbox.send({ ...payload }, label);
      return { outcome, saved: scope };
    },
    onSuccess: async ({ outcome, saved }, vars) => {
      if (outcome.state === 'rejected') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Not accepted', outcome.error);
        return;
      }
      // Now held by the server or the device outbox.
      discardDeviceDraft(saved);
      setRestoredDraft(false);
      if (outcome.state === 'queued') {
        setDirty(false);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert(
          'Saved on this device',
          vars.submit
            ? 'No connection right now. The sign-off is saved on this device and will be sent automatically when you are back online.'
            : 'No connection right now. Your progress is saved on this device and will be sent automatically when you are back online.',
        );
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.setQueryData(['kitchen-cleaning-log', saved.siteId, saved.logDate, saved.frequency], outcome.response as CleaningLog);
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['kitchen-cleaning-log', saved.siteId, saved.logDate, saved.frequency] });
      qc.invalidateQueries({ queryKey: ['kitchen-cleaning-history', saved.siteId] });
      Alert.alert(
        vars.submit ? 'Schedule signed off' : 'Draft saved',
        vars.submit
          ? `The ${frequency} cleaning schedule has been signed off.`
          : 'Your progress has been saved and can be continued later.',
      );
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message);
    },
  });

  function toggle(taskId: number) {
    const willBeDone = !checked[taskId];
    setChecked((current) => ({ ...current, [taskId]: willBeDone }));
    setDoneBy((current) => {
      const next = { ...current };
      if (willBeDone && initials.trim()) next[taskId] = initials.trim();
      if (!willBeDone) delete next[taskId];
      return next;
    });
    setDirty(true);
  }

  function chooseFrequency(next: CleaningFrequency) {
    const decision = requestCleaningFrequencyChange(frequency, next, dirty, isPending);
    if (decision.kind === 'ignore') return;
    const switchFrequency = () => {
      if (dirty) discardDeviceDraft(scope);
      setRestoredDraft(false);
      setChecked({});
      setDoneBy({});
      setInitials(user?.name ?? '');
      setDirty(false);
      setFrequency(decision.frequency);
    };
    if (decision.kind === 'confirm') {
      Alert.alert(
        'Discard unsaved changes?',
        'Save your draft before changing schedule frequency, or discard these changes.',
        [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: switchFrequency },
        ],
      );
      return;
    }
    switchFrequency();
  }

  function chooseSite(nextSiteId: number) {
    const decision = requestCleaningSiteChange(siteId, nextSiteId, dirty, isPending);
    if (decision.kind === 'ignore') return;
    const switchSite = () => {
      if (dirty) discardDeviceDraft(scope);
      setRestoredDraft(false);
      setChecked({});
      setDoneBy({});
      setInitials(user?.name ?? '');
      setDirty(false);
      setSiteId(decision.siteId);
    };
    if (decision.kind === 'confirm') {
      Alert.alert(
        'Discard unsaved changes?',
        'Save your draft before changing kitchen, or discard these changes.',
        [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: switchSite },
        ],
      );
      return;
    }
    switchSite();
  }

  function discardChanges() {
    Alert.alert(
      'Discard unsaved changes?',
      'The ticks you have not saved will be removed from this device.',
      [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            discardDeviceDraft(scope);
            setRestoredDraft(false);
            setDirty(false);
          },
        },
      ],
    );
  }

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([refetchSites(), refetchTasks(), refetchLog(), refetchHistory()]);
    setRefreshing(false);
  }

  const isLoading = tasksLoading || logLoading;
  // Edits wait until any unsaved ticks kept on the device have been restored.
  const draftLookup = !!draftKey && draftCheckedKey !== draftKey;
  const isBusy = sitesLoading || isLoading || tasksFetching || logFetching || refreshing || draftLookup;
  const doneCount = visibleTasks.filter((t) => checked[t.id]).length;
  const total = visibleTasks.length;
  const progress = total > 0 ? doneCount / total : 0;
  const recentHistory = history.filter((h) => h.frequency === frequency).slice(0, 7);
  // A sign-off waiting on the device locks the schedule just like a delivered one.
  const isSubmitted = !!log?.submitted_at || !!pending?.body.submittedAt;

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

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 40 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
    >
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 16 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()}>
            <Feather name="arrow-left" size={22} color="#ffffff" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={[styles.moduleBadge, { backgroundColor: MODULE_COLOR + '22' }]}>
              <Feather name="check-circle" size={14} color={MODULE_COLOR} />
              <Text style={[styles.moduleBadgeText, { color: MODULE_COLOR }]}>Cleaning</Text>
            </View>
            <Text style={styles.headerTitle}>Cleaning Schedule</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Kitchen site</Text>
        {sitesLoading ? (
          <ActivityIndicator color={colors.primary} style={{ alignSelf: 'flex-start' }} />
        ) : sites.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            No kitchens are available for your account.
          </Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.frequencyRow}>
              {sites.map((site) => (
                <TouchableOpacity
                  key={site.id}
                  testID={`cleaning-site-${site.id}`}
                  onPress={() => chooseSite(site.id)}
                  disabled={isBusy}
                  style={[
                    styles.siteChip,
                    {
                      backgroundColor: siteId === site.id ? `${MODULE_COLOR}18` : colors.card,
                      borderColor: siteId === site.id ? MODULE_COLOR : colors.border,
                    },
                  ]}
                >
                  <Text style={{ color: siteId === site.id ? MODULE_COLOR : colors.foreground, fontFamily: 'Inter_600SemiBold' }}>
                    {site.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        )}
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
              {isSubmitted && <Feather name="check-circle" size={24} color={colors.success} />}
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

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Schedule frequency</Text>
        <View style={styles.frequencyRow}>
          {(['daily', 'weekly', 'monthly'] as const).map((option) => (
            <TouchableOpacity
              key={option}
              testID={`cleaning-frequency-${option}`}
              onPress={() => chooseFrequency(option)}
              disabled={isBusy}
              style={[
                styles.frequencyButton,
                {
                  backgroundColor: frequency === option ? MODULE_COLOR : colors.card,
                  borderColor: frequency === option ? MODULE_COLOR : colors.border,
                },
              ]}
            >
              <Text style={[styles.frequencyText, { color: frequency === option ? '#ffffff' : colors.foreground }]}>
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Completed by</Text>
        <TextInput
          testID="cleaning-staff-name"
          value={initials}
          onChangeText={(value) => {
            setInitials(value);
            setDirty(true);
          }}
          editable={!isSubmitted && !isBusy}
          placeholder="Enter your name"
          placeholderTextColor={colors.mutedForeground}
          style={[styles.nameInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card }]}
        />
        {log?.submitted_at ? (
          <View style={[styles.signedNotice, { borderColor: colors.success, backgroundColor: `${colors.success}18` }]}>
            <Feather name="lock" size={16} color={colors.success} />
            <Text style={[styles.signedText, { color: colors.success }]}>Signed off by {log?.signed_by}</Text>
          </View>
        ) : null}
        {syncStatus.kind !== 'none' ? (
          <View
            testID="cleaning-sync-status"
            style={[styles.signedNotice, {
              borderColor: syncStatus.kind === 'failed' ? colors.destructive : syncStatus.kind === 'sent' ? colors.success : colors.warning,
            }]}
          >
            <Feather
              name={syncStatus.kind === 'failed' ? 'alert-triangle' : syncStatus.kind === 'sent' ? 'check' : 'upload-cloud'}
              size={16}
              color={syncStatus.kind === 'failed' ? colors.destructive : syncStatus.kind === 'sent' ? colors.success : colors.warning}
            />
            <Text style={[styles.signedText, { color: colors.foreground }]}>
              {syncStatus.kind === 'queued'
                ? `${syncStatus.signOff ? 'Sign-off' : 'Draft'} saved on this device. It will be sent automatically when you have a connection.`
                : syncStatus.kind === 'sending'
                  ? `Sending ${syncStatus.signOff ? 'sign-off' : 'draft'}…`
                  : syncStatus.kind === 'sent'
                    ? `${syncStatus.signOff ? 'Sign-off' : 'Draft'} from this device received by the server.`
                    : `${syncStatus.signOff ? 'Sign-off' : 'Draft'} not accepted: ${syncStatus.error ?? 'the server rejected it.'}`}
            </Text>
          </View>
        ) : null}
        {dirty && !isSubmitted ? (
          <View testID="cleaning-unsaved" style={styles.unsavedRow}>
            <Text style={[styles.unsavedText, { color: colors.mutedForeground }]}>
              {restoredDraft ? 'Unsaved changes restored from this device.' : 'Unsaved changes are kept on this device until you save.'}
            </Text>
            <TouchableOpacity testID="cleaning-discard-draft" accessibilityRole="button" onPress={discardChanges}>
              <Text style={[styles.unsavedText, { color: colors.destructive, fontFamily: 'Inter_600SemiBold' }]}>Discard</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      <OutboxEntries entries={outbox.entries} readError={outbox.readError} />

      {/* Task list */}
      <View style={[styles.section, { gap: 8 }]}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
          {frequency.charAt(0).toUpperCase() + frequency.slice(1)} tasks
        </Text>
        {siteId === null ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="map-pin" size={32} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Select a kitchen</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              Choose a kitchen above to view its cleaning schedule.
            </Text>
          </View>
        ) : isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : visibleTasks.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="check-circle" size={32} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No cleaning tasks</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              Set up the cleaning schedule in KitchenTrack on the web app
            </Text>
          </View>
        ) : (
          visibleTasks.map((t) => {
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
                disabled={isPending || isSubmitted || isBusy}
                testID={`cleaning-task-${t.id}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isDone, disabled: isPending || isSubmitted || isBusy }}
                accessibilityLabel={`${t.task}, ${t.area}`}
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

      {!isSubmitted && visibleTasks.length > 0 && (
        <View style={styles.actions}>
          <TouchableOpacity
            testID="cleaning-save-draft"
            disabled={isPending || isBusy || !initials.trim()}
            onPress={() => mutate({ submit: false })}
            style={[styles.secondaryAction, { borderColor: MODULE_COLOR }, (!initials.trim() || isPending || isBusy) && styles.disabled]}
          >
            <Feather name="save" size={18} color={MODULE_COLOR} />
            <Text style={[styles.secondaryActionText, { color: MODULE_COLOR }]}>Save draft</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="cleaning-sign-off"
            disabled={isPending || isBusy || !initials.trim()}
            onPress={() => mutate({ submit: true })}
            style={[styles.primaryAction, { backgroundColor: colors.navy }, (!initials.trim() || isPending || isBusy) && styles.disabled]}
          >
            {isPending ? <ActivityIndicator color="#ffffff" /> : <Feather name="check" size={18} color="#ffffff" />}
            <Text style={styles.primaryActionText}>Sign off</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Recent history */}
      {!historyLoading && recentHistory.length > 0 && (
        <View style={[styles.section, { marginTop: 8 }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent {frequency} logs</Text>
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
    </KeyboardAwareScrollViewCompat>
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
  frequencyRow: { flexDirection: 'row', gap: 8 },
  frequencyButton: { flex: 1, borderWidth: 1, borderRadius: 7, paddingVertical: 10, alignItems: 'center' },
  frequencyText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  fieldLabel: { fontSize: 13, fontFamily: 'Inter_600SemiBold', marginTop: 4 },
  nameInput: { minHeight: 48, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 15, fontFamily: 'Inter_400Regular' },
  signedNotice: { borderWidth: 1, borderRadius: 7, padding: 11, flexDirection: 'row', alignItems: 'center', gap: 8 },
  signedText: { flex: 1, fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  unsavedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  unsavedText: { flexShrink: 1, fontSize: 12, fontFamily: 'Inter_400Regular' },
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
  siteChip: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
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
  actions: { paddingHorizontal: 16, paddingTop: 20, flexDirection: 'row', gap: 10 },
  secondaryAction: { flex: 1, minHeight: 50, borderWidth: 1, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  secondaryActionText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  primaryAction: { flex: 1, minHeight: 50, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  primaryActionText: { color: '#ffffff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  disabled: { opacity: 0.5 },
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
