import React, { useState } from 'react';
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';
import { AquaChoiceRow, AquaEmptyState, AquaField, AquaInput, aquaUiStyles as styles } from './aqua-track-ui';
import {
  isLocalTime,
  isRealCalendarDate,
  localDateString,
  localTimeString,
  aquaTrackSiteQuery,
  canSubmitPoolCheckResult,
  isPoolResultAcknowledged,
  poolCheckSuggestedResult,
  validateOptionalNumber,
} from './aqua-track-logic';
import {
  POOL_CHECK_TYPES,
  POOL_RESULTS,
  TURBIDITY_OPTIONS,
  type PoolCheck,
  type PoolCheckType,
  type PoolResult,
  type Turbidity,
} from './aqua-track-types';

export function PoolChecks({
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
  const [checkType, setCheckType] = useState<PoolCheckType>('routine');
  const [freeChlorine, setFreeChlorine] = useState('');
  const [ph, setPh] = useState('');
  const [combinedChlorine, setCombinedChlorine] = useState('');
  const [waterTemperature, setWaterTemperature] = useState('');
  const [turbidity, setTurbidity] = useState<Turbidity | null>(null);
  const [actionsTaken, setActionsTaken] = useState('');
  const [performedBy, setPerformedBy] = useState('');
  const [notes, setNotes] = useState('');
  const [resultOverride, setResultOverride] = useState<PoolResult | null>(null);
  const queryKey = ['pool-checks', siteId];
  const siteQuery = aquaTrackSiteQuery(siteId);
  const checksQuery = useQuery<PoolCheck[]>({
    queryKey,
    queryFn: () => {
      if (!canUseSite || siteId === null) {
        throw new Error('Select a valid site before loading pool checks.');
      }
      return apiFetch(`/api/pool-track${siteQuery}`);
    },
    enabled: canUseSite && siteId !== null,
  });

  function resetDraft() {
    setCheckDate(localDateString());
    setCheckTime(localTimeString());
    setCheckType('routine');
    setFreeChlorine('');
    setPh('');
    setCombinedChlorine('');
    setWaterTemperature('');
    setTurbidity(null);
    setActionsTaken('');
    setPerformedBy('');
    setNotes('');
    setResultOverride(null);
  }

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch<PoolCheck>('/api/pool-track', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: async (record) => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      queryClient.setQueryData<PoolCheck[]>(queryKey, (current) => current ? [record, ...current] : [record]);
      void queryClient.invalidateQueries({ queryKey: ['pool-checks'] });
      setShowForm(false);
      onFormOpenChange(false);
      resetDraft();
      Alert.alert('Logged', 'Pool check recorded successfully.');
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Unable to record pool check', error.message);
    },
  });

  const phValue = validateOptionalNumber(ph, 'pH', 0, 14);
  const freeValue = validateOptionalNumber(freeChlorine, 'Free chlorine', 0, 20);
  const combinedValue = validateOptionalNumber(combinedChlorine, 'Combined chlorine', 0, 20);
  const tempValue = validateOptionalNumber(waterTemperature, 'Water temperature', 0, 60);
  const suggestedResult = poolCheckSuggestedResult({
    ph: phValue.value,
    freeChlorine: freeValue.value,
    combinedChlorine: combinedValue.value,
    turbidity,
    waterTemperature: tempValue.value,
  });
  const result = resultOverride ?? suggestedResult;

  function submit() {
    if (!canUseSite || siteId === null) {
      Alert.alert('Select a site', 'Choose a valid site before recording a pool check.');
      return;
    }
    if (!isRealCalendarDate(checkDate)) {
      Alert.alert('Check the date', 'Enter a real calendar date as YYYY-MM-DD.');
      return;
    }
    if (!isLocalTime(checkTime)) {
      Alert.alert('Check the time', 'Enter the local time as HH:MM.');
      return;
    }
    const numericErrors = [phValue, freeValue, combinedValue, tempValue].find((item) => item.error)?.error;
    if (numericErrors) {
      Alert.alert('Check the readings', numericErrors);
      return;
    }
    if (!canSubmitPoolCheckResult(suggestedResult, resultOverride) || !isPoolResultAcknowledged(result)) {
      Alert.alert(
        'Acknowledge the result',
        suggestedResult === null
          ? 'Record at least one water-quality assessment or explicitly select Pass or Fail.'
          : 'Select Pass or Fail to acknowledge the result when readings are outside the safe range.',
      );
      return;
    }
    if (actionsTaken.length > 2000 || notes.length > 2000 || performedBy.length > 200) {
      Alert.alert('Text is too long', 'Actions and notes must be 2,000 characters or fewer; performer must be 200 or fewer.');
      return;
    }
    mutation.mutate({
      checkDate,
      checkTime,
      checkType,
      siteId,
      phLevel: phValue.value,
      freeChlorine: freeValue.value,
      combinedChlorine: combinedValue.value,
      waterTempC: tempValue.value,
      turbidity,
      actionsTaken: actionsTaken.trim() || undefined,
      performedBy: performedBy.trim() || undefined,
      notes: notes.trim() || undefined,
      result,
    });
  }

  function toggleForm() {
    if (mutation.isPending) return;
    if (!showForm && (!canUseSite || siteId === null)) return;
    const next = !showForm;
    setShowForm(next);
    onFormOpenChange(next);
    if (!next) resetDraft();
  }

  return (
    <View>
      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: colors.navy }, (mutation.isPending || (!showForm && !canUseSite)) && styles.disabled]}
        onPress={toggleForm}
        disabled={mutation.isPending || (!showForm && !canUseSite)}
        testID="aqua-pool-toggle-form"
      >
        <Feather name={showForm ? 'x' : 'plus'} size={18} color={colors.primaryForeground} />
        <Text style={styles.primaryButtonText}>{showForm ? 'Cancel' : 'Log pool check'}</Text>
      </TouchableOpacity>

      {showForm && (
        <View style={{ paddingTop: 16 }}>
          <AquaChoiceRow
            label="Check type"
            options={POOL_CHECK_TYPES}
            value={checkType}
            onChange={(value) => setCheckType(value as PoolCheckType)}
            colors={colors}
            testIDPrefix="aqua-pool-type"
            disabled={mutation.isPending}
          />
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <AquaField label="Date">
                <AquaInput value={checkDate} onChangeText={setCheckDate} placeholder="YYYY-MM-DD" colors={colors} disabled={mutation.isPending} />
              </AquaField>
            </View>
            <View style={{ flex: 1 }}>
              <AquaField label="Time (local)">
                <AquaInput value={checkTime} onChangeText={setCheckTime} placeholder="HH:MM" keyboardType="numbers-and-punctuation" colors={colors} disabled={mutation.isPending} />
              </AquaField>
            </View>
          </View>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <AquaField label="Free Cl (mg/L, 0–20)">
                <AquaInput value={freeChlorine} onChangeText={(value) => { setFreeChlorine(value); setResultOverride(null); }} placeholder="e.g. 1.5" keyboardType="decimal-pad" colors={colors} disabled={mutation.isPending} testID="aqua-pool-free-chlorine" />
              </AquaField>
            </View>
            <View style={{ flex: 1 }}>
              <AquaField label="pH (0–14)">
                <AquaInput value={ph} onChangeText={(value) => { setPh(value); setResultOverride(null); }} placeholder="e.g. 7.4" keyboardType="decimal-pad" colors={colors} disabled={mutation.isPending} testID="aqua-pool-ph" />
              </AquaField>
            </View>
          </View>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <AquaField label="Water temp (°C, 0–60)">
                <AquaInput value={waterTemperature} onChangeText={(value) => { setWaterTemperature(value); setResultOverride(null); }} placeholder="e.g. 28" keyboardType="decimal-pad" colors={colors} disabled={mutation.isPending} />
              </AquaField>
            </View>
            <View style={{ flex: 1 }}>
              <AquaField label="Combined Cl (mg/L, 0–20)">
                <AquaInput value={combinedChlorine} onChangeText={(value) => { setCombinedChlorine(value); setResultOverride(null); }} placeholder="e.g. 0.2" keyboardType="decimal-pad" colors={colors} disabled={mutation.isPending} />
              </AquaField>
            </View>
          </View>
          <AquaChoiceRow
            label="Turbidity"
            options={TURBIDITY_OPTIONS}
            value={turbidity ?? ''}
            onChange={(value) => { setTurbidity(value as Turbidity); setResultOverride(null); }}
            colors={colors}
            testIDPrefix="aqua-pool-turbidity"
            disabled={mutation.isPending}
          />
          <AquaField label="Actions taken">
            <AquaInput value={actionsTaken} onChangeText={setActionsTaken} placeholder="Describe corrective actions..." multiline colors={colors} disabled={mutation.isPending} />
          </AquaField>
          <AquaField label="Performed by">
            <AquaInput value={performedBy} onChangeText={setPerformedBy} placeholder="Name" colors={colors} disabled={mutation.isPending} />
          </AquaField>
          <AquaField label="Notes">
            <AquaInput value={notes} onChangeText={setNotes} placeholder="Additional observations..." multiline colors={colors} disabled={mutation.isPending} />
          </AquaField>
          <AquaChoiceRow
            label={`Suggested result: ${suggestedResult === 'pass' ? 'Pass' : suggestedResult === 'fail' ? 'Fail' : 'Not available'}${resultOverride ? (resultOverride === suggestedResult ? ' · acknowledged' : ' · overridden') : ''}`}
            options={POOL_RESULTS}
            value={resultOverride ?? (suggestedResult === 'pass' ? 'pass' : '')}
            onChange={(value) => setResultOverride(value as PoolResult)}
            colors={colors}
            testIDPrefix="aqua-pool-result"
            disabled={mutation.isPending}
          />
          {suggestedResult !== 'pass' && !isPoolResultAcknowledged(resultOverride) && (
            <Text style={[styles.detail, { color: colors.destructive, marginTop: -8, marginBottom: 12 }]}>
              {suggestedResult === null
                ? 'No water-quality assessments recorded. Add an assessment or explicitly acknowledge Pass/Fail.'
                : 'Unsafe readings require an explicit Pass/Fail acknowledgement.'}
            </Text>
          )}
          {resultOverride && (
            <TouchableOpacity onPress={() => setResultOverride(null)} disabled={mutation.isPending} accessibilityRole="button">
              <Text style={{ color: colors.primary, fontFamily: 'Inter_600SemiBold', marginBottom: 12 }}>
                Use suggested result
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.navy }, (mutation.isPending || !canUseSite) && styles.disabled]}
            onPress={submit}
            disabled={mutation.isPending || !canUseSite}
            testID="aqua-pool-submit"
          >
            {mutation.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name="check" size={18} color={colors.primaryForeground} />}
            <Text style={styles.primaryButtonText}>{mutation.isPending ? 'Saving…' : 'Log pool check'}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ marginTop: 16 }}>
        {!canUseSite ? <AquaEmptyState colors={colors} message="Select a site to view pool checks." /> :
          checksQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
          checksQuery.isError ? (
            <AquaEmptyState colors={colors} error message={checksQuery.error instanceof Error ? checksQuery.error.message : 'Pool checks could not be loaded.'}>
              <TouchableOpacity onPress={() => void checksQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
            </AquaEmptyState>
          ) : checksQuery.data?.length ? checksQuery.data.slice(0, 15).map((check) => (
            <View key={check.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={[styles.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                  {check.check_date.slice(0, 10)}{check.check_time ? ` · ${check.check_time}` : ''}
                </Text>
                <View style={[styles.badge, { backgroundColor: colors.primary + '1a' }]}>
                  <Text style={[styles.badgeText, { color: colors.primary }]}>
                    {POOL_CHECK_TYPES.find((type) => type.value === check.check_type)?.label ?? check.check_type}
                  </Text>
                </View>
                <Text style={{ color: resultColor(check.result, colors), fontFamily: 'Inter_600SemiBold' }}>
                  {check.result === 'pass' ? 'Pass' : 'Fail'}
                </Text>
              </View>
              <Text style={[styles.detail, { color: colors.mutedForeground }]}>
                {[
                  check.free_chlorine !== null && `Cl ${check.free_chlorine}`,
                  check.ph_level !== null && `pH ${check.ph_level}`,
                  check.water_temp_c !== null && `${check.water_temp_c}°C`,
                  check.turbidity && check.turbidity.replace('_', ' '),
                ].filter(Boolean).join(' · ') || 'No readings recorded'}
              </Text>
              {check.notes && <Text style={[styles.detail, { color: colors.mutedForeground }]} numberOfLines={2}>{check.notes}</Text>}
            </View>
          )) : (
            <AquaEmptyState colors={colors} message="No pool checks recorded for this site yet." />
          )}
      </View>
    </View>
  );
}

function resultColor(result: string, colors: ReturnType<typeof useColors>): string {
  return result === 'pass' ? colors.success : colors.destructive;
}