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
  hasSelectedAquaSite,
  isPoolResultAcknowledged,
  sessionsForDate,
  validateOptionalInteger,
} from './aqua-track-logic';
import {
  POOL_RESULTS,
  SESSION_TYPES,
  type PoolResult,
  type SessionType,
  type SwimSession,
} from './aqua-track-types';

export function Sessions({
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
  const [sessionDate, setSessionDate] = useState(localDateString());
  const [openTime, setOpenTime] = useState(localTimeString());
  const [closeTime, setCloseTime] = useState('');
  const [sessionType, setSessionType] = useState<SessionType>('public_swim');
  const [preSessionResult, setPreSessionResult] = useState<PoolResult | null>(null);
  const [lifeguardName, setLifeguardName] = useState('');
  const [maxBathers, setMaxBathers] = useState('');
  const [notes, setNotes] = useState('');
  const queryKey = ['swim-sessions', siteId];
  const siteQuery = aquaTrackSiteQuery(siteId);
  const sessionsQuery = useQuery<SwimSession[]>({
    queryKey,
    queryFn: () => {
      if (!canUseSite || siteId === null) {
        throw new Error('Select a valid site before loading sessions.');
      }
      return apiFetch(`/api/swim-track/sessions${siteQuery}`);
    },
    enabled: canUseSite && siteId !== null,
  });

  function resetDraft() {
    setSessionDate(localDateString());
    setOpenTime(localTimeString());
    setCloseTime('');
    setSessionType('public_swim');
    setPreSessionResult(null);
    setLifeguardName('');
    setMaxBathers('');
    setNotes('');
  }

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch<SwimSession>('/api/swim-track/sessions', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: async (record) => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      queryClient.setQueryData<SwimSession[]>(queryKey, (current) => current ? [record, ...current] : [record]);
      void queryClient.invalidateQueries({ queryKey: ['swim-sessions'] });
      setShowForm(false);
      onFormOpenChange(false);
      resetDraft();
      Alert.alert('Logged', 'Session recorded successfully.');
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Unable to record session', error.message);
    },
  });

  function submit() {
    if (!canUseSite || siteId === null) {
      Alert.alert('Select a site', 'Choose a valid site before recording a session.');
      return;
    }
    if (!isRealCalendarDate(sessionDate)) {
      Alert.alert('Check the date', 'Enter a real calendar date as YYYY-MM-DD.');
      return;
    }
    if (!isLocalTime(openTime) || (closeTime && !isLocalTime(closeTime))) {
      Alert.alert('Check the time', 'Enter session times as HH:MM.');
      return;
    }
    if (!isPoolResultAcknowledged(preSessionResult)) {
      Alert.alert('Select a pre-session result', 'Choose Pass or Fail before recording the session.');
      return;
    }
    const bathers = validateOptionalInteger(maxBathers, 'Maximum bathers');
    if (bathers.error) {
      Alert.alert('Check the number', bathers.error);
      return;
    }
    if (lifeguardName.length > 200 || notes.length > 2000) {
      Alert.alert('Text is too long', 'Lifeguard name must be 200 characters or fewer and notes must be 2,000 or fewer.');
      return;
    }
    mutation.mutate({
      siteId,
      sessionDate,
      sessionType,
      openTime,
      closeTime: closeTime || null,
      lifeguardName: lifeguardName.trim() || null,
      maxBathers: bathers.value,
      preSessionResult,
      result: preSessionResult,
      notes: notes.trim() || null,
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

  const todaysSessions = sessionsQuery.data ? sessionsForDate(sessionsQuery.data, localDateString()) : [];

  return (
    <View>
      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: colors.navy }, (mutation.isPending || (!showForm && !canUseSite)) && styles.disabled]}
        onPress={toggleForm}
        disabled={mutation.isPending || (!showForm && !canUseSite)}
        testID="aqua-session-toggle-form"
      >
        <Feather name={showForm ? 'x' : 'plus'} size={18} color={colors.primaryForeground} />
        <Text style={styles.primaryButtonText}>{showForm ? 'Cancel' : 'Log session'}</Text>
      </TouchableOpacity>

      {showForm && (
        <View style={{ paddingTop: 16 }}>
          <AquaChoiceRow
            label="Session type"
            options={SESSION_TYPES}
            value={sessionType}
            onChange={(value) => setSessionType(value as SessionType)}
            colors={colors}
            testIDPrefix="aqua-session-type"
            disabled={mutation.isPending}
          />
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <AquaField label="Session date">
                <AquaInput value={sessionDate} onChangeText={setSessionDate} placeholder="YYYY-MM-DD" colors={colors} disabled={mutation.isPending} />
              </AquaField>
            </View>
            <View style={{ flex: 1 }}>
              <AquaField label="Start time (local)">
                <AquaInput value={openTime} onChangeText={setOpenTime} placeholder="HH:MM" keyboardType="numbers-and-punctuation" colors={colors} disabled={mutation.isPending} />
              </AquaField>
            </View>
          </View>
          <AquaField label="Close time (local, optional)">
            <AquaInput value={closeTime} onChangeText={setCloseTime} placeholder="HH:MM" keyboardType="numbers-and-punctuation" colors={colors} disabled={mutation.isPending} />
          </AquaField>
          <AquaChoiceRow
            label="Pre-session result"
            options={POOL_RESULTS}
            value={preSessionResult ?? ''}
            onChange={(value) => setPreSessionResult(value as PoolResult)}
            colors={colors}
            testIDPrefix="aqua-session-result"
            disabled={mutation.isPending}
          />
          <Text style={[styles.detail, { color: colors.mutedForeground, marginTop: -8, marginBottom: 12 }]}>
            Select Pass or Fail. This selection is also saved as the session result.
          </Text>
          <AquaField label="Lifeguard name">
            <AquaInput value={lifeguardName} onChangeText={setLifeguardName} placeholder="Name on duty" colors={colors} disabled={mutation.isPending} />
          </AquaField>
          <AquaField label="Maximum bathers">
            <AquaInput value={maxBathers} onChangeText={setMaxBathers} placeholder="e.g. 50" keyboardType="number-pad" colors={colors} disabled={mutation.isPending} />
          </AquaField>
          <AquaField label="Notes">
            <AquaInput value={notes} onChangeText={setNotes} placeholder="Session notes..." multiline colors={colors} disabled={mutation.isPending} />
          </AquaField>
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.navy }, (mutation.isPending || !canUseSite) && styles.disabled]}
            onPress={submit}
            disabled={mutation.isPending || !canUseSite}
            testID="aqua-session-submit"
          >
            {mutation.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name="check" size={18} color={colors.primaryForeground} />}
            <Text style={styles.primaryButtonText}>{mutation.isPending ? 'Saving…' : 'Log session'}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ marginTop: 16 }}>
        {!canUseSite ? <AquaEmptyState colors={colors} message="Select a site to view sessions." /> :
          sessionsQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
          sessionsQuery.isError ? (
            <AquaEmptyState colors={colors} error message={sessionsQuery.error instanceof Error ? sessionsQuery.error.message : 'Sessions could not be loaded.'}>
              <TouchableOpacity onPress={() => void sessionsQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
            </AquaEmptyState>
          ) : todaysSessions.length ? todaysSessions.slice(0, 15).map((session) => (
            <View key={session.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={[styles.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                  {session.open_time || 'Time not recorded'}{session.close_time ? `–${session.close_time}` : ''}
                </Text>
                <View style={[styles.badge, { backgroundColor: colors.primary + '1a' }]}>
                  <Text style={[styles.badgeText, { color: colors.primary }]}>
                    {SESSION_TYPES.find((type) => type.value === session.session_type)?.label ?? session.session_type}
                  </Text>
                </View>
                <Text style={{ color: session.result === 'pass' ? colors.success : colors.destructive, fontFamily: 'Inter_600SemiBold' }}>
                  {session.result === 'pass' ? 'Pass' : 'Fail'}
                </Text>
              </View>
              {!!session.lifeguard_name && <Text style={[styles.detail, { color: colors.mutedForeground }]}>Lifeguard: {session.lifeguard_name}</Text>}
              {session.max_bathers !== null && <Text style={[styles.detail, { color: colors.mutedForeground }]}>Max bathers: {session.max_bathers}</Text>}
              {!!session.notes && <Text style={[styles.detail, { color: colors.mutedForeground }]} numberOfLines={2}>{session.notes}</Text>}
            </View>
          )) : (
            <AquaEmptyState colors={colors} message="No sessions recorded today for this site." />
          )}
      </View>
    </View>
  );
}