import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

export type BadgeStatus =
  | 'ok'
  | 'due_soon'
  | 'overdue'
  | 'never'
  | 'open'
  | 'in_progress'
  | 'resolved'
  | 'closed'
  | 'pass'
  | 'fail'
  | 'action_required'
  | 'urgent'
  | 'high'
  | 'medium'
  | 'low';

const LABELS: Record<BadgeStatus, string> = {
  ok: 'OK',
  due_soon: 'Due soon',
  overdue: 'Overdue',
  never: 'Never',
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
  pass: 'Pass',
  fail: 'Fail',
  action_required: 'Action req.',
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export function StatusBadge({
  status,
  small,
}: {
  status: BadgeStatus;
  small?: boolean;
}) {
  const colors = useColors();

  let bg: string;
  let fg: string;
  switch (status) {
    case 'ok':
    case 'pass':
    case 'resolved':
    case 'closed':
      bg = colors.success;
      fg = colors.successForeground;
      break;
    case 'overdue':
    case 'fail':
    case 'action_required':
    case 'urgent':
      bg = colors.destructive;
      fg = colors.destructiveForeground;
      break;
    case 'due_soon':
    case 'in_progress':
    case 'high':
      bg = colors.warning;
      fg = colors.warningForeground;
      break;
    case 'open':
    case 'medium':
      bg = colors.primary;
      fg = colors.primaryForeground;
      break;
    default:
      bg = colors.muted;
      fg = colors.mutedForeground;
  }

  return (
    <View style={[styles.badge, small && styles.small, { backgroundColor: bg }]}>
      <Text style={[styles.text, small && styles.smallText, { color: fg }]}>
        {LABELS[status] ?? status}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  small: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  text: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  smallText: { fontSize: 10 },
});
