import React, { useRef } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { checkOutbox, useCheckOutbox } from '@/lib/checkOutbox';
import type { CheckEntry } from '@/lib/checkOutboxCore';
import { entryStatus, rememberWaiting, syncedEntries, type OutboxTone } from './outbox-status-logic';

/**
 * Records saved on this device that the server has not confirmed yet, with
 * one of four states: saved on this phone (waiting), syncing, synced, or a
 * conflict / rejection. Waiting entries are sent automatically (with their
 * original entry ID, so a resend never duplicates a record); "Send now" only
 * nudges that. A rejected entry shows the server's reason and can be retried
 * unchanged or discarded after confirmation. Entries this screen saw waiting
 * stay listed as synced once delivered.
 */
export function OutboxEntries({ entries, readError }: { entries: CheckEntry[]; readError?: string | null }) {
  const colors = useColors();
  const snapshot = useCheckOutbox();
  const seen = useRef<Set<string> | null>(null);
  const firstRender = seen.current === null;
  if (!seen.current) seen.current = new Set();
  rememberWaiting(seen.current, entries, firstRender);
  const synced = syncedEntries(seen.current, snapshot.entries).slice(0, 5);
  if (!entries.length && !synced.length && !readError) return null;
  const waiting = entries.filter((entry) => entry.state !== 'failed').length;
  const attention = entries.length - waiting;
  const allSynced = !entries.length && !readError;
  const tone = (value: OutboxTone) => (
    value === 'synced' ? colors.success
      : value === 'conflict' || value === 'rejected' ? colors.destructive
        : colors.mutedForeground
  );
  const accent = allSynced ? colors.success : attention ? colors.destructive : colors.warning;
  const showError = (problem: unknown) =>
    Alert.alert('Could not update the saved record', problem instanceof Error ? problem.message : 'Try again.');
  const heading = allSynced
    ? (synced.length === 1 ? 'Synced — saved on the server' : `${synced.length} synced — saved on the server`)
    : entries.length === 1 ? 'Saved on this phone — not on the server yet' : `${entries.length} saved on this phone — not on the server yet`;
  return (
    <View
      testID="outbox-entries"
      accessibilityRole="summary"
      style={[styles.panel, { backgroundColor: accent + '14', borderColor: accent + '66' }]}
    >
      <View style={styles.headingRow}>
        <Feather name={allSynced ? 'check-circle' : 'upload-cloud'} size={16} color={accent} />
        <Text style={[styles.heading, { color: colors.foreground }]}>{heading}</Text>
      </View>
      {readError ? <Text style={[styles.meta, { color: colors.destructive }]}>{readError}</Text> : null}
      {waiting > 0 ? (
        <Text style={[styles.meta, { color: colors.mutedForeground }]}>
          These send automatically when you have a connection.
        </Text>
      ) : null}
      {entries.concat(synced).map((entry) => {
        const status = entryStatus(entry);
        const problem = status.tone === 'conflict' || status.tone === 'rejected';
        return (
          <View key={entry.entryId} testID={`outbox-entry-${entry.entryId}`} style={[styles.row, { borderTopColor: accent + '33' }]}>
            <Text style={[styles.label, { color: colors.foreground }]}>{entry.label}</Text>
            <View style={styles.statusRow}>
              {status.tone === 'synced' ? <Feather name="check" size={13} color={colors.success} /> : null}
              <Text testID={`outbox-state-${entry.entryId}`} style={[styles.status, { color: tone(status.tone) }]}>{status.title}</Text>
            </View>
            {status.detail ? (
              <Text style={[styles.meta, { color: problem ? colors.destructive : colors.mutedForeground }]}>{status.detail}</Text>
            ) : null}
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
                      'Discard this record?',
                      status.tone === 'conflict'
                        ? 'The server already holds a different record for this. Discarding deletes the copy saved on this phone; record it again if it is still needed.'
                        : 'The server did not accept it. Discarding deletes the copy saved on this phone.',
                      [
                        { text: 'Keep', style: 'cancel' },
                        { text: 'Discard', style: 'destructive', onPress: () => { checkOutbox.removeFailed(entry.entryId).catch(showError); } },
                      ],
                    )}
                  >
                    <Text style={[styles.remove, { color: colors.destructive }]}>Discard</Text>
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
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderWidth: 1, borderRadius: 8, padding: 12, marginHorizontal: 16, marginVertical: 12, gap: 8 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heading: { fontSize: 14, fontFamily: 'Inter_600SemiBold', flex: 1 },
  row: { borderTopWidth: 1, paddingTop: 8, gap: 4 },
  label: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  status: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  meta: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 4 },
  button: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  buttonText: { color: '#ffffff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  remove: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
