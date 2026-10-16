import React, { useState } from 'react';
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { OutboxEntries } from './OutboxEntries';
import { AquaEmptyState, AquaField, AquaInput, aquaUiStyles as styles } from './aqua-track-ui';
import {
  AnswerToggle,
  KitchenNotice,
  SubmittedBadge,
  fetchOptional,
  kitchenExtrasStyles as kx,
} from './kitchen-extras-ui';
import {
  HOUSE_RULES,
  REVIEW_QUESTIONS,
  WEEKLY_QUESTION_COUNT,
  addDays,
  buildWeeklyReviewPayload,
  displayDate,
  localDate,
  pendingEntryFor,
  weekCommencing,
  weeklyAnsweredCount,
  weeklyAttentionAnswers,
  type Answer,
  type WeeklyReviewSummary,
} from './kitchen-extras-logic';

const ANSWERS = [
  { value: 'yes' as const, label: 'Yes', tone: 'good' as const },
  { value: 'no' as const, label: 'No', tone: 'bad' as const },
  { value: 'na' as const, label: 'N/A', tone: 'neutral' as const },
];
// "Has any issue been recorded 3 or more times?": yes is the bad answer.
const RECURRING_ANSWERS = [
  { value: 'yes' as const, label: 'Yes', tone: 'bad' as const },
  { value: 'no' as const, label: 'No', tone: 'good' as const },
  { value: 'na' as const, label: 'N/A', tone: 'neutral' as const },
];

/**
 * Weekly management review (website KitchenTrack "Weekly Review" tab): the
 * CookSafe house rules, deviations, review questions and manager sign-off,
 * submitted through the device outbox. A review already started or
 * submitted for the week is edited on the website.
 */
