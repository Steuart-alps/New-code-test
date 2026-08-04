import React from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { StatusBadge } from './StatusBadge';

export interface FixTrackIssue {
  id: number;
  title: string;
  description: string | null;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority: 'urgent' | 'high' | 'medium' | 'low';
  issueType: string;
  siteId: number | null;
  siteName: string | null;
  notes: string | null;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'Just now';
}

const PRIORITY_ACCENT: Record<string, string> = {
  urgent: '#ef4444',
  high: '#f97316',
  medium: '#f59e0b',
  low: '#94a3b8',
};

export function IssueCard({ issue }: { issue: FixTrackIssue }) {
  const colors = useColors();
  const router = useRouter();
  const accent = PRIORITY_ACCENT[issue.priority] ?? colors.mutedForeground;

  return (
    <TouchableOpacity
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
      onPress={() => router.push(`/issues/${issue.id}` as any)}
      activeOpacity={0.7}
    >
      <View style={[styles.priorityBar, { backgroundColor: accent }]} />
      <View style={styles.body}>
        <View style={styles.top}>
          <Text
            style={[styles.title, { color: colors.foreground }]}
            numberOfLines={1}
          >
            {issue.title}
          </Text>
          <StatusBadge status={issue.status} small />
        </View>
        <View style={styles.meta}>
          <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
            {issue.issueType.replace(/_/g, ' ')}
          </Text>
          {!!issue.siteName && (
            <>
              <Text style={[styles.dot, { color: colors.mutedForeground }]}>
                ·
              </Text>
              <Text
                style={[styles.metaText, { color: colors.mutedForeground }]}
              >
                {issue.siteName}
              </Text>
            </>
          )}
          <Text style={[styles.dot, { color: colors.mutedForeground }]}>·</Text>
          <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
            {timeAgo(issue.createdAt)}
          </Text>
        </View>
      </View>
      <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 8,
  },
  priorityBar: { width: 4, alignSelf: 'stretch' },
  body: { flex: 1, padding: 12 },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  title: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 4,
  },
  metaText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    textTransform: 'capitalize',
  },
  dot: { fontSize: 12 },
});
