/**
 * PremisesTrack Screen
 * Pick a site, record a premises inspection with the same fields the web app
 * uses, and see the site's recent inspections. Configuration (inspection types,
 * edits, deletion, the printable register) stays on the web app.
 * Gated behind hasService("premisestrack").
 */
import React, { useEffect, useState } from 'react';
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
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { OutboxEntries } from '@/components/OutboxEntries';
import { AquaChoiceRow, AquaEmptyState, AquaField, AquaInput, aquaUiStyles as ui } from '@/components/aqua-track-ui';
import { isRealCalendarDate, localDateString } from '@/components/aqua-track-logic';
import type { Site } from '@/components/aqua-track-types';

const MODULE_COLOR = '#64748b';

// Labels for the default inspection types (web: pages/premises-track.tsx).
// Custom types configured on the web app are shown as entered.
const TYPE_LABELS: Record<string, string> = {
  routine: 'Routine inspection',
  hazard: 'Hazard / slip-trip-fall',
  fault: 'Maintenance fault',
  housekeeping: 'Housekeeping',
  signage: 'Signage',
};

type InspectionStatus = 'open' | 'actioned' | 'closed';
const STATUSES: { value: InspectionStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'actioned', label: 'Actioned' },
  { value: 'closed', label: 'Closed' },
];

interface PremisesInspection {
  id: number;
  siteId: number | null;
  inspectionDate: string;
  nextInspectionDate: string | null;
  inspectionType: string;
  area: string | null;
  findings: string | null;
  hazardDetails: string | null;
  actionRequired: string | null;
  actionTaken: string | null;
  status: string;
  inspectedBy: string | null;
}

interface FormOptionsResponse {
  options?: { premises_inspection_types?: string[] };
}

const typeLabel = (value: string) => TYPE_LABELS[value] ?? value;

function formatDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function PremisesTrackScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, hasService } = useAuth();
  const serviceEnabled = hasService('premisestrack');
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const [siteId, setSiteId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Form state (web InspectionDialog fields)
  const [inspectionType, setInspectionType] = useState('');
  const [inspectionDate, setInspectionDate] = useState(localDateString());
  const [nextInspectionDate, setNextInspectionDate] = useState('');
  const [area, setArea] = useState('');
  const [inspectedBy, setInspectedBy] = useState(user?.name ?? '');
  const [status, setStatus] = useState<InspectionStatus>('open');
  const [findings, setFindings] = useState('');
  const [hazardDetails, setHazardDetails] = useState('');
  const [actionRequired, setActionRequired] = useState('');
  const [actionTaken, setActionTaken] = useState('');

  const sitesQuery = useQuery<Site[]>({
    queryKey: ['sites', user?.clientId],
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

  // An account without sites records inspections without one, as on the web.
  const sitesReady = sitesQuery.isSuccess;
  const canUseSite = sitesReady && (sites.length === 0 || (siteId !== null && sites.some((site) => site.id === siteId)));

  const optionsQuery = useQuery<FormOptionsResponse>({
    queryKey: ['form-options', user?.clientId],
    queryFn: () => apiFetch('/api/form-options'),
    enabled: serviceEnabled,
  });
  const inspectionTypes = optionsQuery.data?.options?.premises_inspection_types ?? [];
  const effectiveType = inspectionTypes.includes(inspectionType) ? inspectionType : (inspectionTypes[0] ?? '');

  const listKey = ['premises-inspections', user?.clientId, siteId];
  const inspectionsQuery = useQuery<PremisesInspection[]>({
    queryKey: listKey,
    queryFn: () => apiFetch(`/api/premises-track${siteId !== null ? `?siteId=${siteId}` : ''}`),
    enabled: serviceEnabled && canUseSite,
  });

  function resetDraft() {
    setInspectionType('');
    setInspectionDate(localDateString());
    setNextInspectionDate('');
    setArea('');
    setInspectedBy(user?.name ?? '');
    setStatus('open');
    setFindings('');
    setHazardDetails('');
    setActionRequired('');
    setActionTaken('');
  }

  // Saved on the device first, then sent; resent automatically under the
  // same entry ID after a lost connection (the server never duplicates it).
  const outbox = useRecordOutbox('premises-inspection');
  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      outbox.send(body, `Premises inspection · ${typeLabel(String(body.inspectionType))} · ${String(body.inspectionDate)}`),
    onSuccess: async (outcome) => {
      if (outcome.state === 'rejected') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('Not accepted', outcome.error);
        return;
      }
      setShowForm(false);
      resetDraft();
      if (outcome.state === 'queued') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert('Saved on this device', 'No connection right now. The inspection is saved on this device and will be sent automatically when you are back online.');
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      void queryClient.invalidateQueries({ queryKey: ['premises-inspections'] });
      Alert.alert('Logged', 'Premises inspection recorded successfully.');
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Not saved', error.message || 'Something went wrong.');
    },
  });

  if (!serviceEnabled) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>PremisesTrack</Text>
        <Text style={[styles.gatedSub, { color: colors.mutedForeground }]}>
          PremisesTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  function submit() {
    if (!canUseSite) {
      Alert.alert('Select a site', 'Choose the site you inspected.');
      return;
    }
    if (!effectiveType) {
      Alert.alert('Inspection type required', 'Inspection types could not be loaded. Pull down to refresh and try again.');
      return;
    }
    if (!isRealCalendarDate(inspectionDate)) {
      Alert.alert('Check the date', 'Enter the inspection date as YYYY-MM-DD.');
      return;
    }
    if (nextInspectionDate.trim() && !isRealCalendarDate(nextInspectionDate.trim())) {
      Alert.alert('Check the next due date', 'Enter the next inspection date as YYYY-MM-DD, or leave it blank.');
      return;
    }
    mutation.mutate({
      inspectionDate,
      nextInspectionDate: nextInspectionDate.trim() || null,
      inspectionType: effectiveType,
      area: area.trim() || null,
      findings: findings.trim() || null,
      hazardDetails: hazardDetails.trim() || null,
      actionRequired: actionRequired.trim() || null,
      actionTaken: actionTaken.trim() || null,
      status,
      inspectedBy: inspectedBy.trim() || null,
      siteId,
    });
  }

  function toggleForm() {
    if (mutation.isPending) return;
    if (!showForm && !canUseSite) return;
    if (showForm) resetDraft();
    setShowForm(!showForm);
  }

  async function onRefresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sites'] }),
        queryClient.invalidateQueries({ queryKey: ['form-options'] }),
        queryClient.invalidateQueries({ queryKey: ['premises-inspections'] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  const today = localDateString();
  const recent = (inspectionsQuery.data ?? []).slice(0, 15);
  const statusColor = (value: string) =>
    value === 'closed' ? colors.success : value === 'actioned' ? colors.primary : colors.warning;
  const pending = mutation.isPending;

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 40 }}
      bottomOffset={20}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.primary} />}
    >
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 16 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()}>
            <Feather name="arrow-left" size={22} color="#ffffff" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={[styles.moduleBadge, { backgroundColor: '#ffffff22' }]}>
              <Feather name="home" size={14} color="#ffffff" />
              <Text style={[styles.moduleBadgeText, { color: '#ffffff' }]}>PremisesTrack</Text>
            </View>
            <Text style={styles.headerTitle}>Premises Inspections</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
      </View>

      <OutboxEntries entries={outbox.entries} readError={outbox.readError} />

      {/* Site */}
      {sitesQuery.isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 16 }} />
      ) : sitesQuery.isError ? (
        <View style={styles.section}>
          <AquaEmptyState
            colors={colors}
            error
            message={sitesQuery.error instanceof Error ? sitesQuery.error.message : 'Sites could not be loaded.'}
          >
            <TouchableOpacity onPress={() => void sitesQuery.refetch()}>
              <Text style={{ color: colors.primary }}>Retry loading sites</Text>
            </TouchableOpacity>
          </AquaEmptyState>
        </View>
      ) : sites.length > 0 ? (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Site</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <View style={styles.siteRow}>
              {sites.map((site) => (
                <TouchableOpacity
                  key={site.id}
                  style={[
                    styles.siteChip,
                    {
                      borderColor: siteId === site.id ? colors.primary : colors.border,
                      backgroundColor: siteId === site.id ? colors.primary + '1a' : colors.card,
                    },
                    (showForm || pending) && ui.disabled,
                  ]}
                  onPress={() => setSiteId(site.id)}
                  disabled={showForm || pending}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: siteId === site.id, disabled: showForm || pending }}
                  testID={`premises-site-${site.id}`}
                >
                  <Text style={[styles.siteChipText, { color: siteId === site.id ? colors.primary : colors.mutedForeground }]}>
                    {site.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
          {!canUseSite && (
            <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
              Choose a site before logging an inspection.
            </Text>
          )}
        </View>
      ) : null}

      {/* Log inspection */}
      <View style={styles.section}>
        <TouchableOpacity
          style={[ui.primaryButton, { backgroundColor: colors.navy }, (pending || (!showForm && !canUseSite)) && ui.disabled]}
          onPress={toggleForm}
          disabled={pending || (!showForm && !canUseSite)}
          testID="premises-toggle-form"
        >
          <Feather name={showForm ? 'x' : 'plus'} size={18} color="#ffffff" />
          <Text style={ui.primaryButtonText}>{showForm ? 'Cancel' : 'Log inspection'}</Text>
        </TouchableOpacity>

        {showForm && (
          <View style={[styles.formCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {optionsQuery.isLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginBottom: 14 }} />
            ) : inspectionTypes.length === 0 ? (
              <AquaEmptyState colors={colors} error message="Inspection types could not be loaded.">
                <TouchableOpacity onPress={() => void optionsQuery.refetch()}>
                  <Text style={{ color: colors.primary }}>Try again</Text>
                </TouchableOpacity>
              </AquaEmptyState>
            ) : (
              <AquaChoiceRow
                label="Type"
                options={inspectionTypes.map((value) => ({ value, label: typeLabel(value) }))}
                value={effectiveType}
                onChange={setInspectionType}
                colors={colors}
                testIDPrefix="premises-type"
                disabled={pending}
              />
            )}
            <View style={ui.row}>
              <View style={{ flex: 1 }}>
                <AquaField label="Inspection date">
                  <AquaInput value={inspectionDate} onChangeText={setInspectionDate} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" colors={colors} disabled={pending} testID="premises-inspection-date" />
                </AquaField>
              </View>
              <View style={{ flex: 1 }}>
                <AquaField label="Next inspection due">
                  <AquaInput value={nextInspectionDate} onChangeText={setNextInspectionDate} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" colors={colors} disabled={pending} testID="premises-next-date" />
                </AquaField>
              </View>
            </View>
            <AquaField label="Area / location">
              <AquaInput value={area} onChangeText={setArea} placeholder="e.g. Reception, stairwell, car park" colors={colors} disabled={pending} testID="premises-area" />
            </AquaField>
            <AquaField label="Inspected by">
              <AquaInput value={inspectedBy} onChangeText={setInspectedBy} placeholder="Name" colors={colors} disabled={pending} testID="premises-inspected-by" />
            </AquaField>
            <AquaChoiceRow
              label="Status"
              options={STATUSES}
              value={status}
              onChange={(value) => setStatus(value as InspectionStatus)}
              colors={colors}
              testIDPrefix="premises-status"
              disabled={pending}
            />
            <AquaField label="Findings">
              <AquaInput value={findings} onChangeText={setFindings} placeholder="What was observed during the inspection" multiline colors={colors} disabled={pending} testID="premises-findings" />
            </AquaField>
            <AquaField label="Hazard details">
              <AquaInput value={hazardDetails} onChangeText={setHazardDetails} placeholder="Describe any hazard identified (slip, trip, fall, obstruction, etc.)" multiline colors={colors} disabled={pending} testID="premises-hazard" />
            </AquaField>
            <AquaField label="Action required">
              <AquaInput value={actionRequired} onChangeText={setActionRequired} placeholder="Remedial action needed" multiline colors={colors} disabled={pending} testID="premises-action-required" />
            </AquaField>
            <AquaField label="Action taken">
              <AquaInput value={actionTaken} onChangeText={setActionTaken} placeholder="What was done in response" multiline colors={colors} disabled={pending} testID="premises-action-taken" />
            </AquaField>
            <TouchableOpacity
              style={[ui.primaryButton, { backgroundColor: colors.navy }, (pending || !canUseSite || !effectiveType) && ui.disabled]}
              onPress={submit}
              disabled={pending || !canUseSite || !effectiveType}
              testID="premises-submit"
            >
              {pending ? <ActivityIndicator color="#ffffff" /> : <Feather name="check" size={18} color="#ffffff" />}
              <Text style={ui.primaryButtonText}>{pending ? 'Saving…' : 'Log inspection'}</Text>
            </TouchableOpacity>
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Edit inspections and change inspection types on the web app.
            </Text>
          </View>
        )}
      </View>

      {/* Recent inspections */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent inspections</Text>
        {!canUseSite ? (
          sitesReady ? <AquaEmptyState colors={colors} message="Select a site to view its inspections." /> : null
        ) : inspectionsQuery.isLoading ? (
          <ActivityIndicator color={colors.primary} />
        ) : inspectionsQuery.isError ? (
          <AquaEmptyState
            colors={colors}
            error
            message={inspectionsQuery.error instanceof Error ? inspectionsQuery.error.message : 'Inspections could not be loaded.'}
          >
            <TouchableOpacity onPress={() => void inspectionsQuery.refetch()}>
              <Text style={{ color: colors.primary }}>Try again</Text>
            </TouchableOpacity>
          </AquaEmptyState>
        ) : recent.length === 0 ? (
          <AquaEmptyState colors={colors} message="No inspections recorded yet." />
        ) : (
          recent.map((inspection) => {
            const overdue = inspection.status !== 'closed'
              && !!inspection.nextInspectionDate && inspection.nextInspectionDate.slice(0, 10) < today;
            const color = statusColor(inspection.status);
            return (
              <View
                key={inspection.id}
                testID={`premises-inspection-${inspection.id}`}
                style={[ui.card, { backgroundColor: colors.card, borderColor: colors.border, marginBottom: 0 }]}
              >
                <View style={[ui.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                  <Text style={[ui.cardTitle, { color: colors.foreground }]}>{formatDate(inspection.inspectionDate)}</Text>
                  <View style={[ui.badge, { backgroundColor: MODULE_COLOR + '1a' }]}>
                    <Text style={[ui.badgeText, { color: colors.foreground }]}>{typeLabel(inspection.inspectionType)}</Text>
                  </View>
                  <View style={[ui.badge, { backgroundColor: color + '1a' }]}>
                    <Text style={[ui.badgeText, { color }]}>
                      {STATUSES.find((item) => item.value === inspection.status)?.label ?? inspection.status}
                    </Text>
                  </View>
                </View>
                {inspection.area ? (
                  <Text style={[ui.detail, { color: colors.foreground }]}>{inspection.area}</Text>
                ) : null}
                {inspection.findings ? (
                  <Text style={[ui.detail, { color: colors.mutedForeground }]} numberOfLines={2}>{inspection.findings}</Text>
                ) : null}
                {inspection.hazardDetails ? (
                  <Text style={[ui.detail, { color: colors.destructive }]} numberOfLines={2}>Hazard: {inspection.hazardDetails}</Text>
                ) : null}
                {inspection.actionRequired ? (
                  <Text style={[ui.detail, { color: colors.mutedForeground }]} numberOfLines={2}>Action required: {inspection.actionRequired}</Text>
                ) : null}
                {inspection.actionTaken ? (
                  <Text style={[ui.detail, { color: colors.mutedForeground }]} numberOfLines={2}>Action taken: {inspection.actionTaken}</Text>
                ) : null}
                {inspection.nextInspectionDate ? (
                  <Text style={[ui.detail, { color: overdue ? colors.destructive : colors.mutedForeground }]}>
                    {overdue ? 'Overdue · ' : ''}Next due {formatDate(inspection.nextInspectionDate)}
                  </Text>
                ) : null}
                {inspection.inspectedBy ? (
                  <Text style={[ui.detail, { color: colors.mutedForeground }]}>Inspected by: {inspection.inspectedBy}</Text>
                ) : null}
              </View>
            );
          })
        )}
      </View>
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
  section: { paddingHorizontal: 16, paddingTop: 16, gap: 10 },
  sectionTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  sectionSub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  siteRow: { flexDirection: 'row', gap: 8 },
  siteChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  siteChipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  formCard: { borderWidth: 1, borderRadius: 10, padding: 14, marginTop: 4 },
  hint: { fontSize: 11, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 8, lineHeight: 16 },
});