export function KitchenWeeklyReview() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const currentWeek = weekCommencing(localDate());
  const [week, setWeek] = useState(currentWeek);
  const [checks, setChecks] = useState<Record<string, Answer | undefined>>({});
  const [deviations, setDeviations] = useState<{ rule: string; action: string }[]>([]);
  const [issuesThreeTimes, setIssuesThreeTimes] = useState<Answer | null>(null);
  const [actionTaken, setActionTaken] = useState('');
  const [managerSignature, setManagerSignature] = useState('');

  const historyQuery = useQuery<WeeklyReviewSummary[]>({
    queryKey: ['kitchen-weekly-reviews', user?.clientId],
    queryFn: () => apiFetch('/api/kitchen-weekly/weekly'),
  });
  const existingQuery = useQuery<WeeklyReviewSummary | null>({
    queryKey: ['kitchen-weekly-reviews', user?.clientId, 'by-date', week],
    queryFn: () => fetchOptional(`/api/kitchen-weekly/weekly/by-date/${week}`),
  });

  const reset = () => {
    setChecks({});
    setDeviations([]);
    setIssuesThreeTimes(null);
    setActionTaken('');
    setManagerSignature('');
  };

  const outbox = useRecordOutbox('kitchen-weekly');
  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      outbox.send(payload, `Weekly review · w/c ${displayDate(String(payload.weekCommencing))}`),
    onSuccess: async (outcome) => {
      if (outcome.state === 'rejected') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('Unable to submit weekly review', outcome.error);
        void queryClient.invalidateQueries({ queryKey: ['kitchen-weekly-reviews'] });
        return;
      }
      reset();
      if (outcome.state === 'queued') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert('Saved on this device', 'No connection right now. The weekly review is saved on this device and will be sent automatically when you are back online.');
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      void queryClient.invalidateQueries({ queryKey: ['kitchen-weekly-reviews'] });
      Alert.alert('Submitted', 'Weekly review recorded.');
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Unable to submit weekly review', error.message);
    },
  });

  const pending = mutation.isPending;
  const existing = existingQuery.data;
  const waiting = pendingEntryFor(outbox.entries, 'weekCommencing', week);
  const blocked = !!existing || !!waiting;
  const attentionAnswers = weeklyAttentionAnswers(checks);
  const hasDeviation = deviations.some((row) => row.rule.trim() || row.action.trim());

  function submit() {
    if (existingQuery.isLoading) return;
    const built = buildWeeklyReviewPayload(
      { weekCommencing: week, checks, deviations, issuesThreeTimes, actionTaken, managerSignature },
      localDate(),
      new Date().toISOString(),
    );
    if (!built.ok) {
      Alert.alert(built.title, built.message);
      return;
    }
    mutation.mutate(built.payload);
  }

  const setAnswer = (key: string) => (value: Answer | null) =>
    setChecks((current) => ({ ...current, [key]: value ?? undefined }));
  const question = (q: { key: string; label: string; sublabel?: string }) => (
    <View key={q.key} style={[kx.question, { borderTopColor: colors.border }]}>
      <Text style={[kx.questionLabel, { color: colors.foreground }]}>{q.label}</Text>
      {q.sublabel ? <Text style={[kx.questionSub, { color: colors.mutedForeground }]}>{q.sublabel}</Text> : null}
      <AnswerToggle options={ANSWERS} value={checks[q.key]} onChange={setAnswer(q.key)} disabled={pending} testIDPrefix={`kitchen-weekly-${q.key}`} />
    </View>
  );

  return (
    <View>
      <OutboxEntries entries={outbox.entries} readError={outbox.readError} />

      <AquaField label="Week commencing (Monday)">
        <View style={[styles.row, { alignItems: 'center', borderWidth: 1, borderRadius: 6, minHeight: 52, borderColor: colors.border, backgroundColor: colors.card }]}>
          <TouchableOpacity
            style={{ width: 48, alignItems: 'center' }}
            onPress={() => setWeek(addDays(week, -7))}
            disabled={pending}
            accessibilityLabel="Previous week"
            testID="kitchen-weekly-previous"
          >
            <Feather name="chevron-left" size={20} color={colors.primary} />
          </TouchableOpacity>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]} testID="kitchen-weekly-week">
              {week === currentWeek ? 'This week' : `w/c ${displayDate(week)}`}
            </Text>
            <Text style={[styles.detail, { color: colors.mutedForeground, marginTop: 1 }]}>{displayDate(week)}</Text>
          </View>
          <TouchableOpacity
            style={[{ width: 48, alignItems: 'center' }, week >= currentWeek && { opacity: 0.3 }]}
            onPress={() => setWeek(addDays(week, 7))}
            disabled={pending || week >= currentWeek}
            accessibilityLabel="Next week"
            testID="kitchen-weekly-next"
          >
            <Feather name="chevron-right" size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </AquaField>

      {existingQuery.isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginVertical: 12 }} />
      ) : existing ? (
        <KitchenNotice icon={existing.submitted_at ? 'check-circle' : 'edit-3'} tone={existing.submitted_at ? 'success' : 'warning'} testID="kitchen-weekly-existing">
          {existing.submitted_at
            ? `The review for the week commencing ${displayDate(week)} was submitted${existing.manager_signature ? ` by ${existing.manager_signature}` : ''}. Changes are made on the website.`
            : `A draft review for the week commencing ${displayDate(week)} was started on the website. Finish and submit it there.`}
        </KitchenNotice>
      ) : waiting ? (
        <KitchenNotice icon="upload-cloud" tone="warning" testID="kitchen-weekly-waiting">
          The review for the week commencing {displayDate(week)} is saved on this device and waiting to send.
        </KitchenNotice>
      ) : existingQuery.isError ? (
        <KitchenNotice icon="wifi-off" tone="info">
          Could not check for an existing review for this week. You can still submit; if one already exists the website keeps it and this one is not accepted.
        </KitchenNotice>
      ) : null}

      {!blocked && !existingQuery.isLoading && (
        <View>
          <Text style={[kx.sectionTitle, { color: colors.foreground }]}>House rules review</Text>
          <Text style={[kx.sectionHint, { color: colors.mutedForeground }]}>
            Has each area followed the house rules this week? Answer Yes / No / N/A for each.
          </Text>
          {HOUSE_RULES.map(question)}

          <Text style={[kx.sectionTitle, { color: colors.foreground, marginTop: 16 }]}>House rules deviations observed</Text>
          <Text style={[kx.sectionHint, { color: colors.mutedForeground }]}>
            If any answer is “No”, record the deviation and the corrective action taken.
          </Text>
          {attentionAnswers.length > 0 && !hasDeviation ? (
            <KitchenNotice icon="alert-triangle" tone="warning" testID="kitchen-weekly-deviation-warning">
              {attentionAnswers.join(', ')} need attention: please record the deviation and action taken below.
            </KitchenNotice>
          ) : null}
          {deviations.map((row, index) => (
            <View key={index} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <AquaField label="House rule area / deviation observed">
                <AquaInput
                  value={row.rule}
                  onChangeText={(rule) => setDeviations((rows) => rows.map((r, i) => i === index ? { ...r, rule } : r))}
                  colors={colors}
                  disabled={pending}
                  testID={`kitchen-weekly-deviation-rule-${index}`}
                />
              </AquaField>
              <AquaField label="Corrective action taken">
                <AquaInput
                  value={row.action}
                  onChangeText={(action) => setDeviations((rows) => rows.map((r, i) => i === index ? { ...r, action } : r))}
                  colors={colors}
                  disabled={pending}
                  multiline
                />
              </AquaField>
              <TouchableOpacity
                onPress={() => setDeviations((rows) => rows.filter((_, i) => i !== index))}
                disabled={pending}
                accessibilityRole="button"
                style={kx.linkButton}
              >
                <Feather name="trash-2" size={14} color={colors.destructive} />
                <Text style={[kx.linkText, { color: colors.destructive, fontSize: 13 }]}>Remove row</Text>
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity
            style={kx.linkButton}
            onPress={() => setDeviations((rows) => [...rows, { rule: '', action: '' }])}
            disabled={pending}
            accessibilityRole="button"
            testID="kitchen-weekly-add-deviation"
          >
            <Feather name="plus" size={16} color={colors.primary} />
            <Text style={[kx.linkText, { color: colors.primary }]}>Add deviation</Text>
          </TouchableOpacity>

          <Text style={[kx.sectionTitle, { color: colors.foreground, marginTop: 16 }]}>Management review questions</Text>
          <Text style={[kx.sectionHint, { color: colors.mutedForeground }]}>
            Allergens, suppliers, complaints, training and ongoing records.
          </Text>
          {REVIEW_QUESTIONS.map(question)}

          <Text style={[kx.sectionTitle, { color: colors.foreground, marginTop: 16 }]}>Additional information</Text>
          <View style={[kx.question, { borderTopColor: colors.border }]}>
            <Text style={[kx.questionLabel, { color: colors.foreground }]}>Has any issue been recorded 3 or more times?</Text>
            <AnswerToggle options={RECURRING_ANSWERS} value={issuesThreeTimes} onChange={setIssuesThreeTimes} disabled={pending} testIDPrefix="kitchen-weekly-issuesThreeTimes" />
          </View>
          <AquaField label="What action has been taken to rectify any recurring issues?">
            <AquaInput value={actionTaken} onChangeText={setActionTaken} placeholder="Describe actions taken to resolve any recurring issues…" multiline colors={colors} disabled={pending} />
          </AquaField>

          <Text style={[kx.sectionTitle, { color: colors.foreground, marginTop: 8 }]}>Manager / proprietor sign-off</Text>
          <AquaField label="Manager / proprietor name (signature)">
            <AquaInput value={managerSignature} onChangeText={setManagerSignature} placeholder="Type your name to sign" colors={colors} disabled={pending} testID="kitchen-weekly-signature" />
          </AquaField>
          <Text style={[styles.detail, { color: colors.mutedForeground, marginBottom: 10 }]} testID="kitchen-weekly-answered">
            {weeklyAnsweredCount(checks)} of {WEEKLY_QUESTION_COUNT} questions answered
          </Text>
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.navy }, pending && styles.disabled]}
            onPress={submit}
            disabled={pending}
            testID="kitchen-weekly-submit"
          >
            {pending ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name="check-circle" size={18} color={colors.primaryForeground} />}
            <Text style={styles.primaryButtonText}>{pending ? 'Submitting…' : 'Submit & sign'}</Text>
          </TouchableOpacity>
        </View>
      )}

      <Text style={[kx.sectionTitle, { color: colors.foreground, marginTop: 20 }]}>Recent reviews</Text>
      {historyQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
        historyQuery.isError ? (
          <AquaEmptyState colors={colors} error message={historyQuery.error instanceof Error ? historyQuery.error.message : 'Weekly reviews could not be loaded.'}>
            <TouchableOpacity onPress={() => void historyQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
          </AquaEmptyState>
        ) : historyQuery.data?.length ? historyQuery.data.slice(0, 12).map((row) => (
          <TouchableOpacity
            key={row.id}
            style={[kx.historyRow, { borderTopColor: colors.border }]}
            onPress={() => setWeek(row.week_commencing.slice(0, 10))}
            disabled={pending}
            testID={`kitchen-weekly-history-${row.id}`}
          >
            <Text style={[kx.historyDate, { color: colors.foreground }]}>w/c {displayDate(row.week_commencing)}</Text>
            <SubmittedBadge submitted={!!row.submitted_at} colors={colors} />
          </TouchableOpacity>
        )) : <AquaEmptyState colors={colors} message="No reviews yet." />}
    </View>
  );
}
