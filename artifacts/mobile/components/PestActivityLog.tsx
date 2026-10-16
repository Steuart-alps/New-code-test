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
import { AquaChoiceRow, AquaEmptyState, AquaField, AquaInput, aquaUiStyles as styles } from './aqua-track-ui';
import {
  DEFAULT_PEST_EVIDENCE_TYPES,
  DEFAULT_PEST_TYPES,
  PEST_SEVERITIES,
  buildPestActivityPayload,
  evidenceLabel,
  localDate,
  pestOptions,
  pestRecordsForSite,
  pestTypeLabel,
  severityLabel,
  type PestActivity,
} from './pest-track-logic';

interface FormOptionsResponse {
  options?: { pest_types?: string[]; pest_evidence_types?: string[] };
}

/**
 * Pest sightings and other activity for the chosen site: the website's
 * "Log pest activity" form, sent through the device outbox.
 */
export function PestActivityLog({
  siteId,
  canUseSite,
  onFormOpenChange,
}: {
  siteId: number | null;
  canUseSite: boolean;
  onFormOpenChange: (open: boolean) => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [showForm, setShowForm] = useState(false);
  const [recordedDate, setRecordedDate] = useState(localDate());
  const [pestType, setPestType] = useState('rodent');
  const [evidenceType, setEvidenceType] = useState('live_sighting');
  const [severity, setSeverity] = useState('low');
  const [location, setLocation] = useState('');
  const [actionTaken, setActionTaken] = useState('');
  const [recordedBy, setRecordedBy] = useState(user?.name ?? '');
  const [resolved, setResolved] = useState(false);
  const [notes, setNotes] = useState('');

  const queryKey = ['pest-activity', user?.clientId];
  const activityQuery = useQuery<PestActivity[]>({
    queryKey,
    queryFn: () => apiFetch('/api/pest-track/activity'),
  });
  const { data: formOptions } = useQuery<FormOptionsResponse>({
    queryKey: ['form-options', user?.clientId],
    queryFn: () => apiFetch('/api/form-options'),
  });
  const pestTypes = pestOptions(formOptions?.options?.pest_types, DEFAULT_PEST_TYPES);
  const evidenceTypes = pestOptions(formOptions?.options?.pest_evidence_types, DEFAULT_PEST_EVIDENCE_TYPES);
  const effectivePestType = pestTypes.includes(pestType) ? pestType : pestTypes[0];
  const effectiveEvidenceType = evidenceTypes.includes(evidenceType) ? evidenceType : evidenceTypes[0];

  function resetDraft() {
    setRecordedDate(localDate());
    setPestType('rodent');
    setEvidenceType('live_sighting');
    setSeverity('low');
    setLocation('');
    setActionTaken('');
    setRecordedBy(user?.name ?? '');
    setResolved(false);
    setNotes('');
  }

  // Saved on the device first, then sent; resent automatically under the
  // same entry ID after a lost connection (the server never duplicates it).
  const outbox = useRecordOutbox('pest-activity');
  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      outbox.send(payload, `Pest activity · ${pestTypeLabel(String(payload.pestType))} · ${String(payload.recordedDate)}`),
    onSuccess: async (outcome) => {
      if (outcome.state === 'rejected') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('Unable to log pest activity', outcome.error);
        return;
      }
      setShowForm(false);
      onFormOpenChange(false);
      resetDraft();
      if (outcome.state === 'queued') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert('Saved on this device', 'No connection right now. The pest activity is saved on this device and will be sent automatically when you are back online.');
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const record = outcome.response as PestActivity | undefined;
      if (record?.id) queryClient.setQueryData<PestActivity[]>(queryKey, (current) => current ? [record, ...current] : [record]);
      void queryClient.invalidateQueries({ queryKey: ['pest-activity'] });
      Alert.alert('Logged', 'Pest activity recorded successfully.');
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Unable to log pest activity', error.message);
    },
  });

  function submit() {
    if (!canUseSite) {
      Alert.alert('Select a site', 'Choose a site before logging pest activity.');
      return;
    }
    const built = buildPestActivityPayload({
      recordedDate, pestType: effectivePestType, evidenceType: effectiveEvidenceType, severity,
      location, actionTaken, recordedBy, resolved, notes,
    }, siteId);
    if (!built.ok) {
      Alert.alert(built.title, built.message);
      return;
    }
    mutation.mutate(built.payload);
  }

  function toggleForm() {
    if (mutation.isPending) return;
    if (!showForm && !canUseSite) return;
    const next = !showForm;
    setShowForm(next);
    onFormOpenChange(next);
    if (!next) resetDraft();
  }

  const rows = pestRecordsForSite(activityQuery.data ?? [], siteId).slice(0, 15);
  const pending = mutation.isPending;

  return (
    <View>
      <OutboxEntries entries={outbox.entries} readError={outbox.readError} />
      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: colors.navy }, (pending || (!showForm && !canUseSite)) && styles.disabled]}
        onPress={toggleForm}
        disabled={pending || (!showForm && !canUseSite)}
        testID="pest-activity-toggle-form"
      >
        <Feather name={showForm ? 'x' : 'plus'} size={18} color={colors.primaryForeground} />
        <Text style={styles.primaryButtonText}>{showForm ? 'Cancel' : 'Log pest activity'}</Text>
      </TouchableOpacity>

      {showForm && (
        <View style={{ paddingTop: 16 }}>
          <AquaField label="Date recorded">
            <AquaInput value={recordedDate} onChangeText={setRecordedDate} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" colors={colors} disabled={pending} testID="pest-activity-date" />
          </AquaField>
          <AquaChoiceRow
            label="Pest type"
            options={pestTypes.map((value) => ({ value, label: pestTypeLabel(value) }))}
            value={effectivePestType}
            onChange={setPestType}
            colors={colors}
            testIDPrefix="pest-activity-type"
            disabled={pending}
          />
          <AquaChoiceRow
            label="Evidence type"
            options={evidenceTypes.map((value) => ({ value, label: evidenceLabel(value) }))}
            value={effectiveEvidenceType}
            onChange={setEvidenceType}
            colors={colors}
            testIDPrefix="pest-activity-evidence"
            disabled={pending}
          />
          <AquaChoiceRow
            label="Severity"
            options={PEST_SEVERITIES.map((value) => ({ value, label: severityLabel(value) }))}
            value={severity}
            onChange={setSeverity}
            colors={colors}
            testIDPrefix="pest-activity-severity"
            disabled={pending}
          />
          <AquaField label="Location / area">
            <AquaInput value={location} onChangeText={setLocation} placeholder="e.g. Kitchen, bin store" colors={colors} disabled={pending} testID="pest-activity-location" />
          </AquaField>
          <AquaField label="Recorded by">
            <AquaInput value={recordedBy} onChangeText={setRecordedBy} placeholder="Name" colors={colors} disabled={pending} testID="pest-activity-recorded-by" />
          </AquaField>
          <AquaField label="Action taken">
            <AquaInput value={actionTaken} onChangeText={setActionTaken} placeholder="What was done in response?" multiline colors={colors} disabled={pending} testID="pest-activity-action" />
          </AquaField>
          <AquaField label="Notes">
            <AquaInput value={notes} onChangeText={setNotes} placeholder="Additional observations..." multiline colors={colors} disabled={pending} testID="pest-activity-notes" />
          </AquaField>
          <AquaChoiceRow
            label="Status"
            options={[{ value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }]}
            value={resolved ? 'resolved' : 'open'}
            onChange={(value) => setResolved(value === 'resolved')}
            colors={colors}
            testIDPrefix="pest-activity-status"
            disabled={pending}
          />
          <Text style={[styles.detail, { color: colors.mutedForeground, marginTop: -8, marginBottom: 12 }]}>
            Mark as resolved when the pest activity has been dealt with.
          </Text>
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.navy }, (pending || !canUseSite) && styles.disabled]}
            onPress={submit}
            disabled={pending || !canUseSite}
            testID="pest-activity-submit"
          >
            {pending ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name="check" size={18} color={colors.primaryForeground} />}
            <Text style={styles.primaryButtonText}>{pending ? 'Saving…' : 'Log activity'}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ marginTop: 16 }}>
        {!canUseSite ? <AquaEmptyState colors={colors} message="Select a site to view pest activity." /> :
          activityQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
          activityQuery.isError ? (
            <AquaEmptyState colors={colors} error message={activityQuery.error instanceof Error ? activityQuery.error.message : 'Pest activity could not be loaded.'}>
              <TouchableOpacity onPress={() => void activityQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
            </AquaEmptyState>
          ) : rows.length ? rows.map((row) => (
            <View key={row.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`pest-activity-${row.id}`}>
              <View style={[styles.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>{row.recorded_date.slice(0, 10)}</Text>
                <View style={[styles.badge, { backgroundColor: severityColor(row.severity, colors) + '1a' }]}>
                  <Text style={[styles.badgeText, { color: severityColor(row.severity, colors) }]}>{severityLabel(row.severity)}</Text>
                </View>
                <Text style={{ color: row.resolved ? colors.success : colors.warning, fontFamily: 'Inter_600SemiBold' }}>
                  {row.resolved ? 'Resolved' : 'Open'}
                </Text>
              </View>
              <Text style={[styles.detail, { color: colors.foreground }]}>
                {pestTypeLabel(row.pest_type)} · {evidenceLabel(row.evidence_type)}
                {row.location ? ` · ${row.location}` : ''}
              </Text>
              {row.action_taken ? <Text style={[styles.detail, { color: colors.mutedForeground }]} numberOfLines={2}>Action: {row.action_taken}</Text> : null}
              {row.recorded_by ? <Text style={[styles.detail, { color: colors.mutedForeground }]}>Recorded by {row.recorded_by}</Text> : null}
              {siteId !== null && row.site_id === null ? <Text style={[styles.detail, { color: colors.mutedForeground }]}>All sites</Text> : null}
            </View>
          )) : (
            <AquaEmptyState colors={colors} message="No pest activity recorded for this site." />
          )}
      </View>
    </View>
  );
}

function severityColor(severity: string, colors: ReturnType<typeof useColors>): string {
  return severity === 'high' ? colors.destructive : severity === 'medium' ? colors.warning : colors.success;
}
