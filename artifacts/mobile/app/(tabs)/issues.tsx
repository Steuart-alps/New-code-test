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
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';
import { IssueCard, type FixTrackIssue } from '@/components/IssueCard';

type Filter = 'all' | 'open' | 'in_progress' | 'urgent';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'urgent', label: 'Urgent' },
];

export default function IssuesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const {
    data: issues = [],
    isLoading,
    refetch,
    isRefetching,
  } = useQuery<FixTrackIssue[]>({
    queryKey: ['fix-track-issues-all'],
    queryFn: () => apiFetch('/api/fix-track/issues'),
  });

  const filtered = issues.filter((issue) => {
    if (filter === 'all') return true;
    if (filter === 'urgent') return issue.priority === 'urgent';
    return issue.status === filter;
  });

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: colors.navy, paddingTop: topPad + 16 },
        ]}
      >
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.headerTitle}>Issues</Text>
            <Text style={styles.headerSub}>
              {issues.length} total
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.fab, { backgroundColor: '#ffffff' }]}
            onPress={() => router.push('/issues/new' as any)}
          >
            <Feather name="plus" size={20} color={colors.navy} />
          </TouchableOpacity>
        </View>

        {/* Filter chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {FILTERS.map((f) => (
            <TouchableOpacity
              key={f.id}
              style={[
                styles.filterChip,
                filter === f.id
                  ? { backgroundColor: colors.primary }
                  : { backgroundColor: 'rgba(255,255,255,0.12)' },
              ]}
              onPress={() => setFilter(f.id)}
            >
              <Text
                style={[
                  styles.filterText,
                  { color: filter === f.id ? '#ffffff' : 'rgba(255,255,255,0.7)' },
                ]}
              >
                {f.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* List */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: Platform.OS === 'web' ? 34 : 16 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.primary}
          />
        }
      >
        {isLoading ? (
          <ActivityIndicator
            color={colors.primary}
            style={{ marginTop: 48 }}
          />
        ) : filtered.length === 0 ? (
          <View
            style={[
              styles.empty,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <Feather name="check-circle" size={32} color={colors.success} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
              No issues
            </Text>
            <Text
              style={[styles.emptyText, { color: colors.mutedForeground }]}
            >
              {filter === 'all'
                ? 'No maintenance issues logged yet'
                : `No ${filter.replace('_', ' ')} issues`}
            </Text>
          </View>
        ) : (
          filtered.map((issue) => (
            <IssueCard key={issue.id} issue={issue} />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingBottom: 16 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  headerTitle: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    color: '#ffffff',
    marginBottom: 2,
  },
  headerSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.6)',
    fontFamily: 'Inter_400Regular',
  },
  fab: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterRow: { gap: 8, paddingRight: 4 },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
  },
  filterText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
  list: { padding: 16 },
  empty: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 32,
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  emptyTitle: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
  },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
