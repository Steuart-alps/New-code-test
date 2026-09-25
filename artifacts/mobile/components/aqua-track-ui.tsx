import React from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

type AquaColors = ReturnType<typeof useColors>;

export function AquaField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const colors = useColors();
  return (
    <View style={aquaUiStyles.field}>
      <Text style={[aquaUiStyles.label, { color: colors.foreground }]}>{label}</Text>
      {children}
    </View>
  );
}

export function AquaInput({
  value,
  onChangeText,
  placeholder,
  colors,
  keyboardType,
  multiline = false,
  disabled = false,
  testID,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  colors: AquaColors;
  keyboardType?: 'default' | 'decimal-pad' | 'number-pad' | 'numbers-and-punctuation';
  multiline?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <TextInput
      style={[
        aquaUiStyles.input,
        multiline && aquaUiStyles.textArea,
        { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card },
        disabled && aquaUiStyles.disabled,
      ]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.mutedForeground}
      keyboardType={keyboardType}
      multiline={multiline}
      numberOfLines={multiline ? 3 : undefined}
      textAlignVertical={multiline ? 'top' : 'center'}
      editable={!disabled}
      testID={testID}
    />
  );
}

export function AquaChoiceRow({
  label,
  options,
  value,
  onChange,
  colors,
  testIDPrefix,
  disabled = false,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  colors: AquaColors;
  testIDPrefix: string;
  disabled?: boolean;
}) {
  return (
    <AquaField label={label}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={aquaUiStyles.choiceRow}>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <TouchableOpacity
                key={option.value}
                style={[
                  aquaUiStyles.choice,
                  {
                    borderColor: selected ? colors.primary : colors.border,
                    backgroundColor: selected ? colors.primary + '1a' : colors.card,
                  },
                  disabled && aquaUiStyles.disabled,
                ]}
                onPress={() => onChange(option.value)}
                disabled={disabled}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled }}
                testID={`${testIDPrefix}-${option.value}`}
              >
                <Text style={[aquaUiStyles.choiceText, { color: selected ? colors.primary : colors.mutedForeground }]}>
                  {option.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>
    </AquaField>
  );
}

export function AquaEmptyState({
  message,
  error = false,
  children,
  colors,
}: {
  message: string;
  error?: boolean;
  children?: React.ReactNode;
  colors: AquaColors;
}) {
  return (
    <View style={[aquaUiStyles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[aquaUiStyles.emptyText, { color: error ? colors.destructive : colors.mutedForeground }]}>{message}</Text>
      {children}
    </View>
  );
}

export const aquaUiStyles = StyleSheet.create({
  field: { marginBottom: 14 },
  label: { fontSize: 13, fontFamily: 'Inter_600SemiBold', marginBottom: 7 },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 13,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  textArea: { height: 82, paddingTop: 12 },
  choiceRow: { flexDirection: 'row', gap: 8, paddingBottom: 1 },
  choice: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 13, paddingVertical: 9 },
  choiceText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  disabled: { opacity: 0.55 },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 20,
    alignItems: 'center',
    gap: 9,
  },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  row: { flexDirection: 'row', gap: 10 },
  badge: { borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 11, fontFamily: 'Inter_500Medium' },
  card: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 9 },
  cardTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  detail: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 5 },
  primaryButton: {
    minHeight: 48,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 15,
  },
  primaryButtonText: { color: '#ffffff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
});