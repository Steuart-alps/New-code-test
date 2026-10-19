import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { humanise } from './compliance-actions-logic';

const SEVERITY_TONE: Record<string, string> = {
  urgent: '#ef4444',
  critical: '#ef4444',
  high: '#ef4444',
  action_required: '#d97706',
  medium: '#d97706',
  monitor: '#64748b',
  low: '#64748b',
};

/** A small pill, tinted by tone. */
export function ActionBadge({ label, tone, testID }: { label: string; tone?: string; testID?: string }) {
  const colors = useColors();
  const color = tone ?? colors.mutedForeground;
  return (
    <View testID={testID} style={[styles.badge, { backgroundColor: color + '1a', borderColor: color + '55' }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <ActionBadge label={humanise(severity)} tone={SEVERITY_TONE[severity]} />;
}

const styles = StyleSheet.create({
  badge: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
});
