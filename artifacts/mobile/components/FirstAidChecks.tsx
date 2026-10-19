import React, { useState } from 'react';
import { ActivityIndicator, Alert, Switch, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';
import { useAquaRecordSender, type AquaSendOutcome } from '@/hooks/useAquaRecordSender';
import { OutboxEntries } from './OutboxEntries';
import { RequiredPhotoEvidence } from './RequiredPhotoEvidence';
import { AquaEmptyState, AquaField, AquaInput, aquaUiStyles as styles } from './aqua-track-ui';
import { aquaTrackSiteQuery, localDateString } from './aqua-track-logic';
import {
  FIRST_AID_ITEMS,
  allFirstAidItemsOk,
  buildFirstAidPayload,
  firstAidResult,
  type FirstAidCheck,
  type FirstAidItems,
} from './aqua-extras-logic';
import { AquaRouteNote, notifyAquaOutcome } from './aqua-extras-ui';

/** First-aid and rescue equipment readiness (RLSS UK / HSG179: monthly and before sessions). */
export function FirstAidChecks({
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
  const [checkDate, setCheckDate] = useState(localDateString());
  const [items, setItems] = useState<FirstAidItems>(allFirstAidItemsOk);
  const [checkedBy, setCheckedBy] = useState('');
  const [defectsFound, setDefectsFound] = useState('');
  const [notes, setNotes] = useState('');
  const queryKey = ['swim-first-aid', siteId];
  const sender = useAquaRecordSender('swim-first-aid', 'swim_first_aid_check', showForm && canUseSite && siteId !== null);
  const checksQuery = useQuery<FirstAidCheck[]>({
    queryKey,
    queryFn: () => {
      if (!canUseSite || siteId === null) throw new Error('Select a valid site before loading first-aid checks.');
      return apiFetch(`/api/swim-track/first-aid${aquaTrackSiteQuery(siteId)}&limit=30`);
    },
    enabled: canUseSite && siteId !== null,
  });

  function resetDraft(photos: 'consume' | 'cancel') {
    sender.reset(photos);
    setCheckDate(localDateString());
    setItems(allFirstAidItemsOk());
    setCheckedBy('');
    setDefectsFound('');
    setNotes('');
  }

  function close(photos: 'consume' | 'cancel') {
    setShowForm(false);
    onFormOpenChange(false);
    resetDraft(photos);
  }

  const mutation = useMutation({
    mutationFn: ({ payload, label }: { payload: Record<string, unknown>; label: string }) => sender.send(payload, label),
    onSuccess: async (outcome: AquaSendOutcome) => {
      if (!(await notifyAquaOutcome(outcome, 'first-aid check', 'Unable to record first-aid check'))) return;
      close('consume');
      if (outcome.state === 'sent') {
        const record = outcome.response as FirstAidCheck | undefined;
        if (record?.id) queryClient.setQueryData<FirstAidCheck[]>(queryKey, (current) => current ? [record, ...current] : [record]);
        void queryClient.invalidateQueries({ queryKey: ['swim-first-aid'] });
      }
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Unable to record first-aid check', error.message);
    },
  });

  const result = firstAidResult(items);

  function submit() {
    if (!canUseSite || siteId === null) {
      Alert.alert('Select a site', 'Choose a valid site before recording a first-aid check.');
      return;
    }
    const built = buildFirstAidPayload({ checkDate, items, checkedBy, defectsFound, notes }, siteId);
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
    mutation.mutate({ payload: built.payload, label: `First-aid check · ${checkDate}` });
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
        style={[styles.primaryButton, { backgroundColor: colors.navy }, (busy || (!showForm && !canUseSite)) && styles.disabled]}
        onPress={toggleForm}
        disabled={busy || (!showForm && !canUseSite)}
        testID="aqua-first-aid-toggle-form"
      >
        <Feather name={showForm ? 'x' : 'plus'} size={18} color={colors.primaryForeground} />
        <Text style={styles.primaryButtonText}>{showForm ? 'Cancel' : 'Log first-aid check'}</Text>
      </TouchableOpacity>

      {showForm && (
        <View style={{ paddingTop: 16 }}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <AquaField label="Date">
                <AquaInput value={checkDate} onChangeText={setCheckDate} placeholder="YYYY-MM-DD" colors={colors} disabled={busy} />
              </AquaField>
            </View>
            <View style={{ flex: 1 }}>
              <AquaField label="Checked by (optional)">
                <AquaInput value={checkedBy} onChangeText={setCheckedBy} placeholder="Name" colors={colors} disabled={busy} />
              </AquaField>
            </View>
          </View>
          <AquaField label="Equipment checklist (switch off anything not ready)">
            {FIRST_AID_ITEMS.map((item) => {
              const ok = items[item.key];
              return (
                <View key={item.key} style={[styles.row, { alignItems: 'center', paddingVertical: 4 }]}>
                  <Switch
                    value={ok}
                    onValueChange={(value) => setItems((current) => ({ ...current, [item.key]: value }))}
                    disabled={busy}
                    trackColor={{ true: colors.success, false: colors.destructive }}
                    accessibilityLabel={`${item.label} ready`}
                    testID={`aqua-first-aid-${item.key}`}
                  />
                  <Text style={[styles.cardTitle, { flex: 1, color: ok ? colors.foreground : colors.destructive }]}>
                    {item.label}{ok ? '' : ' — not ready'}
                  </Text>
                </View>
              );
            })}
          </AquaField>
          <Text style={[styles.detail, { color: result === 'pass' ? colors.success : colors.destructive, marginTop: -6, marginBottom: 12 }]}>
            {result === 'pass' ? 'Result: pass — all equipment ready.' : 'Result: fail — an action is raised for the equipment not ready.'}
          </Text>
          <AquaField label="Defects / actions required (optional)">
            <AquaInput value={defectsFound} onChangeText={setDefectsFound} placeholder="Items that need repair or replacement..." multiline colors={colors} disabled={busy} />
          </AquaField>
          <AquaField label="Notes (optional)">
            <AquaInput value={notes} onChangeText={setNotes} placeholder="Additional notes..." multiline colors={colors} disabled={busy} />
          </AquaField>
          <RequiredPhotoEvidence evidence={sender.photoEvidence} disabled={busy} testIDPrefix="aqua-first-aid-photo" />
          <AquaRouteNote route={sender.route} />
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.navy }, (busy || !canUseSite || !sender.ready) && styles.disabled]}
            onPress={submit}
            disabled={busy || !canUseSite || !sender.ready}
            testID="aqua-first-aid-submit"
          >
            {busy ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name="check" size={18} color={colors.primaryForeground} />}
            <Text style={styles.primaryButtonText}>{busy ? 'Saving…' : 'Save check'}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ marginTop: 16 }}>
        {!canUseSite ? <AquaEmptyState colors={colors} message="Select a site to view first-aid checks." /> :
          checksQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
          checksQuery.isError ? (
            <AquaEmptyState colors={colors} error message={checksQuery.error instanceof Error ? checksQuery.error.message : 'First-aid checks could not be loaded.'}>
              <TouchableOpacity onPress={() => void checksQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
            </AquaEmptyState>
          ) : checksQuery.data?.length ? checksQuery.data.slice(0, 15).map((check) => {
            const missing = FIRST_AID_ITEMS.filter((item) => check[item.column] === false).map((item) => item.label);
            return (
              <View key={check.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`aqua-first-aid-${check.id}`}>
                <View style={[styles.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                  <Text style={[styles.cardTitle, { color: colors.foreground }]}>{check.check_date.slice(0, 10)}</Text>
                  <Text style={{ color: check.result === 'pass' ? colors.success : colors.destructive, fontFamily: 'Inter_600SemiBold' }}>
                    {check.result === 'pass' ? 'All ready' : 'Action required'}
                  </Text>
                </View>
                {missing.length > 0 && (
                  <Text style={[styles.detail, { color: colors.destructive }]}>Not ready: {missing.join(', ')}</Text>
                )}
                {!!check.checked_by && <Text style={[styles.detail, { color: colors.mutedForeground }]}>Checked by {check.checked_by}</Text>}
                {!!check.defects_found && <Text style={[styles.detail, { color: colors.mutedForeground }]} numberOfLines={2}>{check.defects_found}</Text>}
              </View>
            );
          }) : (
            <AquaEmptyState colors={colors} message="No first-aid checks recorded for this site yet." />
          )}
      </View>
    </View>
  );
}
