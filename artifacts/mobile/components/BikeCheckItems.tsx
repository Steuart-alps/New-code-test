import React from 'react';
import { StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { AquaField, AquaInput } from './aqua-track-ui';
import { CHECK_ITEMS, overallResult, type BikeCheckDraft, type CheckValue } from './bike-track-logic';

const VALUES: { value: CheckValue; label: string }[] = [
  { value: 'pass', label: 'Pass' },
  { value: 'fail', label: 'Fail' },
  { value: 'na', label: 'N/A' },
];

/**
 * The website's bike safety checklist (pre-hire or post-return): each item
 * pass / fail / N/A, who checked, notes, and the overall result. The check can
 * be skipped, as on the website.
 */
export function BikeCheckItems({
  title,
  check,
  onChange,
  failMessage,
  disabled,
  testIDPrefix,
}: {
  title: string;
  check: BikeCheckDraft;
  onChange: (check: BikeCheckDraft) => void;
  failMessage: string;
  disabled: boolean;
  testIDPrefix: string;
}) {
  const colors = useColors();
  const result = overallResult(check.items);
  return (
    <View style={styles.section}>
      <View style={styles.headingRow}>
        <Text style={[styles.heading, { color: colors.foreground }]}>{title}</Text>
        <View style={styles.skipRow}>
          <Text style={[styles.skipText, { color: colors.mutedForeground }]}>Skip check</Text>
          <Switch
            value={check.skip}
            onValueChange={(skip) => onChange({ ...check, skip })}
            disabled={disabled}
            testID={`${testIDPrefix}-skip`}
          />
        </View>
      </View>
      {check.skip ? (
        <Text style={[styles.note, { color: colors.mutedForeground, borderColor: colors.border }]}>
          No safety check will be recorded.
        </Text>
      ) : (
        <>
          <AquaField label="Checked by">
            <AquaInput
              value={check.performedBy}
              onChangeText={(performedBy) => onChange({ ...check, performedBy })}
              placeholder="Name"
              colors={colors}
              disabled={disabled}
              testID={`${testIDPrefix}-performed-by`}
            />
          </AquaField>
          <View style={[styles.items, { borderColor: colors.border }]}>
            {CHECK_ITEMS.map((item) => (
              <View key={item.key} style={styles.itemRow}>
                <Text style={[styles.itemLabel, { color: colors.foreground }]}>{item.label}</Text>
                <View style={styles.values}>
                  {VALUES.map((option) => {
                    const selected = check.items[item.key] === option.value;
                    const tone = option.value === 'pass' ? colors.success : option.value === 'fail' ? colors.destructive : colors.mutedForeground;
                    return (
                      <TouchableOpacity
                        key={option.value}
                        style={[
                          styles.value,
                          { borderColor: selected ? tone : colors.border, backgroundColor: selected ? tone : colors.card },
                          disabled && styles.disabled,
                        ]}
                        onPress={() => onChange({ ...check, items: { ...check.items, [item.key]: option.value } })}
                        disabled={disabled}
                        accessibilityRole="radio"
                        accessibilityLabel={`${item.label}: ${option.label}`}
                        accessibilityState={{ checked: selected, disabled }}
                        testID={`${testIDPrefix}-${item.key}-${option.value}`}
                      >
                        <Text style={[styles.valueText, { color: selected ? '#ffffff' : colors.mutedForeground }]}>{option.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ))}
          </View>
          <AquaField label="Check notes">
            <AquaInput
              value={check.checkNotes}
              onChangeText={(checkNotes) => onChange({ ...check, checkNotes })}
              placeholder="Any issues found, corrective actions…"
              multiline
              colors={colors}
              disabled={disabled}
              testID={`${testIDPrefix}-notes`}
            />
          </AquaField>
          <Text
            style={[
              styles.result,
              result === 'pass'
                ? { color: colors.success, borderColor: colors.success + '66', backgroundColor: colors.success + '14' }
                : { color: colors.destructive, borderColor: colors.destructive + '66', backgroundColor: colors.destructive + '14' },
            ]}
            testID={`${testIDPrefix}-result`}
          >
            {result === 'pass' ? 'Overall result: Pass' : `Overall result: Fail — ${failMessage}`}
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 14 },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  heading: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  skipRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  skipText: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  note: { fontSize: 13, fontFamily: 'Inter_400Regular', borderWidth: 1, borderStyle: 'dashed', borderRadius: 8, padding: 12 },
  items: { borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 14, gap: 10 },
  itemRow: { gap: 6 },
  itemLabel: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  values: { flexDirection: 'row', gap: 8 },
  value: { flex: 1, borderWidth: 1, borderRadius: 6, paddingVertical: 8, alignItems: 'center' },
  valueText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  disabled: { opacity: 0.55 },
  result: { fontSize: 13, fontFamily: 'Inter_600SemiBold', borderWidth: 1, borderRadius: 8, padding: 10 },
});
