/**
 * PATtrack Screen
 * Lists appliances for the selected site, allows logging a test (picked from the
 * list or by scanning its asset tag), and shows recent tests.
 * Gated behind hasService("pattrack").
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  RefreshControl,
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
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { PatTagScanner } from '@/components/PatTagScanner';

const MODULE_COLOR = '#6366f1';

interface Appliance {
  id: number;
  name: string;
  active: boolean;
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
  site_name_snapshot?: string | null;
  location_snapshot?: string | null;
  snapshot_source?: 'recorded' | 'legacy_backfill' | 'legacy_unavailable';
}

type Result = 'pass' | 'fail';
type ApplianceStatus = 'failed' | 'overdue' | 'dueSoon' | 'ok' | 'dueDateNeeded' | 'untested';

function localIsoDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function today(): string {
  return localIsoDate();
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function nextTestDefault(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return localIsoDate(d);
}

function applianceStatus(appliance: Appliance): ApplianceStatus {
  if (!appliance.last_test_date) return 'untested';
  if (appliance.last_result === 'fail') return 'failed';
  if (!appliance.next_test_date) return 'dueDateNeeded';
  const due = appliance.next_test_date.slice(0, 10);
  const todayDate = today();
  if (due < todayDate) return 'overdue';
  const inThirtyDays = new Date();
  inThirtyDays.setDate(inThirtyDays.getDate() + 30);
  return due <= localIsoDate(inThirtyDays) ? 'dueSoon' : 'ok';
}

export default function PatScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const { user, hasService } = useAuth();
  const serviceEnabled = hasService('pattrack');
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const [showForm, setShowForm] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Form state
  const [applianceId, setApplianceId] = useState<number | null>(null);
  const [result, setResult] = useState<Result>('pass');
  const [testDate, setTestDate] = useState(today());
  const [nextTestDate, setNextTestDate] = useState(nextTestDefault());
  const [testedBy, setTestedBy] = useState(user?.name ?? '');
  const [notes, setNotes] = useState('');

  const {
    data: appliances = [],
    isLoading: appliancesLoading,
    refetch: refetchAppliances,
  } = useQuery<Appliance[]>({
    queryKey: ['pat-appliances'],
    queryFn: () => apiFetch('/api/pat-track/appliances'),
    enabled: serviceEnabled,
  });

  const {
    data: tests = [],
    isLoading: testsLoading,
    refetch: refetchTests,
  } = useQuery<PatTest[]>({
    queryKey: ['pat-tests'],
    queryFn: () => apiFetch('/api/pat-track/tests'),
    enabled: serviceEnabled,
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
      setTestedBy(user?.name ?? '');
      setNotes('');
      setShowForm(false);
      Alert.alert('Logged', 'PAT test recorded successfully.');
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message || 'Something went wrong.');
    },
  });

  if (!serviceEnabled) {
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

  function handleSubmit() {
    if (applianceId === null) {
      Alert.alert('Appliance required', 'Please choose the appliance you tested.');
      return;
    }
    if (!appliances.some((appliance) => appliance.id === applianceId && appliance.active)) {
      Alert.alert('Appliance unavailable', 'Retired appliances cannot receive new PAT tests.');
      return;
    }
    if (!testedBy.trim()) {
      Alert.alert('Tester required', 'Enter the name of the person who carried out the test.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(testDate) || !/^\d{4}-\d{2}-\d{2}$/.test(nextTestDate)) {
      Alert.alert('Check dates', 'Enter the test and next due dates as YYYY-MM-DD.');
      return;
    }
    const body: Record<string, unknown> = {
      applianceId,
      testDate,
      result,
      nextTestDate: nextTestDate.trim(),
      testedBy: testedBy.trim(),
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
  const activeAppliances = appliances.filter((appliance) => appliance.active);

  function openLogForm(appliance: Appliance) {
    if (!appliance.active) return;
    setApplianceId(appliance.id);
    setResult('pass');
    setTestDate(today());
    setNextTestDate(nextTestDefault());
    setTestedBy(user?.name ?? '');
    setNotes('');
    setShowForm(true);
  }

  const statusDisplay: Record<
    ApplianceStatus,
    { label: string; color: string; icon: React.ComponentProps<typeof Feather>['name'] }
  > = {
    failed: { label: 'Failed', color: colors.destructive, icon: 'x-circle' },
    overdue: { label: 'Overdue', color: colors.destructive, icon: 'alert-circle' },
    dueSoon: { label: 'Due soon', color: colors.warning, icon: 'clock' },
    ok: { label: 'OK', color: colors.success, icon: 'check-circle' },
    dueDateNeeded: { label: 'Due date needed', color: colors.warning, icon: 'calendar' },
    untested: { label: 'Untested', color: colors.mutedForeground, icon: 'minus-circle' },
  };

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 40 }}
      bottomOffset={20}
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

      {/* Appliance status list */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Appliances</Text>
        <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
          Scan an asset tag or tap an appliance to log its latest test.
        </Text>
        {!appliancesLoading && activeAppliances.length > 0 ? (
          <TouchableOpacity
            testID="pat-scan-tag"
            style={[styles.addBtn, { backgroundColor: colors.navy }]}
            onPress={() => setShowScanner(true)}
          >
            <Feather name="maximize" size={18} color="#ffffff" />
            <Text style={styles.addBtnText}>Scan asset tag</Text>
          </TouchableOpacity>
        ) : null}
        {appliancesLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : activeAppliances.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="zap" size={22} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No active appliances found. Add or reactivate appliances on the web app first.
            </Text>
          </View>
        ) : (
          activeAppliances.map((appliance) => {
            const status = applianceStatus(appliance);
            const display = statusDisplay[status];
            return (
              <TouchableOpacity
                key={appliance.id}
                testID={`pat-appliance-${appliance.id}`}
                activeOpacity={0.75}
                style={[styles.applianceCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => openLogForm(appliance)}
              >
                <View style={[styles.statusIcon, { backgroundColor: display.color + '1a' }]}>
                  <Feather name={display.icon} size={20} color={display.color} />
                </View>
                <View style={styles.applianceBody}>
                  <Text style={[styles.applianceName, { color: colors.foreground }]}>{appliance.name}</Text>
                  <Text style={[styles.applianceMeta, { color: colors.mutedForeground }]}>
                    {[appliance.asset_tag, appliance.location, appliance.appliance_type].filter(Boolean).join(' · ') || 'No asset details'}
                  </Text>
                  <Text style={[styles.applianceDue, { color: colors.mutedForeground }]}>
                    {appliance.next_test_date ? `Next due ${formatDate(appliance.next_test_date.slice(0, 10))}` : 'No test date recorded'}
                  </Text>
                </View>
                <View style={[styles.statusBadge, { backgroundColor: display.color + '1a' }]}>
                  <Text style={[styles.statusBadgeText, { color: display.color }]}>{display.label}</Text>
                </View>
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            );
          })
        )}
      </View>

      <PatTagScanner
        visible={showScanner}
        appliances={appliances}
        onClose={() => setShowScanner(false)}
        onSelect={openLogForm}
      />

      {/* Form */}
      <Modal
        visible={showForm}
        transparent
        animationType="slide"
        onRequestClose={() => setShowForm(false)}
      >
        <View style={styles.modalOverlay}>
          <KeyboardAwareScrollViewCompat
            style={styles.modalScroll}
            contentContainerStyle={styles.modalContent}
            bottomOffset={20}
            keyboardShouldPersistTaps="handled"
          >
            <View style={[styles.formCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.formHeading}>
            <View>
              <Text style={[styles.formTitle, { color: colors.foreground }]}>Log test</Text>
              <Text style={[styles.formAppliance, { color: colors.mutedForeground }]}>
                {appliances.find((item) => item.id === applianceId)?.name}
              </Text>
            </View>
            <TouchableOpacity testID="pat-close-form" onPress={() => setShowForm(false)}>
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
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
                  testID={`pat-result-${opt.value}`}
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
              Next due date
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
              Tested by
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
              testID="pat-submit-test"
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
          </KeyboardAwareScrollViewCompat>
        </View>
      </Modal>

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
                <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>
                  {test.snapshot_source === 'recorded'
                    ? `Test location: ${[test.site_name_snapshot, test.location_snapshot].filter(Boolean).join(' · ') || 'No location recorded'}`
                    : test.snapshot_source === 'legacy_backfill'
                      ? `Backfilled location (not verified at test date): ${[test.site_name_snapshot, test.location_snapshot].filter(Boolean).join(' · ') || 'No location recorded'}`
                      : 'Historical test location unavailable'}
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
  sectionSub: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginBottom: 2,
  },
  applianceCard: {
    minHeight: 78,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  applianceBody: { flex: 1 },
  applianceName: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  applianceMeta: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
  applianceDue: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 4 },
  statusBadge: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4 },
  statusBadgeText: { fontSize: 10, fontFamily: 'Inter_600SemiBold' },
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
    width: '100%',
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalScroll: {
    flexGrow: 0,
    maxHeight: '92%',
  },
  modalContent: {
    paddingHorizontal: 12,
    paddingTop: 24,
    paddingBottom: 12,
  },
  formHeading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  formTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  formAppliance: { fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 2 },
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
