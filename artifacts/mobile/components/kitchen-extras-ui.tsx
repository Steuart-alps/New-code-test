import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { ApiError, apiFetch } from '@/lib/api';

type Colors = ReturnType<typeof useColors>;
type Tone = 'good' | 'bad' | 'neutral';

/** GET a record that may not exist yet: null on 404, other errors thrown. */
export async function fetchOptional<T>(path: string): Promise<T | null> {
  try {
    return await apiFetch<T>(path);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * A row of mutually exclusive answers; tapping the selected one clears it
 * (as on the website).
 */
export function AnswerToggle<V extends string | boolean>({
  options,
  value,
  onChange,
  disabled = false,
  testIDPrefix,
}: {
  options: { value: V; label: string; tone: Tone }[];
  value: V | null | undefined;
  onChange: (value: V | null) => void;
  disabled?: boolean;
  testIDPrefix: string;
}) {
  const colors = useColors();
  const toneColor = (tone: Tone) => tone === 'good' ? colors.success : tone === 'bad' ? colors.destructive : colors.mutedForeground;
  return (
    <View style={styles.toggleRow}>
      {options.map((option) => {
        const selected = value === option.value;
        const tint = toneColor(option.tone);
        return (
          <TouchableOpacity
            key={String(option.value)}
            style={[
              styles.toggle,
              { borderColor: selected ? tint : colors.border, backgroundColor: selected ? tint + '1f' : colors.card },
              disabled && styles.disabled,
            ]}
            onPress={() => onChange(selected ? null : option.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled }}
            accessibilityLabel={option.label}
            testID={`${testIDPrefix}-${String(option.value)}`}
          >
            <Text style={[styles.toggleText, { color: selected ? tint : colors.mutedForeground }]}>{option.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function KitchenNotice({
  icon,
  tone,
  children,
  testID,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  tone: 'success' | 'warning' | 'destructive' | 'info';
  children: React.ReactNode;
  testID?: string;
}) {
  const colors = useColors();
  const tint = tone === 'success' ? colors.success : tone === 'warning' ? colors.warning
    : tone === 'destructive' ? colors.destructive : colors.primary;
  return (
    <View testID={testID} style={[styles.notice, { borderColor: tint + '66', backgroundColor: tint + '14' }]}>
      <Feather name={icon} size={18} color={tint} />
      <Text style={[styles.noticeText, { color: colors.foreground }]}>{children}</Text>
    </View>
  );
}

export function ResultBadge({ result, colors }: { result: string | null | undefined; colors: Colors }) {
  if (result !== 'pass' && result !== 'fail') return null;
  const tint = result === 'pass' ? colors.success : colors.destructive;
  return (
    <View style={[styles.badge, { backgroundColor: tint + '1f' }]}>
      <Text style={[styles.badgeText, { color: tint }]}>{result === 'pass' ? 'Pass' : 'Fail'}</Text>
    </View>
  );
}

export function SubmittedBadge({ submitted, colors }: { submitted: boolean; colors: Colors }) {
  const tint = submitted ? colors.success : colors.warning;
  return (
    <View style={[styles.badge, { backgroundColor: tint + '1f' }]}>
      <Text style={[styles.badgeText, { color: tint }]}>{submitted ? 'Done' : 'Draft'}</Text>
    </View>
  );
}

export const kitchenExtrasStyles = StyleSheet.create({
  sectionTitle: { fontSize: 15, fontFamily: 'Inter_700Bold', marginTop: 8, marginBottom: 4 },
  sectionHint: { fontSize: 12, fontFamily: 'Inter_400Regular', lineHeight: 17, marginBottom: 10 },
  question: { borderTopWidth: 1, paddingVertical: 12, gap: 8 },
  questionLabel: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  questionSub: { fontSize: 12, fontFamily: 'Inter_400Regular', lineHeight: 17 },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, borderTopWidth: 1 },
  historyDate: { flex: 1, fontSize: 13, fontFamily: 'Inter_500Medium' },
  linkButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
  linkText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
});

const styles = StyleSheet.create({
  toggleRow: { flexDirection: 'row', gap: 8 },
  toggle: { flex: 1, minHeight: 40, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  toggleText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  disabled: { opacity: 0.55 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderWidth: 1, borderRadius: 8, padding: 12, marginBottom: 12 },
  noticeText: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 19 },
  badge: { borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 11, fontFamily: 'Inter_500Medium' },
});
