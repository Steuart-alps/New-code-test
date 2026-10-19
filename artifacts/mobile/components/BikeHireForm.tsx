import React, { useState } from 'react';
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import { useAuth } from '@/lib/auth';
import { AquaField, AquaInput, aquaUiStyles as styles } from './aqua-track-ui';
import { BikeCheckItems } from './BikeCheckItems';
import {
  bikeTitle,
  bikeTypeLabel,
  buildHirePayload,
  defaultDepositText,
  defaultExpectedReturn,
  emptyCheckItems,
  localDate,
  type Bike,
  type BikeHireDraft,
} from './bike-track-logic';

const emptyDraft = (config: Record<string, string> | undefined, performedBy: string): BikeHireDraft => ({
  guestName: '',
  guestContact: '',
  hireDate: localDate(),
  // Prefilled from the account's BikeTrack settings, as on the website.
  returnExpected: defaultExpectedReturn(config),
  deposit: defaultDepositText(config),
  check: { skip: false, items: emptyCheckItems(), performedBy, checkNotes: '' },
});

/**
 * The website's "New bike hire": guest details and the pre-ride safety check
 * for one available bike. Saved on the device first, then sent; resent
 * automatically under the same entry ID after a lost connection, so the
 * server never records the hire twice.
 */
export function BikeHireForm({
  bike,
  siteId,
  config,
  onClose,
}: {
  bike: Bike;
  siteId: number | null;
  config: Record<string, string> | undefined;
  onClose: () => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [draft, setDraft] = useState<BikeHireDraft>(() => emptyDraft(config, user?.name ?? ''));
  const set = (key: 'guestName' | 'guestContact' | 'hireDate' | 'returnExpected' | 'deposit') => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const outbox = useRecordOutbox('bike-hire');
  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      outbox.send(payload, `Hire · ${bike.ref} · ${String(payload.guestName)} · ${String(payload.hireDate)}`),
    onSuccess: (outcome) => {
      if (outcome.state === 'rejected') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('Unable to record hire', outcome.error);
        return;
      }
      if (outcome.state === 'queued') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert(
          'Saved on this device',
          `No connection right now. The hire of ${bike.ref} is saved on this device and will be sent automatically when you are back online. Record the return once it has been sent.`,
        );
        onClose();
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      void queryClient.invalidateQueries({ queryKey: ['bike-fleet'] });
      void queryClient.invalidateQueries({ queryKey: ['bike-hires'] });
      Alert.alert('Hire recorded', `${bike.ref} hired to ${draft.guestName.trim()}.`);
      onClose();
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Unable to record hire', error.message);
    },
  });

  function submit() {
    const built = buildHirePayload(draft, bike, siteId);
    if (!built.ok) {
      Alert.alert(built.title, built.message);
      return;
    }
    mutation.mutate(built.payload);
  }

  const pending = mutation.isPending;
  const field = (label: string, key: 'guestName' | 'guestContact' | 'hireDate' | 'returnExpected' | 'deposit', placeholder: string,
    keyboardType?: 'numbers-and-punctuation' | 'decimal-pad') => (
    <AquaField label={label}>
      <AquaInput
        value={draft[key]}
        onChangeText={set(key)}
        placeholder={placeholder}
        keyboardType={keyboardType}
        colors={colors}
        disabled={pending}
        testID={`bike-hire-${key}`}
      />
    </AquaField>
  );

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID="bike-hire-form">
      <Text style={[styles.cardTitle, { color: colors.foreground }]}>Hire out {bikeTitle(bike)}</Text>
      <Text style={[styles.detail, { color: colors.mutedForeground, marginBottom: 12 }]}>{bikeTypeLabel(bike.type)}</Text>
      {field('Guest name', 'guestName', 'Full name')}
      {field('Contact (phone / email)', 'guestContact', '07700 900000 or guest@email.com')}
      <View style={styles.row}>
        <View style={{ flex: 1 }}>{field('Hire date', 'hireDate', 'YYYY-MM-DD', 'numbers-and-punctuation')}</View>
        <View style={{ flex: 1 }}>{field('Expected return', 'returnExpected', 'YYYY-MM-DD', 'numbers-and-punctuation')}</View>
      </View>
      {field('Deposit (£)', 'deposit', 'e.g. 20.00', 'decimal-pad')}
      <BikeCheckItems
        title="Pre-ride safety check"
        check={draft.check}
        onChange={(check) => setDraft((current) => ({ ...current, check }))}
        failMessage="do not hire until resolved; an Action Required item is opened automatically."
        disabled={pending}
        testIDPrefix="bike-hire-check"
      />
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.primaryButton, { flex: 1, backgroundColor: colors.mutedForeground }, pending && styles.disabled]}
          onPress={onClose}
          disabled={pending}
          testID="bike-hire-cancel"
        >
          <Feather name="x" size={18} color="#ffffff" />
          <Text style={styles.primaryButtonText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.primaryButton, { flex: 2, backgroundColor: colors.navy }, pending && styles.disabled]}
          onPress={submit}
          disabled={pending}
          testID="bike-hire-submit"
        >
          {pending ? <ActivityIndicator color="#ffffff" /> : <Feather name="check" size={18} color="#ffffff" />}
          <Text style={styles.primaryButtonText}>{pending ? 'Saving…' : 'Confirm hire'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
