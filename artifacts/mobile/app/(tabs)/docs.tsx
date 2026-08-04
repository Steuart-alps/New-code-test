import React, { useState } from 'react';
import {
  ActivityIndicator,
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
import { useQuery } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';

type Tab = 'documents' | 'training';

interface DocFile {
  id: number;
  name: string;
  category: string | null;
  createdAt: string;
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

function DocRow({ doc }: { doc: DocFile }) {
  const colors = useColors();
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
          {doc.name}
        </Text>
        {!!doc.category && (
          <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
            {doc.category}
          </Text>
        )}
      </View>
      <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
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
    queryKey: ['doctrack-files'],
    queryFn: () =>
      apiFetch<DocFile[]>('/api/doctrack/files').catch(() => []),
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
            docs.map((doc) => <DocRow key={doc.id} doc={doc} />)
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
