import React, { useState } from 'react';
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';
import { useAquaRecordSender, type AquaSendOutcome } from '@/hooks/useAquaRecordSender';
import { OutboxEntries } from './OutboxEntries';
import { RequiredPhotoEvidence } from './RequiredPhotoEvidence';
import { AquaChoiceRow, AquaEmptyState, AquaField, AquaInput, aquaUiStyles as styles } from './aqua-track-ui';
import { aquaTrackSiteQuery, localDateString } from './aqua-track-logic';
import {
  INCIDENT_SEVERITIES,
  INCIDENT_TYPES,
  buildIncidentPayload,
  incidentTypeLabel,
  isOpenIncident,
  severityLabel,
  type IncidentForm,
  type PoolIncident,
} from './aqua-extras-logic';
import { AquaRouteNote, notifyAquaOutcome } from './aqua-extras-ui';

const blankIncident = (): IncidentForm => ({
  incidentDate: localDateString(),
  incidentTime: '',
  incidentType: 'near_miss',
  severity: 'low',
  personsInvolved: '',
  description: '',
  actionTaken: '',
  reportedTo: '',
  reportedDate: '',
  outcome: '',
  notes: '',
});

/** Pool incidents and near misses, as logged on the website's Incidents tab. */
export function PoolIncidents({
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
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<IncidentForm>(blankIncident);
  const set = (key: keyof IncidentForm) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const queryKey = ['swim-incidents', siteId];
  const sender = useAquaRecordSender('swim-incident', 'swim_incident', showForm && canUseSite && siteId !== null);
  const incidentsQuery = useQuery<PoolIncident[]>({
    queryKey,
    queryFn: () => {
      if (!canUseSite || siteId === null) throw new Error('Select a valid site before loading incidents.');
      return apiFetch(`/api/swim-track/incidents${aquaTrackSiteQuery(siteId)}&limit=30`);
    },
    enabled: canUseSite && siteId !== null,
  });

  function close(photos: 'consume' | 'cancel') {
    setShowForm(false);
    onFormOpenChange(false);
    sender.reset(photos);
    setForm(blankIncident());
  }

  const mutation = useMutation({
    mutationFn: ({ payload, label }: { payload: Record<string, unknown>; label: string }) => sender.send(payload, label),
    onSuccess: async (outcome: AquaSendOutcome) => {
      if (!(await notifyAquaOutcome(outcome, 'incident', 'Unable to record incident'))) return;
      close('consume');
      if (outcome.state === 'sent') {
        const record = outcome.response as PoolIncident | undefined;
        if (record?.id) queryClient.setQueryData<PoolIncident[]>(queryKey, (current) => current ? [record, ...current] : [record]);
        void queryClient.invalidateQueries({ queryKey: ['swim-incidents'] });
      }
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Unable to record incident', error.message);
    },
  });

  function submit() {
    if (!canUseSite || siteId === null) {
      Alert.alert('Select a site', 'Choose a valid site before recording an incident.');
      return;
    }
    const built = buildIncidentPayload(form, siteId);
    if (!built.ok) {
      Alert.alert(built.title, built.error);
      return;
    }
    if (!sender.ready) {
      Alert.alert('Photos required', sender.photoEvidence.uploading
        ? 'Wait for the photo to finish verifying.'
        : `Attach at least ${sender.photoEvidence.minimum} verified ${sender.photoEvidence.minimum === 1 ? 'photo' : 'photos'} before saving.`);
      return;
    }
    mutation.mutate({ payload: built.payload, label: `Incident · ${incidentTypeLabel(form.incidentType)} · ${form.incidentDate}` });
  }

  function toggleForm() {
    if (mutation.isPending) return;
    if (!showForm && (!canUseSite || siteId === null)) return;
    if (showForm) { close('cancel'); return; }
    setShowForm(true);
    onFormOpenChange(true);
  }

  const busy = mutation.isPending;
  return (
    <View>
      <OutboxEntries entries={sender.entries} readError={sender.readError} />
      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: showForm ? colors.navy : colors.destructive }, (busy || (!showForm && !canUseSite)) && styles.disabled]}
        onPress={toggleForm}
        disabled={busy || (!showForm && !canUseSite)}
        testID="aqua-incident-toggle-form"
      >
        <Feather name={showForm ? 'x' : 'alert-triangle'} size={18} color={colors.primaryForeground} />
        <Text style={styles.primaryButtonText}>{showForm ? 'Cancel' : 'Log incident / near miss'}</Text>
      </TouchableOpacity>

      {showForm && (
        <View style={{ paddingTop: 16 }}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <AquaField label="Incident date">
                <AquaInput value={form.incidentDate} onChangeText={set('incidentDate')} placeholder="YYYY-MM-DD" colors={colors} disabled={busy} />
              </AquaField>
            </View>
            <View style={{ flex: 1 }}>
              <AquaField label="Time (optional)">
                <AquaInput value={form.incidentTime} onChangeText={set('incidentTime')} placeholder="HH:MM" keyboardType="numbers-and-punctuation" colors={colors} disabled={busy} />
              </AquaField>
            </View>
          </View>
          <AquaChoiceRow
            label="Type"
            options={[...INCIDENT_TYPES]}
            value={form.incidentType}
            onChange={set('incidentType')}
            colors={colors}
            testIDPrefix="aqua-incident-type"
            disabled={busy}
          />
          <AquaChoiceRow
            label="Severity"
            options={[...INCIDENT_SEVERITIES]}
            value={form.severity}
            onChange={set('severity')}
            colors={colors}
            testIDPrefix="aqua-incident-severity"
            disabled={busy}
          />
          <AquaField label="Persons involved (optional, no names of members of the public)">
            <AquaInput value={form.personsInvolved} onChangeText={set('personsInvolved')} placeholder="e.g. 1 adult bather, 2 staff" colors={colors} disabled={busy} />
          </AquaField>
          <AquaField label="Description">
            <AquaInput value={form.description} onChangeText={set('description')} placeholder="Describe what happened..." multiline colors={colors} disabled={busy} testID="aqua-incident-description" />
          </AquaField>
          <AquaField label="Action taken (optional)">
            <AquaInput value={form.actionTaken} onChangeText={set('actionTaken')} placeholder="First aid given, pool cleared..." multiline colors={colors} disabled={busy} />
          </AquaField>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <AquaField label="Reported to (optional)">
                <AquaInput value={form.reportedTo} onChangeText={set('reportedTo')} placeholder="Duty manager" colors={colors} disabled={busy} />
              </AquaField>
            </View>
            <View style={{ flex: 1 }}>
              <AquaField label="Date reported (optional)">
                <AquaInput value={form.reportedDate} onChangeText={set('reportedDate')} placeholder="YYYY-MM-DD" colors={colors} disabled={busy} />
              </AquaField>
            </View>
          </View>
          <AquaField label="Outcome (leave blank if still open)">
            <AquaInput value={form.outcome} onChangeText={set('outcome')} placeholder="Outcome..." multiline colors={colors} disabled={busy} />
          </AquaField>
          <AquaField label="Notes (optional)">
            <AquaInput value={form.notes} onChangeText={set('notes')} placeholder="Additional notes..." multiline colors={colors} disabled={busy} />
          </AquaField>
          <RequiredPhotoEvidence evidence={sender.photoEvidence} disabled={busy} testIDPrefix="aqua-incident-photo" />
          <AquaRouteNote route={sender.route} />
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: form.severity === 'critical' ? colors.destructive : colors.navy }, (busy || !canUseSite || !sender.ready) && styles.disabled]}
            onPress={submit}
            disabled={busy || !canUseSite || !sender.ready}
            testID="aqua-incident-submit"
          >
            {busy ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name="check" size={18} color={colors.primaryForeground} />}
            <Text style={styles.primaryButtonText}>{busy ? 'Saving…' : 'Log incident'}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ marginTop: 16 }}>
        {!canUseSite ? <AquaEmptyState colors={colors} message="Select a site to view incidents." /> :
          incidentsQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
          incidentsQuery.isError ? (
            <AquaEmptyState colors={colors} error message={incidentsQuery.error instanceof Error ? incidentsQuery.error.message : 'Incidents could not be loaded.'}>
              <TouchableOpacity onPress={() => void incidentsQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
            </AquaEmptyState>
          ) : incidentsQuery.data?.length ? incidentsQuery.data.slice(0, 15).map((incident) => (
            <View key={incident.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`aqua-incident-${incident.id}`}>
              <View style={[styles.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                  {incident.incident_date.slice(0, 10)}{incident.incident_time ? ` · ${incident.incident_time.slice(0, 5)}` : ''}
                </Text>
                <View style={[styles.badge, { backgroundColor: colors.primary + '1a' }]}>
                  <Text style={[styles.badgeText, { color: colors.primary }]}>{incidentTypeLabel(incident.incident_type)}</Text>
                </View>
                <Text style={{
                  color: incident.severity === 'critical' || incident.severity === 'high' ? colors.destructive : colors.mutedForeground,
                  fontFamily: 'Inter_600SemiBold',
                }}>
                  {severityLabel(incident.severity)}
                </Text>
              </View>
              <Text style={[styles.detail, { color: colors.foreground }]} numberOfLines={3}>{incident.description}</Text>
              <Text style={[styles.detail, { color: isOpenIncident(incident) ? colors.warning : colors.mutedForeground }]}>
                {isOpenIncident(incident) ? 'Open — no outcome recorded yet' : `Outcome: ${incident.outcome}`}
              </Text>
            </View>
          )) : (
            <AquaEmptyState colors={colors} message="No incidents recorded for this site." />
          )}
      </View>
    </View>
  );
}
