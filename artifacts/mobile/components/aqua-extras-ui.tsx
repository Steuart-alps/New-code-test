import React from 'react';
import { Alert, Text } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import type { AquaSendOutcome } from '@/hooks/useAquaRecordSender';
import { aquaUiStyles as styles } from './aqua-track-ui';

/** Tells staff whether this record can be saved without signal. */
export function AquaRouteNote({ route }: { route: 'outbox' | 'direct' }) {
  const colors = useColors();
  return (
    <Text style={[styles.detail, { color: colors.mutedForeground, marginTop: -4, marginBottom: 12 }]}>
      {route === 'outbox'
        ? 'No signal? The record is saved on this device and sent automatically when you are back online.'
        : 'Your account requires photos for this record, so saving needs a connection. Without signal your answers and photos stay here to try again.'}
    </Text>
  );
}

/**
 * Feedback for a send. Returns whether the form is finished with (sent, or
 * saved on the device); a rejection or expired photos keep the draft open.
 */
export async function notifyAquaOutcome(outcome: AquaSendOutcome, noun: string, failTitle: string): Promise<boolean> {
  switch (outcome.state) {
    case 'rejected':
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert(failTitle, outcome.error);
      return false;
    case 'kept':
      return false;
    case 'queued':
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      Alert.alert('Saved on this device', `No connection right now. The ${noun} is saved on this device and will be sent automatically when you are back online.`);
      return true;
    case 'sent':
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      Alert.alert('Logged', `${noun.charAt(0).toUpperCase()}${noun.slice(1)} recorded successfully.`);
      return true;
  }
}
