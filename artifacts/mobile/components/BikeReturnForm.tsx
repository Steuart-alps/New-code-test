import React, { useState } from 'react';
import { ActivityIndicator, Alert, Switch, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { AquaField, AquaInput, aquaUiStyles as styles } from './aqua-track-ui';
import { BikeCheckItems } from './BikeCheckItems';
import {
  RETURN_NEEDS_SIGNAL,
  buildReturnPayload,
  dayOf,
  emptyCheckItems,
  isConnectionFailure,
  localDate,
  type BikeHire,
  type BikeReturnDraft,
} from './bike-track-logic';

/**
 * The website's "Return bike": return date, deposit, notes and the
 * post-return safety check. A return updates the existing hire on the server,
 * so it is sent straight away and never saved on the device: without signal
 * nothing is recorded, the form keeps the details and says so.
 */
export function BikeReturnForm({ hire, onClose }: { hire: BikeHire; onClose: () => void }) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [draft, setDraft] = useState<BikeReturnDraft>(() => ({
    returnDate: localDate(),
    depositReturned: false,
    notes: '',
    check: { skip: false, items: emptyCheckItems(), performedBy: user?.name ?? '', checkNotes: '' },
  }));

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch<{ bikeStatus?: string }>(`/api/bike-track/hires/${hire.id}/return`, { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (result) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      void queryClient.invalidateQueries({ queryKey: ['bike-fleet'] });
      void queryClient.invalidateQueries({ queryKey: ['bike-hires'] });
      Alert.alert('Bike returned', result?.bikeStatus === 'maintenance'
        ? `${hire.bike_ref} marked for maintenance — the post-return check had issues.`
        : `${hire.bike_ref} is now available.`);
      onClose();
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      if (isConnectionFailure(error)) {
        Alert.alert('Needs signal', RETURN_NEEDS_SIGNAL);
        return;
      }
      // e.g. "Hire already returned" after a response was lost: show the
      // server's current hires.
      void queryClient.invalidateQueries({ queryKey: ['bike-hires'] });
      void queryClient.invalidateQueries({ queryKey: ['bike-fleet'] });
      Alert.alert('Unable to record return', error.message);
    },
  });

  function submit() {
    const built = buildReturnPayload(draft);
    if (!built.ok) {
      Alert.alert(built.title, built.message);
      return;
    }
    mutation.mutate(built.payload);
  }

  const pending = mutation.isPending;
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID="bike-return-form">
      <Text style={[styles.cardTitle, { color: colors.foreground }]}>
        Return {hire.bike_ref}{hire.bike_name ? ` — ${hire.bike_name}` : ''}
      </Text>
      <Text style={[styles.detail, { color: colors.mutedForeground }]}>Hired by {hire.guest_name} on {dayOf(hire.hire_date)}</Text>
      {hire.deposit_pence ? (
        <Text style={[styles.detail, { color: colors.mutedForeground }]}>Deposit: £{(hire.deposit_pence / 100).toFixed(2)}</Text>
      ) : null}
      <View style={[styles.row, { alignItems: 'center', marginVertical: 12 }]}>
        <Feather name="wifi" size={14} color={colors.warning} />
        <Text style={[styles.detail, { flex: 1, marginTop: 0, color: colors.mutedForeground }]}>
          Returns need signal: they update the hire on the server and are not saved on this device.
        </Text>
      </View>
      <AquaField label="Return date">
        <AquaInput
          value={draft.returnDate}
          onChangeText={(returnDate) => setDraft((current) => ({ ...current, returnDate }))}
          placeholder="YYYY-MM-DD"
          keyboardType="numbers-and-punctuation"
          colors={colors}
          disabled={pending}
          testID="bike-return-date"
        />
      </AquaField>
      {hire.deposit_pence ? (
        <View style={[styles.row, { alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>Deposit returned</Text>
          <Switch
            value={draft.depositReturned}
            onValueChange={(depositReturned) => setDraft((current) => ({ ...current, depositReturned }))}
            disabled={pending}
            testID="bike-return-deposit"
          />
        </View>
      ) : null}
      <AquaField label="Return notes">
        <AquaInput
          value={draft.notes}
          onChangeText={(notes) => setDraft((current) => ({ ...current, notes }))}
          placeholder="Any damage, issues, or comments…"
          multiline
          colors={colors}
          disabled={pending}
          testID="bike-return-notes"
        />
      </AquaField>
      <BikeCheckItems
        title="Post-return safety check"
        check={draft.check}
        onChange={(check) => setDraft((current) => ({ ...current, check }))}
        failMessage="the bike will be moved to maintenance and an Action Required item is opened automatically."
        disabled={pending}
        testIDPrefix="bike-return-check"
      />
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.primaryButton, { flex: 1, backgroundColor: colors.mutedForeground }, pending && styles.disabled]}
          onPress={onClose}
          disabled={pending}
          testID="bike-return-cancel"
        >
          <Feather name="x" size={18} color="#ffffff" />
          <Text style={styles.primaryButtonText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.primaryButton, { flex: 2, backgroundColor: colors.navy }, pending && styles.disabled]}
          onPress={submit}
          disabled={pending}
          testID="bike-return-submit"
        >
          {pending ? <ActivityIndicator color="#ffffff" /> : <Feather name="rotate-ccw" size={18} color="#ffffff" />}
          <Text style={styles.primaryButtonText}>{pending ? 'Sending…' : 'Confirm return'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
