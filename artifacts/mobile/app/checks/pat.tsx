/**
 * PATtrack Screen
 * Lists appliances for the selected site, allows logging a test, and shows recent tests.
 * Gated behind hasService("pattrack").
 */
import React, { useState } from 'react';
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
import { apiFetch } from '@/lib/api';

const MODULE_COLOR = '#6366f1';

interface Appliance {
  id: number;
  name: string;
  appliance_type?: string | null;
  asset_tag?: string | null;
  location?: string | null;
  last_test_date?: string | null;
  last_result?: string | null;
  next_test_date?: string | null;
}

interface PatTest {
  id: number;
  appliance_id: number;
  appliance_name: string;
  appliance_type: string | null;
  asset_tag: string | null;
  test_date: string;
  result: 'pass' | 'fail';
  tested_by: string | null;
  next_test_date: string | null;
  notes: string | null;
}

type Result = 'pass' | 'fail';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function nextTestDefault(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export default function PatScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const { hasService } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const [showForm, setShowForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Form state
  const [applianceId, setApplianceId] = useState<number | null>(null);
  const [result, setResult] = useState<Result>('pass');
  const [testDate, setTestDate] = useState(today());
  const [nextTestDate, setNextTestDate] = useState(nextTestDefault());
  const [testedBy, setTestedBy] = useState('');
  const [notes, setNotes] = useState('');

  // Service gate
  if (!hasService('pattrack')) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>PATtrack</Text>
        <Text style={[styles.gatedSub, { color: colors.mutedForeground }]}>
          PATtrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  const {
    data: appliances = [],
    isLoading: appliancesLoading,
    refetch: refetchAppliances,
  } = useQuery<Appliance[]>({
    queryKey: ['pat-appliances'],
    queryFn: () => apiFetch('/api/pat-track/appliances'),
  });

  const {
    data: tests = [],
    isLoading: testsLoading,
    refetch: refetchTests,
  } = useQuery<PatTest[]>({
    queryKey: ['pat-tests'],
    queryFn: () => apiFetch('/api/pat-track/tests'),
  });

  const { mutate, isPending } = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/pat-track/tests', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['pat-tests'] });
      qc.invalidateQueries({ queryKey: ['pat-appliances'] });
      // Reset form
      setApplianceId(null);
      setResult('pass');
      setTestDate(today());
      setNextTestDate(nextTestDefault());
      setTestedBy('');
      setNotes('');
      setShowForm(false);
      Alert.alert('Logged', 'PAT test recorded successfully.');
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message || 'Something went wrong.');
    },
  });

  function handleSubmit() {
    if (applianceId === null) {
      Alert.alert('Appliance required', 'Please choose the appliance you tested.');
      return;
    }
    const body: Record<string, unknown> = {
      applianceId,
      testDate,
      result,
      ...(nextTestDate.trim() ? { nextTestDate: nextTestDate.trim() } : {}),
      ...(testedBy.trim() ? { testedBy: testedBy.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    mutate(body);
  }

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([refetchAppliances(), refetchTests()]);
    setRefreshing(false);
  }

  const recentTests = [...tests].slice(0, 15);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 40 }}
      keyboardShouldPersistTaps="handled"
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
              <Feather name="zap" size={14} color={MODULE_COLOR} />
              <Text style={[styles.moduleBadgeText, { color: MODULE_COLOR }]}>PATtrack</Text>
            </View>
            <Text style={styles.headerTitle}>PAT Testing</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
      </View>

      {/* Log button */}
      <View style={styles.section}>
        <TouchableOpacity
          style={[styles.addBtn, { backgroundColor: colors.navy }]}
          onPress={() => setShowForm((v) => !v)}
        >
          <Feather name={showForm ? 'x' : 'plus'} size={18} color="#ffffff" />
          <Text style={styles.addBtnText}>{showForm ? 'Cancel' : 'Log PAT test'}</Text>
        </TouchableOpacity>
      </View>

      {/* Form */}
      {showForm && (
        <View style={styles.formCard}>
          {/* Appliance picker */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Appliance</Text>
            {appliancesLoading ? (
              <ActivityIndicator color={colors.mutedForeground} style={{ alignSelf: 'flex-start' }} />
            ) : appliances.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No appliances found. Add appliances on the web app first.
              </Text>
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {appliances.map((a) => {
                  const selected = applianceId === a.id;
                  return (
                    <TouchableOpacity
                      key={a.id}
                      style={[
                        styles.chip,
                        {
                          borderColor: selected ? colors.primary : colors.border,
                          backgroundColor: selected ? colors.primary + '1a' : colors.card,
                        },
                      ]}
                      onPress={() => setApplianceId(a.id)}
                    >
                      <Text style={[styles.chipText, { color: selected ? colors.primary : colors.mutedForeground }]}>
                        {a.name}{a.asset_tag ? ` (${a.asset_tag})` : ''}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>

          {/* Result */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Result</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {([
                { value: 'pass' as Result, label: 'Pass', color: '#22c55e' },
                { value: 'fail' as Result, label: 'Fail', color: '#ef4444' },
              ]).map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={[
                    styles.resultBtn,
                    {
                      borderColor: result === opt.value ? opt.color : colors.border,
                      backgroundColor: result === opt.value ? opt.color + '22' : colors.card,
                    },
                  ]}
                  onPress={() => setResult(opt.value)}
                >
                  <Text style={[styles.resultBtnText, { color: result === opt.value ? opt.color : colors.mutedForeground }]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Test date */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Test date</Text>
            <TextInput
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              value={testDate}
              onChangeText={setTestDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          {/* Next test date */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>
              Next test date <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
            </Text>
            <TextInput
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              value={nextTestDate}
              onChangeText={setNextTestDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          {/* Tested by */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>
              Tested by <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
            </Text>
            <TextInput
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              value={testedBy}
              onChangeText={setTestedBy}
              placeholder="Name of tester"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          {/* Notes */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>
              Notes <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
            </Text>
            <TextInput
              style={[styles.input, styles.textArea, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Any observations..."
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          {/* Submit */}
          <View style={styles.field}>
            <TouchableOpacity
              style={[
                styles.submitBtn,
                { backgroundColor: colors.navy },
                (isPending || applianceId === null) && { opacity: 0.5 },
              ]}
              onPress={handleSubmit}
              disabled={isPending || applianceId === null}
            >
              {isPending ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <>
                  <Feather name="check" size={18} color="#ffffff" />
                  <Text style={styles.submitText}>Log PAT test</Text>
                </>
              )}
            </TouchableOpacity>
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Test records are linked to the appliance. Manage appliances on the web app.
            </Text>
          </View>
        </View>
      )}

      {/* Recent tests */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent tests</Text>
        {testsLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : recentTests.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="zap" size={22} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No tests recorded yet</Text>
          </View>
        ) : (
          recentTests.map((test) => (
            <View
              key={test.id}
              style={[styles.recordRow, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View
                style={[
                  styles.resultDot,
                  { backgroundColor: test.result === 'pass' ? '#22c55e' : '#ef4444' },
                ]}
              />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Text style={[styles.recordDate, { color: colors.foreground }]}>
                    {formatDate(test.test_date)}
                  </Text>
                  <View
                    style={[
                      styles.typeBadge,
                      {
                        backgroundColor:
                          test.result === 'pass' ? '#22c55e22' : '#ef444422',
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.typeBadgeText,
                        { color: test.result === 'pass' ? '#22c55e' : '#ef4444' },
                      ]}
                    >
                      {test.result.toUpperCase()}
                    </Text>
                  </View>
                </View>
                <Text style={[styles.recordSub, { color: colors.foreground }]}>
                  {test.appliance_name}
                  {test.asset_tag ? ` · ${test.asset_tag}` : ''}
                </Text>
                {test.tested_by && (
                  <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>
                    Tested by: {test.tested_by}
                  </Text>
                )}
                {test.next_test_date && (
                  <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>
                    Next: {formatDate(test.next_test_date)}
                  </Text>
                )}
                {test.notes && (
                  <Text style={[styles.recordSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {test.notes}
                  </Text>
                )}
              </View>
            </View>
          ))
        )}
      </View>
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
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 6,
    gap: 8,
  },
  addBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  formCard: {
    marginHorizontal: 16,
    marginTop: 4,
    paddingTop: 4,
  },
  field: {
    marginBottom: 18,
  },
  label: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
  input: {
    height: 46,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  textArea: { height: 88, paddingTop: 12 },
  resultBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
  },
  resultBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  submitBtn: {
    height: 52,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitText: {
    color: '#ffffff',
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
  hint: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 16,
  },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
  },
  resultDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 4,
    flexShrink: 0,
  },
  recordDate: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  recordSub: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  typeBadgeText: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
  },
});
