/**
 * TreeTrack Screen
 * Pick a site, see what is due and recent inspections, and record a tree
 * inspection with the website's fields. Inspections go through the device
 * outbox (saved offline, resent without duplicates). Editing, deleting and
 * photos stay on the website. Gated behind hasService("treetrack").
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
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
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { OutboxEntries } from '@/components/OutboxEntries';
import { DateStepper } from '@/components/DateStepper';
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import { localIsoDate } from '@/components/date-stepper-logic';
import {
  TREE_CHECK_TYPES,
  TREE_CHECK_TYPE_HINTS,
  TREE_CHECK_TYPE_LABELS,
  TREE_SEVERITY_LABELS,
  buildTreeInspectionBody,
  formatTreeDate,
  treeCheckTypeLabel,
  treeDueText,
  treeObservationResult,
  type TreeActionSeverity,
  type TreeCheckType,
  type TreeDueStatus,
  type TreeInspection,
  type TreeResult,
  type TreeStatusRow,
} from '@/components/tree-track-logic';

const MODULE_COLOR = '#16a34a';

interface Site { id: number; name: string }

export default function TreeTrackScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const { user, hasService } = useAuth();
  const serviceEnabled = hasService('treetrack');
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const [siteId, setSiteId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Form state (the website's fields)
  const [checkType, setCheckType] = useState<TreeCheckType>('visual_assessment');
  const [checkDate, setCheckDate] = useState(localIsoDate());
  const [result, setResult] = useState<TreeResult | null>(null);
  const [actionSeverity, setActionSeverity] = useState<TreeActionSeverity | null>(null);
  const [treeRef, setTreeRef] = useState('');
  const [location, setLocation] = useState('');
  const [inspector, setInspector] = useState(user?.name ?? '');
  const [followUpDate, setFollowUpDate] = useState('');
  const [notes, setNotes] = useState('');

  const sitesQuery = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
    enabled: serviceEnabled,
  });
  const sites = sitesQuery.data ?? [];
  useEffect(() => {
    if (!sitesQuery.data) return;
    if (sitesQuery.data.length === 1 && siteId !== sitesQuery.data[0].id) {
      setSiteId(sitesQuery.data[0].id);
    } else if (siteId !== null && !sitesQuery.data.some((site) => site.id === siteId)) {
      setSiteId(null);
    }
  }, [siteId, sitesQuery.data]);
  // With sites, an inspection belongs to the chosen one; an account without
  // sites records inspections without one, as the website allows.
  const siteReady = sitesQuery.isSuccess && (sites.length === 0 || siteId !== null);
  const siteQuery = siteId === null ? '' : `?siteId=${siteId}`;

  const statusQuery = useQuery<TreeStatusRow[]>({
    queryKey: ['tree-status', siteId],
    queryFn: () => apiFetch(`/api/tree-track/status${siteQuery}`),
    enabled: serviceEnabled && siteReady,
  });
  const inspectionsQuery = useQuery<TreeInspection[]>({
    queryKey: ['tree-inspections', siteId],
    queryFn: () => apiFetch(`/api/tree-track${siteQuery}`),
    enabled: serviceEnabled && siteReady,
  });

  function resetForm() {
    setCheckType('visual_assessment');
    setCheckDate(localIsoDate());
    setResult(null);
    setActionSeverity(null);
    setTreeRef('');
    setLocation('');
    setInspector(user?.name ?? '');
    setFollowUpDate('');
    setNotes('');
  }

  // Saved on the device first, then sent; resent automatically under the
  // same entry ID after a lost connection (the server never duplicates it).
  const outbox = useRecordOutbox('tree-inspection');
  const { mutate, isPending } = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      outbox.send(body, `Tree inspection · ${treeCheckTypeLabel(body.checkType)} · ${String(body.checkDate)}`),
    onSuccess: async (outcome) => {
      if (outcome.state === 'rejected') {
        // Rejected data: the form keeps it so it can be corrected.
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('Not accepted', outcome.error);
        return;
      }
      resetForm();
      setShowForm(false);
      if (outcome.state === 'queued') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert('Saved on this device', 'No connection right now. The inspection is saved on this device and will be sent automatically when you are back online.');
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      void qc.invalidateQueries({ queryKey: ['tree-inspections'] });
      void qc.invalidateQueries({ queryKey: ['tree-status'] });
      Alert.alert('Logged', 'Tree inspection recorded successfully.');
    },
    onError: (err: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      // Nothing was saved (e.g. device storage failed or the account changed).
      Alert.alert('Not saved', err.message || 'Something went wrong.');
    },
  });

  if (!serviceEnabled) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>TreeTrack</Text>
        <Text style={[styles.gatedSub, { color: colors.mutedForeground }]}>
          TreeTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  function handleSubmit() {
    if (!siteReady) {
      Alert.alert('Site required', 'Choose the site where the inspection was done.');
      return;
    }
    const built = buildTreeInspectionBody({
      checkType, checkDate, result, actionSeverity, treeRef, location, inspector, followUpDate, notes, siteId,
    }, localIsoDate());
    if (!built.ok) {
      Alert.alert(built.title, built.message);
      return;
    }
    mutate(built.body);
  }

  async function onRefresh() {
    setRefreshing(true);
    try {
      await Promise.all([sitesQuery.refetch(), statusQuery.refetch(), inspectionsQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  const today = localIsoDate();
  const recent = (inspectionsQuery.data ?? []).slice(0, 15);
  const statusDisplay: Record<TreeDueStatus, { label: string; color: string; icon: React.ComponentProps<typeof Feather>['name'] }> = {
    ok: { label: 'OK', color: colors.success, icon: 'check-circle' },
    due_soon: { label: 'Due soon', color: colors.warning, icon: 'clock' },
    overdue: { label: 'Overdue', color: colors.destructive, icon: 'alert-circle' },
    never: { label: 'Never done', color: colors.mutedForeground, icon: 'minus-circle' },
  };
  const chip = (selected: boolean) => [
    styles.chip,
    {
      borderColor: selected ? colors.primary : colors.border,
      backgroundColor: selected ? colors.primary + '1a' : colors.card,
    },
  ];
  const chipText = (selected: boolean) => [styles.chipText, { color: selected ? colors.primary : colors.mutedForeground }];
  const inputStyle = [styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }];

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 40 }}
      bottomOffset={20}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.primary} />
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
              <Feather name="feather" size={14} color={MODULE_COLOR} />
              <Text style={[styles.moduleBadgeText, { color: MODULE_COLOR }]}>TreeTrack</Text>
            </View>
            <Text style={styles.headerTitle}>Tree Inspections</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
      </View>

      <OutboxEntries entries={outbox.entries} readError={outbox.readError} />

      {/* Site */}
      <View style={styles.section}>
        {sitesQuery.isLoading ? (
          <ActivityIndicator color={colors.primary} />
        ) : sitesQuery.isError ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.emptyText, { color: colors.destructive }]}>
              {sitesQuery.error instanceof Error ? sitesQuery.error.message : 'Sites could not be loaded.'}
            </Text>
            <TouchableOpacity onPress={() => void sitesQuery.refetch()}>
              <Text style={{ color: colors.primary }}>Retry loading sites</Text>
            </TouchableOpacity>
          </View>
        ) : sites.length > 0 ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Site</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View style={styles.chipRow}>
                {sites.map((site) => (
                  <TouchableOpacity
                    key={site.id}
                    testID={`tree-site-${site.id}`}
                    style={chip(siteId === site.id)}
                    onPress={() => setSiteId(site.id)}
                  >
                    <Text style={chipText(siteId === site.id)}>{site.name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
            {siteId === null && (
              <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
                Choose a site to see what is due and record an inspection.
              </Text>
            )}
          </>
        ) : null}

        <TouchableOpacity
          testID="tree-open-form"
          style={[styles.addBtn, { backgroundColor: colors.navy }, !siteReady && { opacity: 0.5 }]}
          disabled={!siteReady}
          onPress={() => { resetForm(); setShowForm(true); }}
        >
          <Feather name="plus" size={18} color="#ffffff" />
          <Text style={styles.addBtnText}>Record inspection</Text>
        </TouchableOpacity>
      </View>

      {siteReady && (
        <>
          {/* What's due */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>What&apos;s due</Text>
            {statusQuery.isLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
            ) : statusQuery.isError ? (
              <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.emptyText, { color: colors.destructive }]}>
                  {statusQuery.error instanceof Error ? statusQuery.error.message : 'Due dates could not be loaded.'}
                </Text>
              </View>
            ) : (
              (statusQuery.data ?? []).map((row) => {
                const display = statusDisplay[row.status] ?? statusDisplay.never;
                return (
                  <View
                    key={row.checkType}
                    testID={`tree-status-${row.checkType}`}
                    style={[styles.statusCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                  >
                    <View style={[styles.statusIcon, { backgroundColor: display.color + '1a' }]}>
                      <Feather name={display.icon} size={20} color={display.color} />
                    </View>
                    <View style={styles.statusBody}>
                      <Text style={[styles.statusName, { color: colors.foreground }]}>{treeCheckTypeLabel(row.checkType)}</Text>
                      <Text style={[styles.statusMeta, { color: row.status === 'never' ? colors.mutedForeground : display.color }]}>
                        {treeDueText(row, today)}
                      </Text>
                    </View>
                    <View style={[styles.statusBadge, { backgroundColor: display.color + '1a' }]}>
                      <Text style={[styles.statusBadgeText, { color: display.color }]}>{display.label}</Text>
                    </View>
                  </View>
                );
              })
            )}
          </View>

          {/* Recent inspections */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent inspections</Text>
            {inspectionsQuery.isLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
            ) : inspectionsQuery.isError ? (
              <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.emptyText, { color: colors.destructive }]}>
                  {inspectionsQuery.error instanceof Error ? inspectionsQuery.error.message : 'Inspections could not be loaded.'}
                </Text>
              </View>
            ) : recent.length === 0 ? (
              <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Feather name="feather" size={22} color={colors.mutedForeground} />
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No tree inspections recorded yet</Text>
              </View>
            ) : (
              recent.map((row) => {
                const observed = treeObservationResult(row);
                const resultColor = observed === 'pass' ? '#22c55e' : '#ef4444';
                const severity = row.actionSeverity ? TREE_SEVERITY_LABELS[row.actionSeverity] ?? row.actionSeverity : null;
                return (
                  <View
                    key={row.id}
                    testID={`tree-inspection-${row.id}`}
                    style={[styles.recordRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                  >
                    <View style={[styles.resultDot, { backgroundColor: resultColor }]} />
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <Text style={[styles.recordDate, { color: colors.foreground }]}>{formatTreeDate(row.checkDate)}</Text>
                        <View style={[styles.typeBadge, { backgroundColor: resultColor + '22' }]}>
                          <Text style={[styles.typeBadgeText, { color: resultColor }]}>{observed.toUpperCase()}</Text>
                        </View>
                        {severity && (
                          <View style={[styles.typeBadge, { backgroundColor: colors.warning + '22' }]}>
                            <Text style={[styles.typeBadgeText, { color: colors.warning }]}>{severity}</Text>
                          </View>
                        )}
                      </View>
                      <Text style={[styles.recordSub, { color: colors.foreground }]}>{treeCheckTypeLabel(row.checkType)}</Text>
                      {(row.treeRef || row.location) && (
                        <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>
                          {[row.treeRef, row.location].filter(Boolean).join(' · ')}
                        </Text>
                      )}
                      {row.inspector && (
                        <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>Inspector: {row.inspector}</Text>
                      )}
                      {row.followUpDate && (
                        <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>Follow-up: {formatTreeDate(row.followUpDate)}</Text>
                      )}
                      {row.notes && (
                        <Text style={[styles.recordSub, { color: colors.mutedForeground }]} numberOfLines={2}>{row.notes}</Text>
                      )}
                    </View>
                  </View>
                );
              })
            )}
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Edit records, add photos and manage TreeTrack on the web app.
            </Text>
          </View>
        </>
      )}

      {/* Form */}
      <Modal visible={showForm} transparent animationType="slide" onRequestClose={() => setShowForm(false)}>
        <View style={styles.modalOverlay}>
          <KeyboardAwareScrollViewCompat
            style={styles.modalScroll}
            contentContainerStyle={styles.modalContent}
            bottomOffset={20}
            keyboardShouldPersistTaps="handled"
          >
            <View style={[styles.formCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.formHeading}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.formTitle, { color: colors.foreground }]}>Record tree inspection</Text>
                  <Text style={[styles.formSub, { color: colors.mutedForeground }]}>
                    {sites.find((site) => site.id === siteId)?.name ?? 'No specific site'}
                  </Text>
                </View>
                <TouchableOpacity testID="tree-close-form" accessibilityRole="button" accessibilityLabel="Close inspection form" onPress={() => setShowForm(false)}>
                  <Feather name="x" size={22} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>

              {/* Inspection type */}
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>Inspection type</Text>
                <View style={styles.chipWrap}>
                  {TREE_CHECK_TYPES.map((value) => (
                    <TouchableOpacity key={value} testID={`tree-type-${value}`} style={chip(checkType === value)} onPress={() => setCheckType(value)}>
                      <Text style={chipText(checkType === value)}>{TREE_CHECK_TYPE_LABELS[value]}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={[styles.typeHint, { color: colors.mutedForeground }]}>{TREE_CHECK_TYPE_HINTS[checkType]}</Text>
              </View>

              {/* Date */}
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>Date</Text>
                <DateStepper value={checkDate} onChange={setCheckDate} testID="tree-check-date" />
              </View>

              {/* Result */}
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>Result</Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  {([
                    { value: 'pass' as TreeResult, label: 'Pass', color: '#22c55e' },
                    { value: 'fail' as TreeResult, label: 'Fail', color: '#ef4444' },
                  ]).map((opt) => (
                    <TouchableOpacity
                      key={opt.value}
                      testID={`tree-result-${opt.value}`}
                      accessibilityState={{ selected: result === opt.value }}
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
                <Text style={[styles.typeHint, { color: colors.mutedForeground }]}>
                  Pass — no significant concerns. Fail — concerns found.
                </Text>
              </View>

              {result === 'fail' && (
                <View style={styles.field}>
                  <Text style={[styles.label, { color: colors.foreground }]}>
                    Remediation severity <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
                  </Text>
                  <View style={styles.chipWrap}>
                    <TouchableOpacity testID="tree-severity-none" style={chip(actionSeverity === null)} onPress={() => setActionSeverity(null)}>
                      <Text style={chipText(actionSeverity === null)}>Not specified</Text>
                    </TouchableOpacity>
                    {(Object.keys(TREE_SEVERITY_LABELS) as TreeActionSeverity[]).map((value) => (
                      <TouchableOpacity key={value} testID={`tree-severity-${value}`} style={chip(actionSeverity === value)} onPress={() => setActionSeverity(value)}>
                        <Text style={chipText(actionSeverity === value)}>{TREE_SEVERITY_LABELS[value]}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}

              {/* Tree reference */}
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>
                  Tree reference / tag <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
                </Text>
                <TextInput testID="tree-ref" style={inputStyle} value={treeRef} onChangeText={setTreeRef}
                  placeholder="e.g. T1, Oak-North, Group A" placeholderTextColor={colors.mutedForeground} maxLength={300} />
              </View>

              {/* Location */}
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>
                  Location on site <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
                </Text>
                <TextInput testID="tree-location" style={inputStyle} value={location} onChangeText={setLocation}
                  placeholder="e.g. Car park perimeter, East boundary" placeholderTextColor={colors.mutedForeground} maxLength={500} />
              </View>

              {/* Inspector */}
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>
                  Inspector / arborist <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
                </Text>
                <TextInput testID="tree-inspector" style={inputStyle} value={inspector} onChangeText={setInspector}
                  placeholder="Name or company" placeholderTextColor={colors.mutedForeground} maxLength={200} />
              </View>

              {/* Follow-up date */}
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>
                  Follow-up / re-inspection date <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
                </Text>
                <TextInput testID="tree-follow-up" style={inputStyle} value={followUpDate} onChangeText={setFollowUpDate}
                  placeholder="YYYY-MM-DD" placeholderTextColor={colors.mutedForeground} keyboardType="numbers-and-punctuation" />
              </View>

              {/* Notes */}
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>
                  Observations / recommended works <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
                </Text>
                <TextInput
                  testID="tree-notes"
                  style={[...inputStyle, styles.textArea]}
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Findings, structural defects, deadwood, fungal bodies, recommended actions..."
                  placeholderTextColor={colors.mutedForeground}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                  maxLength={5000}
                />
              </View>

              {/* Submit */}
              <View style={styles.field}>
                <TouchableOpacity
                  testID="tree-submit"
                  style={[styles.submitBtn, { backgroundColor: colors.navy }, isPending && { opacity: 0.5 }]}
                  onPress={handleSubmit}
                  disabled={isPending}
                >
                  {isPending ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <>
                      <Feather name="check" size={18} color="#ffffff" />
                      <Text style={styles.submitText}>Record inspection</Text>
                    </>
                  )}
                </TouchableOpacity>
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                  Saved on this device first and sent automatically when you have signal.
                </Text>
              </View>
            </View>
          </KeyboardAwareScrollViewCompat>
        </View>
      </Modal>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  gated: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
  gatedTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', textAlign: 'center' },
  gatedSub: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 20 },
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerCenter: { alignItems: 'center', gap: 6 },
  moduleBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  moduleBadgeText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  headerTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: '#ffffff' },
  section: { paddingHorizontal: 16, paddingTop: 20, gap: 10 },
  sectionTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
  sectionSub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  chipRow: { flexDirection: 'row', gap: 8 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  chipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: 6, gap: 8 },
  addBtnText: { color: '#ffffff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  statusCard: { minHeight: 64, borderWidth: 1, borderRadius: 8, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  statusBody: { flex: 1 },
  statusName: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  statusMeta: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 3 },
  statusBadge: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4 },
  statusBadgeText: { fontSize: 10, fontFamily: 'Inter_600SemiBold' },
  formCard: { width: '100%', padding: 16, borderRadius: 8, borderWidth: 1 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalScroll: { flexGrow: 0, maxHeight: '92%' },
  modalContent: { paddingHorizontal: 12, paddingTop: 24, paddingBottom: 12 },
  formHeading: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18, gap: 12 },
  formTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  formSub: { fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 2 },
  field: { marginBottom: 18 },
  label: { fontSize: 13, fontFamily: 'Inter_600SemiBold', marginBottom: 8 },
  typeHint: { fontSize: 12, fontFamily: 'Inter_400Regular', fontStyle: 'italic', marginTop: 8, lineHeight: 17 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: 6, paddingHorizontal: 14, fontSize: 15, fontFamily: 'Inter_400Regular' },
  textArea: { minHeight: 88, paddingTop: 12 },
  resultBtn: { flex: 1, paddingVertical: 12, borderRadius: 6, borderWidth: 1.5, alignItems: 'center' },
  resultBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  submitBtn: { minHeight: 52, borderRadius: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  submitText: { color: '#ffffff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  hint: { fontSize: 11, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 8, lineHeight: 16 },
  emptyCard: { borderWidth: 1, borderRadius: 8, padding: 24, alignItems: 'center', gap: 8 },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  recordRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderWidth: 1, borderRadius: 8, padding: 14 },
  resultDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4, flexShrink: 0 },
  recordDate: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  recordSub: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  typeBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  typeBadgeText: { fontSize: 11, fontFamily: 'Inter_500Medium' },
});
