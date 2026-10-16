import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { DateStepper } from './DateStepper';
import { OutboxEntries } from './OutboxEntries';
import { AquaEmptyState, AquaField, AquaInput, aquaUiStyles as styles } from './aqua-track-ui';
import {
  AnswerToggle,
  KitchenNotice,
  ResultBadge,
  SubmittedBadge,
  fetchOptional,
  kitchenExtrasStyles as kx,
} from './kitchen-extras-ui';
import {
  buildProbeCheckPayload,
  defaultProbeRows,
  displayDate,
  emptyProbeRow,
  localDate,
  pendingEntryFor,
  probeNamesFromConfig,
  probeOverallResult,
  readingWithinTolerance,
  type ProbeCheckRecord,
  type ProbeCheckSummary,
  type ProbeRowDraft,
} from './kitchen-extras-logic';

const ACCURACY = [
  { value: true, label: '✓ Accurate', tone: 'good' as const },
  { value: false, label: '✗ Inaccurate', tone: 'bad' as const },
];

/**
 * Monthly probe calibration (website KitchenTrack "Probe Check" tab): ice-point
 * and boiling-point readings per probe, signed and submitted through the
 * device outbox. A record already started or submitted for the date is edited
 * on the website.
 */
export function KitchenProbeCheck() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [checkDate, setCheckDate] = useState(localDate());
  const [probes, setProbes] = useState<ProbeRowDraft[]>([emptyProbeRow()]);
  const [checkedBy, setCheckedBy] = useState('');
  const [signature, setSignature] = useState('');
  const [notes, setNotes] = useState('');
  const [dirty, setDirty] = useState(false);

  const configQuery = useQuery<Record<string, string>>({
    queryKey: ['kitchen-probe-config', user?.clientId],
    queryFn: () => apiFetch('/api/food-safety/config'),
  });
  const probeNames = probeNamesFromConfig(configQuery.data?.food_probe_names);
  const probeNamesKey = probeNames.join('\u0000');
  const historyQuery = useQuery<ProbeCheckSummary[]>({
    queryKey: ['kitchen-probe-checks', user?.clientId],
    queryFn: () => apiFetch('/api/kitchen-weekly/probe'),
  });
  const existingQuery = useQuery<ProbeCheckRecord | null>({
    queryKey: ['kitchen-probe-checks', user?.clientId, 'by-date', checkDate],
    queryFn: () => fetchOptional(`/api/kitchen-weekly/probe/by-date/${checkDate}`),
  });

  // Prefill one row per configured probe until the user starts typing.
  useEffect(() => {
    if (!dirty) setProbes(defaultProbeRows(probeNamesKey ? probeNamesKey.split('\u0000') : []));
  }, [probeNamesKey, dirty]);

  const markDirty = () => setDirty(true);
  const reset = () => {
    setProbes(defaultProbeRows(probeNames));
    setCheckedBy('');
    setSignature('');
    setNotes('');
    setDirty(false);
  };

  const outbox = useRecordOutbox('kitchen-probe');
  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      outbox.send(payload, `Probe calibration · ${displayDate(String(payload.checkDate))}`),
    onSuccess: async (outcome) => {
      if (outcome.state === 'rejected') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('Unable to submit probe check', outcome.error);
        void queryClient.invalidateQueries({ queryKey: ['kitchen-probe-checks'] });
        return;
      }
      reset();
      if (outcome.state === 'queued') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert('Saved on this device', 'No connection right now. The probe check is saved on this device and will be sent automatically when you are back online.');
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      void queryClient.invalidateQueries({ queryKey: ['kitchen-probe-checks'] });
      Alert.alert('Submitted', 'Probe calibration check recorded.');
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Unable to submit probe check', error.message);
    },
  });

  const pending = mutation.isPending;
  const existing = existingQuery.data;
  const waiting = pendingEntryFor(outbox.entries, 'checkDate', checkDate);
  const blocked = !!existing || !!waiting;
  const result = probeOverallResult(probes);

  function submit() {
    if (existingQuery.isLoading) return;
    const built = buildProbeCheckPayload({ checkDate, probes, checkedBy, signature, notes }, localDate(), new Date().toISOString());
    if (!built.ok) {
      Alert.alert(built.title, built.message);
      return;
    }
    mutation.mutate(built.payload);
  }

  const updateRow = (index: number, patch: Partial<ProbeRowDraft>) => {
    markDirty();
    setProbes((rows) => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  };

  const readingHint = (value: string, target: 0 | 100) => {
    const within = readingWithinTolerance(value, target);
    if (within === false) {
      return <Text style={[styles.detail, { color: colors.destructive, marginTop: 6 }]}>Outside ±1°C of {target}°C</Text>;
    }
    return <Text style={[styles.detail, { color: colors.mutedForeground, marginTop: 6 }]}>Must read within ±1°C of {target}°C</Text>;
  };

  return (
    <View>
      <OutboxEntries entries={outbox.entries} readError={outbox.readError} />
      <Text style={[kx.sectionHint, { color: colors.mutedForeground }]}>
        Calibrate probes at least once every 4 weeks using the ice-point (0°C) and boiling-point (100°C) methods. Acceptable range: ±1°C.
      </Text>

      <AquaField label="Check date">
        <DateStepper value={checkDate} onChange={setCheckDate} testID="kitchen-probe-date" />
      </AquaField>

      {existingQuery.isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginVertical: 12 }} />
      ) : existing ? (
        <KitchenNotice icon={existing.submitted_at ? 'check-circle' : 'edit-3'} tone={existing.submitted_at ? 'success' : 'warning'} testID="kitchen-probe-existing">
          {existing.submitted_at
            ? `A probe check for ${displayDate(checkDate)} was submitted${existing.signature || existing.checked_by ? ` by ${existing.signature ?? existing.checked_by}` : ''}${existing.overall_result ? ` (${existing.overall_result === 'pass' ? 'Pass' : 'Fail'})` : ''}. Changes are made on the website.`
            : `A draft probe check for ${displayDate(checkDate)} was started on the website. Finish and submit it there.`}
        </KitchenNotice>
      ) : waiting ? (
        <KitchenNotice icon="upload-cloud" tone="warning" testID="kitchen-probe-waiting">
          A probe check for {displayDate(checkDate)} is saved on this device and waiting to send.
        </KitchenNotice>
      ) : existingQuery.isError ? (
        <KitchenNotice icon="wifi-off" tone="info">
          Could not check for an existing record for this date. You can still submit; if one already exists the website keeps it and this one is not accepted.
        </KitchenNotice>
      ) : null}

      {!blocked && !existingQuery.isLoading && (
        <View>
          {result ? (
            <KitchenNotice icon={result === 'pass' ? 'check-circle' : 'x-circle'} tone={result === 'pass' ? 'success' : 'destructive'} testID="kitchen-probe-result">
              {result === 'pass'
                ? 'Overall result: PASS. All answered probes read accurately to ±1°C.'
                : 'Overall result: FAIL. Inaccurate probes must be adjusted, recalibrated or replaced before use.'}
            </KitchenNotice>
          ) : null}

          <Text style={[kx.sectionTitle, { color: colors.foreground }]}>Probe calibration results</Text>
          {probes.map((row, index) => (
            <View key={index} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`kitchen-probe-row-${index}`}>
              <View style={[styles.row, { alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }]}>
                <Text style={[styles.cardTitle, { color: colors.mutedForeground }]}>Probe {index + 1}</Text>
                <TouchableOpacity
                  onPress={() => { markDirty(); setProbes((rows) => rows.filter((_, i) => i !== index)); }}
                  disabled={pending}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove probe ${index + 1}`}
                  testID={`kitchen-probe-remove-${index}`}
                >
                  <Feather name="trash-2" size={16} color={colors.destructive} />
                </TouchableOpacity>
              </View>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <AquaField label="Probe name / ID">
                    <AquaInput value={row.name} onChangeText={(name) => updateRow(index, { name })} placeholder="e.g. Probe 1" colors={colors} disabled={pending} testID={`kitchen-probe-name-${index}`} />
                  </AquaField>
                </View>
                <View style={{ flex: 1 }}>
                  <AquaField label="Serial number">
                    <AquaInput value={row.serialNo} onChangeText={(serialNo) => updateRow(index, { serialNo })} placeholder="Optional" colors={colors} disabled={pending} />
                  </AquaField>
                </View>
              </View>
              <AquaField label="Ice point reading (°C)">
                <AquaInput value={row.iceTemp} onChangeText={(iceTemp) => updateRow(index, { iceTemp })} placeholder="e.g. 0.4" keyboardType="numbers-and-punctuation" colors={colors} disabled={pending} testID={`kitchen-probe-ice-${index}`} />
                {readingHint(row.iceTemp, 0)}
                <View style={{ marginTop: 8 }}>
                  <AnswerToggle options={ACCURACY} value={row.accurateIce} onChange={(accurateIce) => updateRow(index, { accurateIce })} disabled={pending} testIDPrefix={`kitchen-probe-ice-accurate-${index}`} />
                </View>
              </AquaField>
              <AquaField label="Boiling point reading (°C)">
                <AquaInput value={row.boilingTemp} onChangeText={(boilingTemp) => updateRow(index, { boilingTemp })} placeholder="e.g. 99.7" keyboardType="numbers-and-punctuation" colors={colors} disabled={pending} testID={`kitchen-probe-boiling-${index}`} />
                {readingHint(row.boilingTemp, 100)}
                <View style={{ marginTop: 8 }}>
                  <AnswerToggle options={ACCURACY} value={row.accurateBoiling} onChange={(accurateBoiling) => updateRow(index, { accurateBoiling })} disabled={pending} testIDPrefix={`kitchen-probe-boiling-accurate-${index}`} />
                </View>
              </AquaField>
              <AquaField label="Notes / action taken">
                <AquaInput value={row.notes} onChangeText={(value) => updateRow(index, { notes: value })} placeholder="e.g. Probe adjusted, replaced, or decommissioned" colors={colors} disabled={pending} />
              </AquaField>
            </View>
          ))}
          <TouchableOpacity
            style={kx.linkButton}
            onPress={() => { markDirty(); setProbes((rows) => [...rows, emptyProbeRow()]); }}
            disabled={pending}
            accessibilityRole="button"
            testID="kitchen-probe-add"
          >
            <Feather name="plus" size={16} color={colors.primary} />
            <Text style={[kx.linkText, { color: colors.primary }]}>Add probe</Text>
          </TouchableOpacity>

          <AquaField label="General notes">
            <AquaInput value={notes} onChangeText={(value) => { markDirty(); setNotes(value); }} placeholder="Any additional observations, actions taken, or probes decommissioned…" multiline colors={colors} disabled={pending} />
          </AquaField>
          <AquaField label="Checked by">
            <AquaInput value={checkedBy} onChangeText={(value) => { markDirty(); setCheckedBy(value); }} placeholder="Name" colors={colors} disabled={pending} testID="kitchen-probe-checked-by" />
          </AquaField>
          <AquaField label="Signature (type name)">
            <AquaInput value={signature} onChangeText={(value) => { markDirty(); setSignature(value); }} placeholder="Type name to sign" colors={colors} disabled={pending} testID="kitchen-probe-signature" />
          </AquaField>
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.navy }, pending && styles.disabled]}
            onPress={submit}
            disabled={pending}
            testID="kitchen-probe-submit"
          >
            {pending ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name="check-circle" size={18} color={colors.primaryForeground} />}
            <Text style={styles.primaryButtonText}>{pending ? 'Submitting…' : 'Submit & sign'}</Text>
          </TouchableOpacity>
        </View>
      )}

      <Text style={[kx.sectionTitle, { color: colors.foreground, marginTop: 20 }]}>Probe check history</Text>
      {historyQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
        historyQuery.isError ? (
          <AquaEmptyState colors={colors} error message={historyQuery.error instanceof Error ? historyQuery.error.message : 'Probe checks could not be loaded.'}>
            <TouchableOpacity onPress={() => void historyQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
          </AquaEmptyState>
        ) : historyQuery.data?.length ? historyQuery.data.slice(0, 12).map((row) => (
          <TouchableOpacity
            key={row.id}
            style={[kx.historyRow, { borderTopColor: colors.border }]}
            onPress={() => setCheckDate(row.check_date.slice(0, 10))}
            disabled={pending}
            testID={`kitchen-probe-history-${row.id}`}
          >
            <Text style={[kx.historyDate, { color: colors.foreground }]}>{displayDate(row.check_date)}</Text>
            <ResultBadge result={row.overall_result} colors={colors} />
            <SubmittedBadge submitted={!!row.submitted_at} colors={colors} />
          </TouchableOpacity>
        )) : <AquaEmptyState colors={colors} message="No probe checks yet." />}
    </View>
  );
}
