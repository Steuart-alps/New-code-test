import React from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { checkOutbox } from '@/lib/checkOutbox';
import type { CheckEntry } from '@/lib/checkOutboxCore';

/**
 * Records saved on this device that the server has not confirmed yet.
 * Waiting entries are sent automatically (with their original entry ID, so a
 * resend never duplicates a record); "Send now" only nudges that. A rejected
 * entry can be retried unchanged or removed after confirmation.
 */
export function OutboxEntries({ entries, readError }: { entries: CheckEntry[]; readError?: string | null }) {
  const colors = useColors();
  if (!entries.length && !readError) return null;
  const waiting = entries.filter((entry) => entry.state !== 'failed').length;
  const showError = (problem: unknown) =>
    Alert.alert('Could not update the saved record', problem instanceof Error ? problem.message : 'Try again.');
  return (
    <View
      testID="outbox-entries"
      accessibilityRole="summary"
      style={[styles.panel, { backgroundColor: colors.warning + '14', borderColor: colors.warning + '66' }]}
    >
      <View style={styles.headingRow}>
        <Feather name="upload-cloud" size={16} color={colors.warning} />
        <Text style={[styles.heading, { color: colors.foreground }]}>
          {entries.length === 1 ? 'Saved on this device — not confirmed yet' : `${entries.length} saved on this device — not confirmed yet`}
        </Text>
      </View>
      {readError ? <Text style={[styles.meta, { color: colors.destructive }]}>{readError}</Text> : null}
      {waiting > 0 ? (
        <Text style={[styles.meta, { color: colors.mutedForeground }]}>
          These send automatically when you have a connection.
        </Text>
      ) : null}
      {entries.map((entry) => (
        <View key={entry.entryId} testID={`outbox-entry-${entry.entryId}`} style={[styles.row, { borderTopColor: colors.warning + '33' }]}>
          <Text style={[styles.label, { color: colors.foreground }]}>{entry.label}</Text>
          <Text style={[styles.meta, { color: entry.state === 'failed' ? colors.destructive : colors.mutedForeground }]}>
            {entry.state === 'failed'
              ? `Not accepted: ${entry.error ?? 'the server rejected this record.'}`
              : entry.state === 'sending' ? 'Sending…' : `Waiting to send${entry.error ? ` · ${entry.error}` : ''}`}
          </Text>
          <View style={styles.actions}>
            {entry.state === 'failed' ? (
              <>
                <TouchableOpacity
                  testID={`outbox-retry-${entry.entryId}`}
                  accessibilityRole="button"
                  onPress={() => { checkOutbox.retry(entry.entryId).catch(showError); }}
                  style={[styles.button, { backgroundColor: colors.navy }]}
                >
                  <Text style={styles.buttonText}>Retry</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID={`outbox-remove-${entry.entryId}`}
                  accessibilityRole="button"
                  onPress={() => Alert.alert(
                    'Remove this record?',
                    'The server did not accept it. Removing deletes the copy saved on this device.',
                    [
                      { text: 'Keep', style: 'cancel' },
                      { text: 'Remove', style: 'destructive', onPress: () => { checkOutbox.removeFailed(entry.entryId).catch(showError); } },
                    ],
                  )}
                >
                  <Text style={[styles.remove, { color: colors.destructive }]}>Remove</Text>
                </TouchableOpacity>
              </>
            ) : entry.state === 'queued' ? (
              <TouchableOpacity
                testID={`outbox-send-${entry.entryId}`}
                accessibilityRole="button"
                onPress={() => { void checkOutbox.replay(); }}
                style={[styles.button, { backgroundColor: colors.navy }]}
              >
                <Text style={styles.buttonText}>Send now</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderWidth: 1, borderRadius: 8, padding: 12, marginHorizontal: 16, marginVertical: 12, gap: 8 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heading: { fontSize: 14, fontFamily: 'Inter_600SemiBold', flex: 1 },
  row: { borderTopWidth: 1, paddingTop: 8, gap: 4 },
  label: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  meta: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 4 },
  button: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  buttonText: { color: '#ffffff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  remove: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
