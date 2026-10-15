/**
 * Contractors: each contractor's compliance status (insurance, DBS / PVG and
 * Gas Safe, as on the website's Contractors page), a search and the "Missing
 * or expired" filter, and for managers the contractor email approvals queue.
 * Adding, editing, importing and portal invites stay on the website.
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { isConnectionError } from '@/components/outbox-status-logic';
import {
  CONTRACTOR_STATUS_COLOR,
  CONTRACTOR_STATUS_LABEL,
  canApproveContractorEmails,
  contractorListStatus,
  countMissingOrExpired,
  filterContractors,
  normalizeContractors,
  type ContractorRecord,
  type ContractorStatusLevel,
} from '@/components/contractors-logic';

const STATUS_ICON: Record<ContractorStatusLevel, React.ComponentProps<typeof Feather>['name']> = {
  complete: 'check-circle',
  expiring: 'clock',
  'missing-or-expired': 'alert-triangle',
};

export default function ContractorsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [search, setSearch] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const canApprove = canApproveContractorEmails(user?.role);

  const contractorsQuery = useQuery<ContractorRecord[]>({
    queryKey: ['contractors', user?.clientId],
    queryFn: async () => normalizeContractors(await apiFetch('/api/contractors')),
  });
  const approvalsQuery = useQuery<{ count: number }>({
    queryKey: ['contractor-email-queue-count', user?.clientId],
    queryFn: () => apiFetch('/api/fix-track/contractor-email-queue/count'),
    enabled: canApprove,
  });

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([contractorsQuery.refetch(), canApprove ? approvalsQuery.refetch() : Promise.resolve()]);
    } finally {
      setRefreshing(false);
    }
  }

  const now = new Date();
  const contractors = contractorsQuery.data ?? [];
  const filtered = filterContractors(contractors, search, missingOnly, now);
  const missingCount = countMissingOrExpired(contractors, now);
  const pendingApprovals = approvalsQuery.data?.count ?? 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: 40 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.primary} />}
    >
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
        <TouchableOpacity testID="contractors-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
          <Feather name="arrow-left" size={22} color="#ffffff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Contractors</Text>
        <Text style={styles.headerSub}>Insurance, DBS / PVG and certificates: what is expiring or overdue</Text>
      </View>

      <View style={styles.content}>
        {canApprove && (
          <TouchableOpacity
            testID="contractors-approvals"
            accessibilityRole="button"
            style={[styles.card, styles.row, { backgroundColor: colors.card, borderColor: pendingApprovals ? '#2563eb' : colors.border }]}
            onPress={() => router.push('/manage/contractor-approvals' as any)}
            activeOpacity={0.75}
          >
            <View style={[styles.iconWrap, { backgroundColor: '#2563eb1a' }]}>
              <Feather name="mail" size={20} color="#2563eb" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Contractor email approvals</Text>
              <Text style={[styles.cardSub, { color: colors.mutedForeground }]}>
                {approvalsQuery.isLoading ? 'Checking…'
                  : approvalsQuery.isError ? 'Open to review emails waiting to be sent'
                    : pendingApprovals === 0 ? 'Nothing waiting for approval'
                      : `${pendingApprovals} email${pendingApprovals === 1 ? '' : 's'} waiting for approval`}
              </Text>
            </View>
            <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}

        <View style={[styles.searchWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            testID="contractors-search"
            value={search}
            onChangeText={setSearch}
            placeholder="Search contractors..."
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="Search contractors"
            style={[styles.searchInput, { color: colors.foreground }]}
            autoCorrect={false}
          />
        </View>
        <TouchableOpacity
          testID="contractors-missing-filter"
          accessibilityRole="button"
          accessibilityState={{ selected: missingOnly }}
          onPress={() => setMissingOnly((value) => !value)}
          style={[
            styles.filterBtn,
            { borderColor: missingOnly ? colors.navy : colors.border, backgroundColor: missingOnly ? colors.navy : colors.card },
          ]}
        >
          <Feather name="alert-triangle" size={14} color={missingOnly ? '#ffffff' : colors.foreground} />
          <Text style={[styles.filterText, { color: missingOnly ? '#ffffff' : colors.foreground }]}>
            Missing or expired ({missingCount})
          </Text>
        </TouchableOpacity>

        {contractorsQuery.isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
        ) : contractorsQuery.isError ? (
          <View style={styles.empty}>
            <Text role="alert" style={[styles.emptyText, { color: colors.destructive }]}>
              {isConnectionError(contractorsQuery.error)
                ? 'Contractors need a connection to load. Pull down to try again when you have signal.'
                : 'Could not load contractors. Please try again.'}
            </Text>
            <TouchableOpacity accessibilityRole="button" onPress={() => void contractorsQuery.refetch()}>
              <Text style={[styles.link, { color: colors.primary }]}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.empty} testID="contractors-empty">
            <Feather name="briefcase" size={36} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No contractors found</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              {missingOnly ? 'No contractors with missing or expired compliance fields match your search.'
                : search ? 'Try another search.'
                  : 'Contractors are added on the website, where you track their compliance and certificates.'}
            </Text>
          </View>
        ) : filtered.map((contractor) => {
          const status = contractorListStatus(contractor, now);
          const color = CONTRACTOR_STATUS_COLOR[status.level];
          return (
            <TouchableOpacity
              key={contractor.id}
              testID={`contractor-${contractor.id}`}
              accessibilityRole="button"
              accessibilityHint={status.problems.join('. ') || 'All tracked fields are current.'}
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => router.push(`/manage/contractor/${contractor.id}` as any)}
              activeOpacity={0.75}
            >
              <View style={styles.row}>
                <View style={[styles.avatar, { backgroundColor: colors.primary + '1a' }]}>
                  <Text style={[styles.avatarText, { color: colors.navy }]}>{contractor.name.charAt(0).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cardTitle, { color: colors.foreground }]}>{contractor.name}</Text>
                  {contractor.company ? <Text style={[styles.cardSub, { color: colors.mutedForeground }]}>{contractor.company}</Text> : null}
                </View>
                <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
              </View>
              <View style={[styles.badge, { borderColor: color + '55', backgroundColor: color + '14' }]}>
                <Feather name={STATUS_ICON[status.level]} size={13} color={color} />
                <Text style={[styles.badgeText, { color }]}>{CONTRACTOR_STATUS_LABEL[status.level]}</Text>
              </View>
              {status.problems.length > 0 && (
                <View style={{ gap: 2 }}>
                  {status.problems.map((problem) => (
                    <Text key={problem} style={[styles.problem, { color: colors.mutedForeground }]}>• {problem}</Text>
                  ))}
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  back: { marginBottom: 10, alignSelf: 'flex-start', padding: 2 },
  headerTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: '#ffffff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter_400Regular' },
  content: { padding: 16, gap: 12 },
  card: { borderWidth: 1, borderRadius: 8, padding: 14, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconWrap: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 17, fontFamily: 'Inter_700Bold' },
  cardTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
  cardSub: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12 },
  searchInput: { flex: 1, minHeight: 44, fontSize: 15, fontFamily: 'Inter_400Regular' },
  filterBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, minHeight: 36, paddingVertical: 6 },
  filterText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  badge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 5, borderWidth: 1, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  problem: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 32, paddingHorizontal: 12 },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  link: { fontSize: 14, fontFamily: 'Inter_500Medium' },
});
