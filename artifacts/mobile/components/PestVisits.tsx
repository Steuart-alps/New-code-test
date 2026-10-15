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
  buildPestVisitPayload,
  localDate,
  pestRecordsForSite,
  type PestVisit,
  type PestVisitDraft,
} from './pest-track-logic';

const emptyDraft = (config: Record<string, string> | undefined): PestVisitDraft => ({
  visitDate: localDate(),
  nextVisitDate: '',
  // Prefilled from the account's PestTrack settings, as on the website.
  contractorName: config?.pest_contractor_name ?? '',
  contractorCompany: config?.pest_contractor_company ?? '',
  areasInspected: '',
  findings: '',
  treatmentsApplied: '',
  recommendations: '',
  signedOffBy: '',
  notes: '',
});

/**
 * Pest-control contractor visits for the chosen site: the website's "Log
 * contractor visit" form, sent through the device outbox.
 */
export function PestVisits({
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
  const queryKey = ['pest-visits', user?.clientId];
  const visitsQuery = useQuery<PestVisit[]>({
    queryKey,
    queryFn: () => apiFetch('/api/pest-track/visits'),
  });
  const { data: config } = useQuery<Record<string, string>>({
    queryKey: ['pest-config', user?.clientId],
    queryFn: () => apiFetch('/api/pest-track/config'),
  });
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<PestVisitDraft>(() => emptyDraft(config));
  const set = (key: keyof PestVisitDraft) => (value: string) => setDraft((current) => ({ ...current, [key]: value }));

  // Saved on the device first, then sent; resent automatically under the
  // same entry ID after a lost connection (the server never duplicates it).
  const outbox = useRecordOutbox('pest-visit');
  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      outbox.send(payload, `Contractor visit · ${String(payload.contractorCompany ?? payload.contractorName ?? 'Pest control')} · ${String(payload.visitDate)}`),
    onSuccess: async (outcome) => {
      if (outcome.state === 'rejected') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('Unable to log visit', outcome.error);
        return;
      }
      setShowForm(false);
      onFormOpenChange(false);
      setDraft(emptyDraft(config));
      if (outcome.state === 'queued') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert('Saved on this device', 'No connection right now. The contractor visit is saved on this device and will be sent automatically when you are back online.');
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const record = outcome.response as PestVisit | undefined;
      if (record?.id) queryClient.setQueryData<PestVisit[]>(queryKey, (current) => current ? [record, ...current] : [record]);
      void queryClient.invalidateQueries({ queryKey: ['pest-visits'] });
      Alert.alert('Logged', 'Contractor visit recorded successfully.');
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Unable to log visit', error.message);
    },
  });

  function submit() {
    if (!canUseSite) {
      Alert.alert('Select a site', 'Choose a site before logging a contractor visit.');
      return;
    }
    const built = buildPestVisitPayload(draft, siteId);
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
    setDraft(emptyDraft(config));
  }

  const rows = pestRecordsForSite(visitsQuery.data ?? [], siteId).slice(0, 15);
  const pending = mutation.isPending;
  const field = (label: string, key: keyof PestVisitDraft, placeholder: string, options: { multiline?: boolean; date?: boolean } = {}) => (
    <AquaField label={label}>
      <AquaInput
        value={draft[key]}
        onChangeText={set(key)}
        placeholder={placeholder}
        keyboardType={options.date ? 'numbers-and-punctuation' : undefined}
        multiline={options.multiline}
        colors={colors}
        disabled={pending}
        testID={`pest-visit-${key}`}
      />
    </AquaField>
  );

  return (
    <View>
      <OutboxEntries entries={outbox.entries} readError={outbox.readError} />
      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: colors.navy }, (pending || (!showForm && !canUseSite)) && styles.disabled]}
        onPress={toggleForm}
        disabled={pending || (!showForm && !canUseSite)}
        testID="pest-visit-toggle-form"
      >
        <Feather name={showForm ? 'x' : 'plus'} size={18} color={colors.primaryForeground} />
        <Text style={styles.primaryButtonText}>{showForm ? 'Cancel' : 'Log contractor visit'}</Text>
      </TouchableOpacity>

      {showForm && (
        <View style={{ paddingTop: 16 }}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>{field('Visit date', 'visitDate', 'YYYY-MM-DD', { date: true })}</View>
            <View style={{ flex: 1 }}>{field('Next scheduled visit', 'nextVisitDate', 'YYYY-MM-DD', { date: true })}</View>
          </View>
          {field('Contractor name', 'contractorName', 'e.g. John Smith')}
          {field('Contractor company', 'contractorCompany', 'e.g. ABC Pest Control')}
          {field('Signed off by', 'signedOffBy', 'Name')}
          {field('Areas inspected / treated', 'areasInspected', 'e.g. Kitchen, cellar, external bin store', { multiline: true })}
          {field('Findings', 'findings', 'Pest activity observed, evidence found, or no activity', { multiline: true })}
          {field('Treatments applied', 'treatmentsApplied', 'e.g. Bait replenished at stations 1–6', { multiline: true })}
          {field('Recommendations / remedial actions', 'recommendations', 'e.g. Seal gap under back door', { multiline: true })}
          {field('Notes', 'notes', 'Additional notes...', { multiline: true })}
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.navy }, (pending || !canUseSite) && styles.disabled]}
            onPress={submit}
            disabled={pending || !canUseSite}
            testID="pest-visit-submit"
          >
            {pending ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name="check" size={18} color={colors.primaryForeground} />}
            <Text style={styles.primaryButtonText}>{pending ? 'Saving…' : 'Log visit'}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ marginTop: 16 }}>
        {!canUseSite ? <AquaEmptyState colors={colors} message="Select a site to view contractor visits." /> :
          visitsQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
          visitsQuery.isError ? (
            <AquaEmptyState colors={colors} error message={visitsQuery.error instanceof Error ? visitsQuery.error.message : 'Contractor visits could not be loaded.'}>
              <TouchableOpacity onPress={() => void visitsQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
            </AquaEmptyState>
          ) : rows.length ? rows.map((visit) => (
            <View key={visit.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`pest-visit-${visit.id}`}>
              <View style={[styles.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>{visit.visit_date.slice(0, 10)}</Text>
                {visit.next_visit_date ? (
                  <View style={[styles.badge, { backgroundColor: colors.primary + '1a' }]}>
                    <Text style={[styles.badgeText, { color: colors.primary }]}>Next {visit.next_visit_date.slice(0, 10)}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.detail, { color: colors.foreground }]}>
                {[visit.contractor_name, visit.contractor_company].filter(Boolean).join(' · ') || 'Contractor not recorded'}
              </Text>
              {visit.findings ? <Text style={[styles.detail, { color: colors.mutedForeground }]} numberOfLines={2}>Findings: {visit.findings}</Text> : null}
              {visit.treatments_applied ? <Text style={[styles.detail, { color: colors.mutedForeground }]} numberOfLines={2}>Treatments: {visit.treatments_applied}</Text> : null}
              {visit.recommendations ? <Text style={[styles.detail, { color: colors.mutedForeground }]} numberOfLines={2}>Recommendations: {visit.recommendations}</Text> : null}
              {visit.signed_off_by ? <Text style={[styles.detail, { color: colors.mutedForeground }]}>Signed off by {visit.signed_off_by}</Text> : null}
              {siteId !== null && visit.site_id === null ? <Text style={[styles.detail, { color: colors.mutedForeground }]}>All sites</Text> : null}
            </View>
          )) : (
            <AquaEmptyState colors={colors} message="No contractor visits recorded for this site." />
          )}
      </View>
    </View>
  );
}
