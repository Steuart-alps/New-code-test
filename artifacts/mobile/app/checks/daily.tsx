import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';
import { checkOutbox, newCheckEntryId, useCheckOutbox } from '@/lib/checkOutbox';
import { localIsoDate } from '@/components/date-stepper-logic';

interface Site { id: number; name: string; }
interface Answer { question: string; checked: boolean; notes?: string; }
interface Submission { submittedAt: string | null; answers: Answer[]; }
interface ChecklistResponse { submission: Submission | null; defaultQuestions: Answer[]; }

// Device-local calendar date: a UTC date is the wrong day around midnight.
const today = (): string => localIsoDate();
const dailyScopeKey = (siteId: number, date: string, type: 'am' | 'pm') => `daily:${siteId}:${date}:${type}`;

export default function DailyChecklistScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ type?: string }>();
  const [type, setType] = useState<'am' | 'pm'>(params.type === 'pm' ? 'pm' : 'am');
  const queryClient = useQueryClient();
  const [siteId, setSiteId] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const date = today();
  const outbox = useCheckOutbox();

  const { data: sites = [] } = useQuery<Site[]>({ queryKey: ['sites'], queryFn: () => apiFetch('/api/sites') });
  useEffect(() => {
    if (sites.length === 1 && siteId === null) setSiteId(sites[0].id);
  }, [sites, siteId]);

  const checklist = useQuery<ChecklistResponse>({
    queryKey: ['daily-checklist', siteId, date, type],
    enabled: siteId !== null,
    queryFn: () => apiFetch(`/api/daily-checklists/${siteId}/${date}/${type}`),
  });
  useEffect(() => {
    if (!checklist.data) return;
    setAnswers(checklist.data.submission?.answers ?? checklist.data.defaultQuestions);
    setSubmitted(!!checklist.data.submission?.submittedAt);
  }, [checklist.data]);

  // A submission saved on this device but not yet confirmed by the server.
  const deviceEntry = siteId === null ? undefined : outbox.entries.find((entry) =>
    entry.state !== 'sent' && entry.scopeKey === dailyScopeKey(siteId, date, type));
  const deviceAnswers = Array.isArray(deviceEntry?.body.answers) ? deviceEntry.body.answers as Answer[] : null;
  const shownAnswers = submitted ? answers : deviceAnswers ?? answers;
  const locked = submitted || !!deviceEntry;
  // A rejected copy stays visible (to retry or remove) even once the server
  // shows another submission for this checklist.
  const showDeviceEntry = !!deviceEntry && (!submitted || deviceEntry.state === 'failed');

  // Every submission is written to the device outbox first, then sent; a
  // retry after a lost response is recognised by the server (clientEntryId).
  const submit = useMutation({
    mutationFn: async () => {
      if (siteId === null) throw new Error('Choose a site first.');
      const site = sites.find((s) => s.id === siteId);
      const entry = await checkOutbox.enqueue({
        entryId: newCheckEntryId('daily'),
        kind: 'daily-checklist',
        path: `/api/daily-checklists/${siteId}/${date}/${type}`,
        scopeKey: dailyScopeKey(siteId, date, type),
        label: `${type.toUpperCase()} checklist · ${site?.name ?? `Site ${siteId}`} · ${date}`,
        body: { answers },
      });
      await checkOutbox.replay();
      return checkOutbox.getSnapshot().entries.find((row) => row.entryId === entry.entryId) ?? entry;
    },
    onSuccess: async (entry) => {
      if (entry.state === 'failed') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Checklist not accepted', entry.error ?? 'The server rejected this checklist.');
        return;
      }
      if (entry.state !== 'sent') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert(
          'Saved on this device',
          `No connection right now. Today’s ${type.toUpperCase()} checklist is saved on this device and will be sent automatically when you are back online.`,
          [{ text: 'Done', onPress: () => router.back() }],
        );
        return;
      }
      setSubmitted(true);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: ['daily-overview'] });
      Alert.alert('Checklist submitted', `Today’s ${type.toUpperCase()} checklist has been recorded.`, [{ text: 'Done', onPress: () => router.back() }]);
    },
    onError: (error: Error) => Alert.alert('Unable to submit', error.message),
  });

  const updateAnswer = (index: number, changes: Partial<Answer>) =>
    setAnswers((current) => current.map((answer, i) => i === index ? { ...answer, ...changes } : answer));

  const showError = (problem: unknown) =>
    Alert.alert('Could not update saved checklist', problem instanceof Error ? problem.message : 'Try again.');

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={[styles.hero, { backgroundColor: colors.navy }]}>
        <TouchableOpacity testID="daily-checklist-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()}><Feather name="arrow-left" size={22} color="#fff" /></TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.heroTitle}>{type === 'am' ? 'Morning' : 'Evening'} checklist</Text>
          <Text style={styles.heroSub}>{new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</Text>
        </View>
      </View>
      <View style={styles.section}>
        <View style={styles.typePicker}>
          {(['am', 'pm'] as const).map((option) => <TouchableOpacity key={option} testID={`daily-checklist-type-${option}`} onPress={() => setType(option)} style={[styles.typeButton, { backgroundColor: type === option ? colors.primary : colors.card, borderColor: type === option ? colors.primary : colors.border }]}><Text style={[styles.typeButtonText, { color: type === option ? '#fff' : colors.foreground }]}>{option.toUpperCase()} checklist</Text></TouchableOpacity>)}
        </View>
        <Text style={[styles.label, { color: colors.foreground }]}>Site</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={styles.chips}>
          {sites.map((site) => <TouchableOpacity testID={`daily-checklist-site-${site.id}`} key={site.id} onPress={() => setSiteId(site.id)} style={[styles.chip, { borderColor: siteId === site.id ? colors.primary : colors.border, backgroundColor: siteId === site.id ? `${colors.primary}18` : colors.card }]}><Text style={{ color: siteId === site.id ? colors.primary : colors.mutedForeground, fontFamily: 'Inter_500Medium' }}>{site.name}</Text></TouchableOpacity>)}
        </View></ScrollView>
        {sites.length === 0 && <Text style={{ color: colors.mutedForeground }}>No sites are available for this checklist.</Text>}
      </View>
      {siteId !== null && (checklist.isLoading ? <ActivityIndicator color={colors.primary} style={{ marginTop: 28 }} /> : (
        <View style={styles.section}>
          {checklist.isError && !deviceEntry && <View style={[styles.notice, { backgroundColor: `${colors.destructive}12`, borderColor: `${colors.destructive}55` }]}><Feather name="wifi-off" color={colors.destructive} size={18} /><Text style={{ color: colors.foreground, flex: 1 }}>{checklist.error instanceof Error ? checklist.error.message : 'The checklist could not be loaded.'} Pull back and try again when you have a connection.</Text></View>}
          {submitted && <View style={[styles.notice, { backgroundColor: `${colors.success}18`, borderColor: `${colors.success}55` }]}><Feather name="check-circle" color={colors.success} size={18} /><Text style={{ color: colors.success, flex: 1 }}>This checklist has been submitted and is locked.</Text></View>}
          {showDeviceEntry && deviceEntry && (
            <View testID={`daily-checklist-device-${deviceEntry.state}`} style={[styles.notice, styles.deviceNotice, { backgroundColor: `${colors.warning}14`, borderColor: `${colors.warning}66` }]}>
              <View style={styles.deviceRow}>
                <Feather name={deviceEntry.state === 'failed' ? 'alert-circle' : 'upload-cloud'} color={colors.warning} size={18} />
                <Text style={{ color: colors.foreground, flex: 1 }}>
                  {deviceEntry.state === 'failed'
                    ? 'Not accepted by the server — saved on this device.'
                    : 'Saved on this device — sending when you are back online.'}
                </Text>
              </View>
              {deviceEntry.error ? <Text style={{ color: colors.mutedForeground }}>{deviceEntry.error}</Text> : null}
              {deviceEntry.state === 'failed' && (
                <View style={styles.deviceActions}>
                  <TouchableOpacity testID="daily-checklist-device-retry" onPress={() => void checkOutbox.retry(deviceEntry.entryId).catch(showError)}>
                    <Text style={{ color: colors.primary, fontFamily: 'Inter_600SemiBold' }}>Retry</Text>
                  </TouchableOpacity>
                  <TouchableOpacity testID="daily-checklist-device-remove" onPress={() => Alert.alert(
                    'Remove saved device copy?',
                    'This removes the unsent checklist from this device. Anything already accepted by the server stays.',
                    [
                      { text: 'Keep', style: 'cancel' },
                      { text: 'Remove copy', style: 'destructive', onPress: () => {
                        void checkOutbox.removeFailed(deviceEntry.entryId).then(() => checklist.refetch()).catch(showError);
                      } },
                    ],
                  )}>
                    <Text style={{ color: colors.destructive, fontFamily: 'Inter_600SemiBold' }}>Remove device copy</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
          {shownAnswers.map((answer, index) => <View key={answer.question} style={[styles.answerCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TouchableOpacity testID={`daily-checklist-answer-${index}`} disabled={locked} onPress={() => updateAnswer(index, { checked: !answer.checked })} style={styles.answerRow}>
              <Feather name={answer.checked ? 'check-square' : 'square'} size={22} color={answer.checked ? colors.primary : colors.mutedForeground} />
              <Text style={[styles.question, { color: colors.foreground }]}>{answer.question}</Text>
            </TouchableOpacity>
            {!locked && <TextInput testID={`daily-checklist-note-${index}`} value={answer.notes ?? ''} onChangeText={(notes) => updateAnswer(index, { notes })} placeholder="Note (optional)" placeholderTextColor={colors.mutedForeground} style={[styles.note, { color: colors.foreground, borderTopColor: colors.border }]} />}
            {locked && !!answer.notes && <Text style={[styles.lockedNote, { color: colors.mutedForeground, borderTopColor: colors.border }]}>{answer.notes}</Text>}
          </View>)}
          {!locked && <TouchableOpacity testID="daily-checklist-submit" disabled={submit.isPending || answers.length === 0} onPress={() => submit.mutate()} style={[styles.submit, { backgroundColor: colors.navy }, submit.isPending && { opacity: 0.6 }]}>{submit.isPending ? <ActivityIndicator color="#fff" /> : <><Feather name="send" color="#fff" size={18} /><Text style={styles.submitText}>Submit {type.toUpperCase()} checklist</Text></>}</TouchableOpacity>}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: Platform.OS === 'web' ? 34 : 28 },
  hero: { paddingHorizontal: 20, paddingTop: Platform.OS === 'web' ? 83 : 20, paddingBottom: 20, flexDirection: 'row', alignItems: 'center', gap: 16 },
  heroTitle: { color: '#fff', fontSize: 20, fontFamily: 'Inter_700Bold' },
  heroSub: { color: 'rgba(255,255,255,0.65)', fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 3 },
  section: { paddingHorizontal: 16, paddingTop: 20, gap: 10 },
  label: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  typePicker: { flexDirection: 'row', gap: 8 },
  typeButton: { flex: 1, alignItems: 'center', borderWidth: 1, borderRadius: 6, paddingVertical: 10 },
  typeButtonText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  chips: { flexDirection: 'row', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  notice: { borderWidth: 1, borderRadius: 7, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 9 },
  deviceNotice: { flexDirection: 'column', alignItems: 'stretch' },
  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  deviceActions: { flexDirection: 'row', gap: 18, paddingTop: 4 },
  answerCard: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  answerRow: { flexDirection: 'row', padding: 14, gap: 12, alignItems: 'flex-start' },
  question: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 14, lineHeight: 20 },
  note: { borderTopWidth: 1, paddingHorizontal: 14, minHeight: 42, fontFamily: 'Inter_400Regular', fontSize: 13 },
  lockedNote: { borderTopWidth: 1, paddingHorizontal: 14, paddingVertical: 10, fontFamily: 'Inter_400Regular', fontSize: 13 },
  submit: { minHeight: 52, borderRadius: 6, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, marginTop: 6 },
  submitText: { color: '#fff', fontFamily: 'Inter_600SemiBold', fontSize: 15 },
});
