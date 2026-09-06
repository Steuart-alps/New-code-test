import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';

interface Site { id: number; name: string; }
interface Answer { question: string; checked: boolean; notes?: string; }
interface Submission { submittedAt: string | null; answers: Answer[]; }
interface ChecklistResponse { submission: Submission | null; defaultQuestions: Answer[]; }

const today = (): string => new Date().toISOString().slice(0, 10);

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

  const submit = useMutation({
    mutationFn: () => apiFetch(`/api/daily-checklists/${siteId}/${date}/${type}`, { method: 'POST', body: JSON.stringify({ answers }) }),
    onSuccess: async () => {
      setSubmitted(true);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: ['daily-overview'] });
      Alert.alert('Checklist submitted', `Today’s ${type.toUpperCase()} checklist has been recorded.`, [{ text: 'Done', onPress: () => router.back() }]);
    },
    onError: (error: Error) => Alert.alert('Unable to submit', error.message),
  });

  const updateAnswer = (index: number, changes: Partial<Answer>) =>
    setAnswers((current) => current.map((answer, i) => i === index ? { ...answer, ...changes } : answer));

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={[styles.hero, { backgroundColor: colors.navy }]}>
        <TouchableOpacity testID="daily-checklist-back" onPress={() => router.back()}><Feather name="arrow-left" size={22} color="#fff" /></TouchableOpacity>
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
          {submitted && <View style={[styles.notice, { backgroundColor: `${colors.success}18`, borderColor: `${colors.success}55` }]}><Feather name="check-circle" color={colors.success} size={18} /><Text style={{ color: colors.success, flex: 1 }}>This checklist has been submitted and is locked.</Text></View>}
          {answers.map((answer, index) => <View key={answer.question} style={[styles.answerCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TouchableOpacity testID={`daily-checklist-answer-${index}`} disabled={submitted} onPress={() => updateAnswer(index, { checked: !answer.checked })} style={styles.answerRow}>
              <Feather name={answer.checked ? 'check-square' : 'square'} size={22} color={answer.checked ? colors.primary : colors.mutedForeground} />
              <Text style={[styles.question, { color: colors.foreground }]}>{answer.question}</Text>
            </TouchableOpacity>
            {!submitted && <TextInput testID={`daily-checklist-note-${index}`} value={answer.notes ?? ''} onChangeText={(notes) => updateAnswer(index, { notes })} placeholder="Note (optional)" placeholderTextColor={colors.mutedForeground} style={[styles.note, { color: colors.foreground, borderTopColor: colors.border }]} />}
          </View>)}
          {!submitted && <TouchableOpacity testID="daily-checklist-submit" disabled={submit.isPending || answers.length === 0} onPress={() => submit.mutate()} style={[styles.submit, { backgroundColor: colors.navy }, submit.isPending && { opacity: 0.6 }]}>{submit.isPending ? <ActivityIndicator color="#fff" /> : <><Feather name="send" color="#fff" size={18} /><Text style={styles.submitText}>Submit {type.toUpperCase()} checklist</Text></>}</TouchableOpacity>}
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
  answerCard: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  answerRow: { flexDirection: 'row', padding: 14, gap: 12, alignItems: 'flex-start' },
  question: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 14, lineHeight: 20 },
  note: { borderTopWidth: 1, paddingHorizontal: 14, height: 42, fontFamily: 'Inter_400Regular', fontSize: 13 },
  submit: { height: 52, borderRadius: 6, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, marginTop: 6 },
  submitText: { color: '#fff', fontFamily: 'Inter_600SemiBold', fontSize: 15 },
});