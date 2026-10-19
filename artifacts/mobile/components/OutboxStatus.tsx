import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useCheckOutbox } from '@/lib/checkOutbox';
import { useKitchenOutbox } from '@/lib/kitchenOutbox';
import { KitchenQueueStatus } from './KitchenQueueStatus';
import { OutboxEntries } from './OutboxEntries';
import { outboxSummary } from './outbox-status-logic';

/** Unsent work in both device outboxes (checks/records/actions and KitchenTrack diaries). */
export function useUnsentSummary() {
  const checks = useCheckOutbox();
  const kitchen = useKitchenOutbox();
  const kitchenWaiting = kitchen.entries.filter((entry) => entry.state === 'queued' || entry.state === 'sending').length;
  const kitchenAttention = kitchen.entries.filter((entry) => entry.state === 'failed').length;
  return {
    summary: outboxSummary(checks.entries, kitchenWaiting, kitchenAttention),
    unsent: checks.entries.filter((entry) => entry.state !== 'sent'),
    readError: checks.error,
    hasKitchen: kitchenWaiting + kitchenAttention > 0 || !!kitchen.error,
  };
}

/**
 * The app-wide indicator on the Today screen: how many records are saved on
 * this phone and not yet on the server, and how many need attention. Tapping
 * opens every unsent record with its state, retry and discard.
 */
export function OutboxStatus() {
  const colors = useColors();
  const { summary, unsent, readError, hasKitchen } = useUnsentSummary();
  const [open, setOpen] = useState(false);
  if (!summary.headline && !readError) return null;
  const accent = summary.attention || readError ? colors.destructive : colors.warning;
  return (
    <View style={styles.wrap} testID="outbox-status">
      <TouchableOpacity
        testID="outbox-status-toggle"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${summary.headline ?? 'Saved records could not be read'}. ${open ? 'Hide' : 'Show'} details`}
        onPress={() => setOpen((value) => !value)}
        style={[styles.card, { backgroundColor: accent + '14', borderColor: accent + '66' }]}
      >
        <Feather name={summary.attention || readError ? 'alert-circle' : 'upload-cloud'} size={18} color={accent} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {summary.headline ?? 'Saved records could not be read'}
          </Text>
          <Text style={[styles.meta, { color: colors.mutedForeground }]}>
            {summary.waiting ? 'Sent automatically when you have a connection. ' : ''}Tap to {open ? 'hide' : 'review'}.
          </Text>
        </View>
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.mutedForeground} />
      </TouchableOpacity>
      {open ? (
        <>
          <OutboxEntries entries={unsent} readError={readError} />
          {hasKitchen ? <KitchenQueueStatus /> : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingTop: 16 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 8, padding: 12, marginHorizontal: 16 },
  title: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  meta: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
});
