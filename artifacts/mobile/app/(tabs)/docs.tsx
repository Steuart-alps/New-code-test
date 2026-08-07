import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';

type Tab = 'documents' | 'training';

interface DocFile {
  id: number;
  title: string;
  category: string | null;
  requires_acknowledgement?: boolean;
  created_at: string;
}

interface Acknowledgement {
  id: number;
  document_id: number;
  staff_roster_id: number | null;
  staff_name: string;
  acknowledged_at: string;
}

interface TrainingRecord {
  id: number;
  staffName: string;
  courseName: string;
  completedAt: string | null;
  expiresAt: string | null;
  status: 'valid' | 'expiring_soon' | 'expired';
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

function formatCategory(category: string | null): string {
  if (!category) return '';
  return category
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function DocRow({ doc }: { doc: DocFile }) {
  const colors = useColors();
  const qc = useQueryClient();
  const { user } = useAuth();

  const requiresAck = !!doc.requires_acknowledgement;

  const { data: acks = [] } = useQuery<Acknowledgement[]>({
    queryKey: ['doc-acks', doc.id],
    enabled: requiresAck,
    queryFn: () =>
      apiFetch<Acknowledgement[]>(
        `/api/doc-track/documents/${doc.id}/acknowledgements`,
      ).catch(() => []),
  });

  // Identity is derived server-side; the client no longer picks a roster entry.
  // Determine whether *this* user has already acknowledged by matching the
  // recorded staff_name (case-insensitive) against the signed-in user's name.
  const alreadyAcknowledged = !!user && acks.some(
    (a) => a.staff_name.trim().toLowerCase() === user.name.trim().toLowerCase(),
  );

  const { mutate: acknowledge, isPending } = useMutation({
    mutationFn: () =>
      apiFetch(`/api/doc-track/documents/${doc.id}/acknowledge`, {
        method: 'POST',
        // Acknowledge as self — the server resolves identity from the session
        // and only honors an optional signature.
        body: JSON.stringify({ signature: user?.name ?? null }),
      }),
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['doc-acks', doc.id] });
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message);
    },
  });

  function handleAcknowledge() {
    Alert.alert(
      'Acknowledge document',
      `Confirm you have read and understood "${doc.title}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Acknowledge', onPress: () => acknowledge() },
      ],
    );
  }

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={[styles.rowIcon, { backgroundColor: colors.primary + '1a' }]}>
        <Feather name="file-text" size={18} color={colors.primary} />
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: colors.foreground }]}>
          {doc.title}
        </Text>
        {!!doc.category && (
          <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
            {formatCategory(doc.category)}
          </Text>
        )}
        {requiresAck &&
          (alreadyAcknowledged ? (
            <View style={styles.ackDone}>
              <Feather name="check-circle" size={13} color={colors.success} />
              <Text style={[styles.ackDoneText, { color: colors.success }]}>
                Acknowledged
              </Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.ackBtn, { backgroundColor: colors.navy }]}
              onPress={handleAcknowledge}
              disabled={isPending}
              activeOpacity={0.8}
            >
              {isPending ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <>
                  <Feather name="check" size={13} color="#ffffff" />
                  <Text style={styles.ackBtnText}>Acknowledge</Text>
                </>
              )}
            </TouchableOpacity>
          ))}
      </View>
    </View>
  );
}

function TrainingRow({ record }: { record: TrainingRecord }) {
  const colors = useColors();
  const days = daysUntil(record.expiresAt);
  let accent = colors.success;
  let expLabel = record.expiresAt
    ? `Expires in ${days} days`
    : 'No expiry';
  if (!record.completedAt) {
    expLabel = 'Not completed';
    accent = colors.mutedForeground;
  } else if (record.status === 'expired' || (days !== null && days < 0)) {
    expLabel = 'Expired';
    accent = colors.destructive;
  } else if (record.status === 'expiring_soon' || (days !== null && days <= 30)) {
    accent = colors.warning;
    expLabel = `Expires in ${days} days`;
  }

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={[styles.rowIcon, { backgroundColor: accent + '1a' }]}>
        <Feather name="award" size={18} color={accent} />
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: colors.foreground }]}>
          {record.courseName}
        </Text>
        <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
          {record.staffName}
        </Text>
        <Text style={[styles.rowBadge, { color: accent }]}>{expLabel}</Text>
      </View>
    </View>
  );
}

export default function DocsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('documents');
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const {
    data: docs = [],
    isLoading: docsLoading,
    refetch: refetchDocs,
    isRefetching: docsRefetching,
  } = useQuery<DocFile[]>({
    queryKey: ['doctrack-documents'],
    queryFn: () =>
      apiFetch<DocFile[]>('/api/doc-track/documents').catch(() => []),
  });

  const {
    data: training = [],
    isLoading: trainingLoading,
    refetch: refetchTraining,
    isRefetching: trainingRefetching,
  } = useQuery<TrainingRecord[]>({
    queryKey: ['traintrack-records'],
    queryFn: () =>
      apiFetch<TrainingRecord[]>('/api/traintrack/staff').catch(() => []),
  });

  const isLoading = tab === 'documents' ? docsLoading : trainingLoading;
  const isRefreshing =
    tab === 'documents' ? docsRefetching : trainingRefetching;
  const onRefresh =
    tab === 'documents' ? refetchDocs : refetchTraining;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: colors.navy, paddingTop: topPad + 16 },
        ]}
      >
        <Text style={styles.headerTitle}>Documents &amp; Training</Text>

        {/* Tab bar */}
        <View
          style={[styles.tabBar, { backgroundColor: 'rgba(255,255,255,0.1)' }]}
        >
          {(['documents', 'training'] as Tab[]).map((t) => (
            <TouchableOpacity
              key={t}
              style={[
                styles.tabItem,
                tab === t && { backgroundColor: '#ffffff' },
              ]}
              onPress={() => setTab(t)}
            >
              <Text
                style={[
                  styles.tabText,
                  {
                    color:
                      tab === t ? colors.navy : 'rgba(255,255,255,0.7)',
                  },
                ]}
              >
                {t === 'documents' ? 'Documents' : 'Training'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Content */}
      <ScrollView
        contentContainerStyle={[
          styles.list,
          { paddingBottom: Platform.OS === 'web' ? 34 : 16 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={!!isRefreshing}
            onRefresh={() => { onRefresh(); }}
            tintColor={colors.primary}
          />
        }
      >
        {isLoading ? (
          <ActivityIndicator
            color={colors.primary}
            style={{ marginTop: 48 }}
          />
        ) : tab === 'documents' ? (
          docs.length === 0 ? (
            <View
              style={[
                styles.empty,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Feather name="folder" size={32} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                No documents
              </Text>
              <Text
                style={[styles.emptyText, { color: colors.mutedForeground }]}
              >
                Upload documents in DocTrack on the web app
              </Text>
            </View>
          ) : (
            docs.map((doc) => (
              <DocRow key={doc.id} doc={doc} />
            ))
          )
        ) : training.length === 0 ? (
          <View
            style={[
              styles.empty,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <Feather name="book-open" size={32} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
              No training records
            </Text>
            <Text
              style={[styles.emptyText, { color: colors.mutedForeground }]}
            >
              Add training records in TrainTrack on the web app
            </Text>
          </View>
        ) : (
          training.map((r) => <TrainingRow key={r.id} record={r} />)
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingBottom: 16 },
  headerTitle: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    color: '#ffffff',
    marginBottom: 16,
  },
  tabBar: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 3,
  },
  tabItem: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  tabText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  list: { padding: 16, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 12,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
  rowSub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  ackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
  },
  ackBtnText: { color: '#ffffff', fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  ackDone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
  },
  ackDoneText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  rowBadge: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    marginTop: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  empty: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 32,
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  emptyText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
  },
});
