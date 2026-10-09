import React from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { kitchenOutbox, restoreKitchenEntry, useKitchenOutbox } from '@/lib/kitchenOutbox';
import { useQueryClient } from '@tanstack/react-query';

export function KitchenQueueStatus() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { entries, error } = useKitchenOutbox();
  const pending = entries.filter(entry => entry.state !== 'sent' && entry.state !== 'restored');
  const displayed = pending.concat(entries.filter(entry => entry.state === 'sent' || entry.state === 'restored').slice(-2));
  if (!displayed.length && !error) return null;
  const labels = {
    queued: 'Queued — saved on this device',
    sending: 'Sending — device copy retained',
    sent: 'Sent — confirmed by the server',
    failed: 'Failed — needs attention',
    restored: 'Restored for editing — original kept on this device, not sent',
  };
  const showError = (problem: unknown) =>
    Alert.alert('Could not update saved entry', problem instanceof Error ? problem.message : 'Try again.');
  return (
    <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.heading, { color: colors.foreground }]}>KitchenTrack delivery</Text>
      {error ? <Text style={{ color: colors.destructive }}>{error}</Text> : null}
      <ScrollView style={{ maxHeight: 220 }}>
      {displayed.map(entry => (
        <View key={entry.entryId} testID={`kitchen-delivery-${entry.state}`} style={styles.row}>
          <Text style={{ color: colors.foreground }}>{labels[entry.state]}</Text>
          <Text style={{ color: colors.mutedForeground }}>
            {entry.recordDate} · {entry.siteId === null ? 'Organisation diary' : `Site ${entry.siteId}`}
          </Text>
          {entry.error ? <Text style={{ color: colors.mutedForeground }}>{entry.error}</Text> : null}
          <TouchableOpacity onPress={() => {
            const values = (entry.body.mobileTemperatureLog ?? entry.body) as Record<string, unknown>;
            const detail = Object.entries(values)
              .filter(([key]) => !key.startsWith('expected') && !key.startsWith('mobile'))
              .map(([key, value]) => `${key}:\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
              .join('\n\n');
            Alert.alert(`Saved readings · ${entry.recordDate}`, detail);
          }}>
            <Text style={{ color: colors.primary }}>View saved readings</Text>
          </TouchableOpacity>
          {entry.state === 'queued' ? (
            <Text style={{ color: colors.mutedForeground }}>Retries while this app is open and connected, or on your next sign-in. Only this account can send it.</Text>
          ) : null}
          {entry.state === 'failed' ? (
            <View style={styles.actions}>
              <TouchableOpacity onPress={() => void kitchenOutbox.retry(entry.entryId).catch(showError)}>
                <Text style={{ color: colors.primary }}>Retry saved entry</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="kitchen-restore-entry" onPress={() => Alert.alert(
                'Edit these readings?',
                'The rejected readings open as a draft on the latest diary and temperature controls, so you can correct them before saving again. The original device copy is kept and will not be sent.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Edit as new entry', onPress: () => {
                    void restoreKitchenEntry(entry.entryId).then(async () => {
                      await queryClient.invalidateQueries({ queryKey: ['food-safety'] });
                    }).catch(showError);
                  } },
                ],
              )}>
                <Text style={{ color: colors.primary }}>Edit as new entry</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => Alert.alert(
                'Remove saved device copy?',
                'This removes the unsent device copy. Any record already accepted by the server will remain. Re-enter the readings after reviewing today’s diary.',
                [
                  { text: 'Keep entry', style: 'cancel' },
                  { text: 'Remove copy', style: 'destructive', onPress: () => {
                    void kitchenOutbox.removeFailed(entry.entryId).then(async () => {
                      await queryClient.invalidateQueries({ queryKey: ['food-safety'] });
                    }).catch(showError);
                  } },
                ],
              )}>
                <Text style={{ color: colors.destructive }}>Remove device copy</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      ))}
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  panel: { borderWidth: 1, padding: 12, margin: 12, gap: 10, borderRadius: 8 },
  heading: { fontFamily: 'Inter_600SemiBold', fontSize: 15 },
  row: { gap: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, paddingVertical: 8 },
});