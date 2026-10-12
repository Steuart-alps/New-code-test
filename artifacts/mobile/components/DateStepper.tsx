import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { addCalendarDays, describeCheckDate, localIsoDate } from './date-stepper-logic';

/**
 * Pick a calendar date with previous/next-day buttons. Defaults to today in
 * the caller; future dates cannot be chosen because a check cannot have been
 * done yet.
 */
export function DateStepper({
  value,
  onChange,
  testID = 'date-stepper',
}: {
  value: string;
  onChange: (value: string) => void;
  testID?: string;
}) {
  const colors = useColors();
  const today = localIsoDate();
  const canGoForward = value < today;
  return (
    <View style={[styles.row, { borderColor: colors.border, backgroundColor: colors.card }]}>
      <TouchableOpacity
        testID={`${testID}-previous`}
        accessibilityLabel="Previous day"
        style={styles.step}
        onPress={() => onChange(addCalendarDays(value, -1))}
      >
        <Feather name="chevron-left" size={20} color={colors.primary} />
      </TouchableOpacity>
      <View style={styles.center}>
        <Text testID={`${testID}-label`} style={[styles.label, { color: colors.foreground }]}>
          {describeCheckDate(value, today)}
        </Text>
        <Text style={[styles.sub, { color: colors.mutedForeground }]}>{value}</Text>
      </View>
      <TouchableOpacity
        testID={`${testID}-next`}
        accessibilityLabel="Next day"
        disabled={!canGoForward}
        style={[styles.step, !canGoForward && { opacity: 0.3 }]}
        onPress={() => onChange(addCalendarDays(value, 1))}
      >
        <Feather name="chevron-right" size={20} color={colors.primary} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 6, height: 52 },
  step: { width: 48, height: '100%', alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center' },
  label: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  sub: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 1 },
});
