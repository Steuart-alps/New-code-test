import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import type { FixTrackIssue } from '@/components/IssueCard';

type IssueStatus = FixTrackIssue['status'];

const PRIORITY_COLOR: Record<string, string> = {
  urgent: '#ef4444',
  high: '#f97316',
  medium: '#f59e0b',
  low: '#94a3b8',
};

const STATUS_TRANSITIONS: Record<IssueStatus, { value: IssueStatus; label: string }[]> = {
  open: [{ value: 'in_progress', label: 'Mark in progress' }],
  in_progress: [{ value: 'resolved', label: 'Mark resolved' }],
  resolved: [],
  closed: [],
};

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  value: string;
}) {
  const colors = useColors();
  return (
    <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
      <Feather name={icon} size={15} color={colors.mutedForeground} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>
          {label}
        </Text>
        <Text style={[styles.detailValue, { color: colors.foreground }]}>
          {value}
        </Text>
      </View>
    </View>
  );
}

export default function IssueDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const router = useRouter();
  const qc = useQueryClient();

  const {
    data: issue,
    isLoading,
    error,
  } = useQuery<FixTrackIssue>({
    queryKey: ['fix-track-issue', id],
    queryFn: () => apiFetch(`/api/fix-track/issues/${id}`),
    enabled: !!id,
  });

  const { mutate: updateStatus, isPending } = useMutation({
    mutationFn: (status: IssueStatus) =>
      apiFetch(`/api/fix-track/issues/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      }),
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['fix-track-issue', id] });
      qc.invalidateQueries({ queryKey: ['fix-track-issues-all'] });
      qc.invalidateQueries({ queryKey: ['fix-track-issues'] });
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message);
    },
  });

  if (isLoading) {
    return (
      <View
        style={[
          styles.center,
          { flex: 1, backgroundColor: colors.background },
        ]}
      >
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (error || !issue) {
    return (
      <View
        style={[
          styles.center,
          { flex: 1, backgroundColor: colors.background },
        ]}
      >
        <Feather name="alert-circle" size={32} color={colors.destructive} />
        <Text style={[styles.errorText, { color: colors.foreground }]}>
          Issue not found
        </Text>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={[{ color: colors.primary, marginTop: 8, fontFamily: 'Inter_500Medium', fontSize: 14 }]}>
            Go back
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  const accentColor = PRIORITY_COLOR[issue.priority] ?? colors.mutedForeground;
  const transitions = STATUS_TRANSITIONS[issue.status] ?? [];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        paddingBottom: Platform.OS === 'web' ? 34 : 24,
      }}
    >
      {/* Header */}
      <View
        style={[
          styles.issueHeader,
          { borderLeftColor: accentColor, backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <View style={styles.issueTitleRow}>
          <Text
            style={[styles.issueTitle, { color: colors.foreground, flex: 1 }]}
          >
            {issue.title}
          </Text>
          <StatusBadge status={issue.status} />
        </View>
        <View style={styles.issueMeta}>
          <StatusBadge status={issue.priority} small />
          <Text
            style={[styles.issueType, { color: colors.mutedForeground }]}
          >
            {issue.issueType.replace(/_/g, ' ')}
          </Text>
        </View>
      </View>

      {/* Details */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
          Details
        </Text>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          {!!issue.siteName && (
            <DetailRow icon="map-pin" label="Site" value={issue.siteName} />
          )}
          {!!issue.assignedTo && (
            <DetailRow icon="user" label="Assigned to" value={issue.assignedTo} />
          )}
          <DetailRow
            icon="clock"
            label="Reported"
            value={new Date(issue.createdAt).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          />
          <DetailRow
            icon="refresh-cw"
            label="Last updated"
            value={new Date(issue.updatedAt).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          />
        </View>
      </View>

      {/* Description / notes */}
      {(issue.description || issue.notes) && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
            Notes
          </Text>
          <View
            style={[
              styles.notesCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.notesText, { color: colors.foreground }]}>
              {issue.description ?? issue.notes}
            </Text>
          </View>
        </View>
      )}

      {/* Status transitions */}
      {transitions.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
            Update status
          </Text>
          {transitions.map((t) => (
            <TouchableOpacity
              key={t.value}
              style={[
                styles.transitionBtn,
                { backgroundColor: colors.navy },
                isPending && { opacity: 0.6 },
              ]}
              onPress={() => updateStatus(t.value)}
              disabled={isPending}
            >
              {isPending ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <>
                  <Feather name="arrow-right" size={16} color="#ffffff" />
                  <Text style={styles.transitionText}>{t.label}</Text>
                </>
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  errorText: { fontSize: 16, fontFamily: 'Inter_600SemiBold', marginTop: 12 },
  issueHeader: {
    margin: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderLeftWidth: 5,
    padding: 16,
  },
  issueTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 10,
  },
  issueTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', lineHeight: 24 },
  issueMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  issueType: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    textTransform: 'capitalize',
  },
  section: { paddingHorizontal: 16, marginBottom: 16 },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  card: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
  },
  detailLabel: { fontSize: 11, fontFamily: 'Inter_400Regular', marginBottom: 2 },
  detailValue: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  notesCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
  },
  notesText: { fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  transitionBtn: {
    height: 50,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 8,
  },
  transitionText: { color: '#ffffff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
});
