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
import { aquaTrackSiteQuery, localDateString, localTimeString } from './aqua-track-logic';
import { buildSurveillancePayload, type SurveillanceCheck } from './aqua-extras-logic';
import { AquaRouteNote, notifyAquaOutcome } from './aqua-extras-ui';

/** Lifeguard surveillance scans (RLSS UK: every 15–20 minutes during a session). */
export function SurveillanceChecks({
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
  const [checkTime, setCheckTime] = useState(localTimeString());
  const [batherCount, setBatherCount] = useState('');
  const [scanCompleted, setScanCompleted] = useState(true);
  const [observations, setObservations] = useState('');
  const [checkedBy, setCheckedBy] = useState('');
  const queryKey = ['swim-surveillance', siteId];
  const sender = useAquaRecordSender('swim-surveillance', 'swim_surveillance_check', showForm && canUseSite && siteId !== null);
  const checksQuery = useQuery<SurveillanceCheck[]>({
    queryKey,
    queryFn: () => {
      if (!canUseSite || siteId === null) throw new Error('Select a valid site before loading surveillance checks.');
      return apiFetch(`/api/swim-track/surveillance${aquaTrackSiteQuery(siteId)}&limit=30`);
    },
    enabled: canUseSite && siteId !== null,
  });

  function resetDraft(photos: 'consume' | 'cancel') {
    sender.reset(photos);
    setCheckDate(localDateString());
    setCheckTime(localTimeString());
    setBatherCount('');
    setScanCompleted(true);
    setObservations('');
    setCheckedBy('');
  }

  function close(photos: 'consume' | 'cancel') {
    setShowForm(false);
    onFormOpenChange(false);
    resetDraft(photos);
  }

  const mutation = useMutation({
    mutationFn: ({ payload, label }: { payload: Record<string, unknown>; label: string }) => sender.send(payload, label),
    onSuccess: async (outcome: AquaSendOutcome) => {
      if (!(await notifyAquaOutcome(outcome, 'surveillance check', 'Unable to record surveillance check'))) return;
      close('consume');
      if (outcome.state === 'sent') {
        const record = outcome.response as SurveillanceCheck | undefined;
        if (record?.id) queryClient.setQueryData<SurveillanceCheck[]>(queryKey, (current) => current ? [record, ...current] : [record]);
        void queryClient.invalidateQueries({ queryKey: ['swim-surveillance'] });
      }
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Unable to record surveillance check', error.message);
    },
  });

  function submit() {
    if (!canUseSite || siteId === null) {
      Alert.alert('Select a site', 'Choose a valid site before recording a surveillance check.');
      return;
    }
    const built = buildSurveillancePayload({ checkDate, checkTime, batherCount, scanCompleted, observations, checkedBy }, siteId);
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
    mutation.mutate({ payload: built.payload, label: `Surveillance check · ${checkDate}${checkTime ? ` ${checkTime}` : ''}` });
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
        testID="aqua-surveillance-toggle-form"
      >
        <Feather name={showForm ? 'x' : 'plus'} size={18} color={colors.primaryForeground} />
        <Text style={styles.primaryButtonText}>{showForm ? 'Cancel' : 'Log surveillance check'}</Text>
      </TouchableOpacity>

      {showForm && (
        <View style={{ paddingTop: 16 }}>
          <Text style={[styles.detail, { color: colors.mutedForeground, marginTop: 0, marginBottom: 12 }]}>
            RLSS UK recommends a full pool scan and a logged surveillance check every 15–20 minutes.
          </Text>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <AquaField label="Date">
                <AquaInput value={checkDate} onChangeText={setCheckDate} placeholder="YYYY-MM-DD" colors={colors} disabled={busy} />
              </AquaField>
            </View>
            <View style={{ flex: 1 }}>
              <AquaField label="Time (local)">
                <AquaInput value={checkTime} onChangeText={setCheckTime} placeholder="HH:MM" keyboardType="numbers-and-punctuation" colors={colors} disabled={busy} />
              </AquaField>
            </View>
          </View>
          <View style={[styles.row, { alignItems: 'center', marginBottom: 14 }]}>
            <Switch
              value={scanCompleted}
              onValueChange={setScanCompleted}
              disabled={busy}
              trackColor={{ true: colors.success, false: colors.destructive }}
              accessibilityLabel="Full pool scan completed"
              testID="aqua-surveillance-scan"
            />
            <Text style={[styles.cardTitle, { color: scanCompleted ? colors.foreground : colors.destructive, flex: 1 }]}>
              {scanCompleted ? 'Full pool scan completed' : 'Full pool scan NOT completed (recorded as a fail)'}
            </Text>
          </View>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <AquaField label="Bather count (optional)">
                <AquaInput value={batherCount} onChangeText={setBatherCount} placeholder="e.g. 25" keyboardType="number-pad" colors={colors} disabled={busy} testID="aqua-surveillance-bathers" />
              </AquaField>
            </View>
            <View style={{ flex: 1 }}>
              <AquaField label="Checked by (optional)">
                <AquaInput value={checkedBy} onChangeText={setCheckedBy} placeholder="Lifeguard" colors={colors} disabled={busy} />
              </AquaField>
            </View>
          </View>
          <AquaField label="Observations (optional)">
            <AquaInput value={observations} onChangeText={setObservations} placeholder="Anything to note during this check..." multiline colors={colors} disabled={busy} />
          </AquaField>
          <RequiredPhotoEvidence evidence={sender.photoEvidence} disabled={busy} testIDPrefix="aqua-surveillance-photo" />
          <AquaRouteNote route={sender.route} />
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.navy }, (busy || !canUseSite || !sender.ready) && styles.disabled]}
            onPress={submit}
            disabled={busy || !canUseSite || !sender.ready}
            testID="aqua-surveillance-submit"
          >
            {busy ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name="check" size={18} color={colors.primaryForeground} />}
            <Text style={styles.primaryButtonText}>{busy ? 'Saving…' : 'Log check'}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ marginTop: 16 }}>
        {!canUseSite ? <AquaEmptyState colors={colors} message="Select a site to view surveillance checks." /> :
          checksQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
          checksQuery.isError ? (
            <AquaEmptyState colors={colors} error message={checksQuery.error instanceof Error ? checksQuery.error.message : 'Surveillance checks could not be loaded.'}>
              <TouchableOpacity onPress={() => void checksQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
            </AquaEmptyState>
          ) : checksQuery.data?.length ? checksQuery.data.slice(0, 15).map((check) => (
            <View key={check.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`aqua-surveillance-${check.id}`}>
              <View style={[styles.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                  {check.check_date.slice(0, 10)}{check.check_time ? ` · ${check.check_time.slice(0, 5)}` : ''}
                </Text>
                <Text style={{ color: check.scan_completed ? colors.success : colors.destructive, fontFamily: 'Inter_600SemiBold' }}>
                  {check.scan_completed ? 'Scan done' : 'Scan not done'}
                </Text>
              </View>
              <Text style={[styles.detail, { color: colors.mutedForeground }]}>
                {[check.checked_by, check.bather_count !== null && `${check.bather_count} bathers`].filter(Boolean).join(' · ') || 'No details recorded'}
              </Text>
              {!!check.observations && <Text style={[styles.detail, { color: colors.mutedForeground }]} numberOfLines={2}>{check.observations}</Text>}
            </View>
          )) : (
            <AquaEmptyState colors={colors} message="No surveillance checks recorded for this site yet." />
          )}
      </View>
    </View>
  );
}
