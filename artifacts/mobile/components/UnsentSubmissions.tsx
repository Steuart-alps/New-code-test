import React from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { UnsentSubmission } from './unsent-submission-logic';

/**
 * Lists this form's submissions that failed to send and are kept on the
 * device. "Retry" resends the saved request unchanged (or, with
 * `primaryLabel`, reopens it in the form); "Discard" removes the device copy
 * after confirmation.
 */
export function UnsentSubmissions({
  drafts,
  onRetry,
  onDiscard,
  disabled = false,
  primaryLabel = 'Retry',
  note,
}: {
  drafts: UnsentSubmission[];
  onRetry: (draft: UnsentSubmission) => void;
  onDiscard: (draft: UnsentSubmission) => void;
  disabled?: boolean;
  primaryLabel?: string;
  note?: string;
}) {
  const colors = useColors();
  if (!drafts.length) return null;
  return (
    <View
      testID="unsent-submissions"
      style={[styles.panel, { backgroundColor: colors.warning + '14', borderColor: colors.warning + '66' }]}
    >
      <View style={styles.headingRow}>
        <Feather name="alert-circle" size={16} color={colors.warning} />
        <Text style={[styles.heading, { color: colors.foreground }]}>
          {drafts.length === 1 ? 'Not sent — saved on this device' : `${drafts.length} not sent — saved on this device`}
        </Text>
      </View>
      {note ? <Text style={[styles.meta, { color: colors.mutedForeground }]}>{note}</Text> : null}
      {drafts.map((draft) => (
        <View key={draft.id} style={[styles.row, { borderTopColor: colors.warning + '33' }]}>
          <Text style={[styles.label, { color: colors.foreground }]}>{draft.label}</Text>
          <Text style={[styles.meta, { color: colors.mutedForeground }]}>
            Saved {new Date(draft.savedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            {draft.error ? ` · ${draft.error}` : ''}
          </Text>
          <View style={styles.actions}>
            <TouchableOpacity
              testID={`unsent-retry-${draft.id}`}
              disabled={disabled}
              onPress={() => onRetry(draft)}
              style={[styles.button, { backgroundColor: colors.navy }, disabled && { opacity: 0.6 }]}
            >
              <Text style={styles.buttonText}>{primaryLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID={`unsent-discard-${draft.id}`}
              disabled={disabled}
              onPress={() => Alert.alert(
                'Discard this unsent copy?',
                'It has not been confirmed by the server. Discarding removes it from this device.',
                [
                  { text: 'Keep', style: 'cancel' },
                  { text: 'Discard', style: 'destructive', onPress: () => onDiscard(draft) },
                ],
              )}
            >
              <Text style={[styles.discard, { color: colors.destructive }]}>Discard</Text>
            </TouchableOpacity>
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
  discard: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
