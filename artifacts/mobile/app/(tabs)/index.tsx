import React, { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
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
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { IssueCard, type FixTrackIssue } from '@/components/IssueCard';

interface Site {
  id: number;
  name: string;
}

interface CheckStatus {
  checkType: string;
  status: 'ok' | 'due_soon' | 'overdue' | 'never';
  lastDate: string | null;
  dueDate: string | null;
  lastResult?: string | null;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function ModuleStatusCard({
  label,
  icon,
  statuses,
  onPress,
  summaryOverride,
}: {
  label: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  statuses: CheckStatus[];
  onPress?: () => void;
  summaryOverride?: string;
}) {
  const colors = useColors();
  const overdue = statuses.filter((s) => s.status === 'overdue').length;
  const due = statuses.filter((s) => s.status === 'due_soon').length;
  const all = statuses.length;
  const ok = statuses.filter((s) => s.status === 'ok').length;
  const failed = statuses.filter((s) => s.lastResult === 'fail' || s.lastResult === 'action_required').length;

  let bg = colors.card;
  let accent = colors.success;
  let label2 = summaryOverride ?? (all > 0 ? `${ok}/${all} OK` : 'No checks');

  if (overdue > 0) {
    bg = '#fef2f2';
    accent = colors.destructive;
    label2 = summaryOverride ?? `${overdue} overdue`;
  } else if (due > 0) {
    bg = '#fffbeb';
    accent = colors.warning;
    label2 = summaryOverride ?? `${due} due soon`;
  }
  if (failed > 0 && !summaryOverride) {
    bg = '#fff7ed';
    accent = colors.warning;
    label2 = `${failed} warning${failed === 1 ? '' : 's'}`;
  }

  return (
    <TouchableOpacity
      testID={`dashboard-module-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}
      style={[styles.moduleCard, { backgroundColor: bg, borderColor: colors.border }]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <View style={[styles.moduleIconWrap, { backgroundColor: accent + '22' }]}>
        <Feather name={icon} size={20} color={accent} />
      </View>
      <Text style={[styles.moduleLabel, { color: colors.foreground }]}>
        {label}
      </Text>
      <Text style={[styles.moduleStatus, { color: accent }]}>{label2}</Text>
    </TouchableOpacity>
  );
}

export default function TodayScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const [selectedSiteId, setSelectedSiteId] = useState<number | undefined>();

  const { data: sites } = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
  });

  const { data: fireStatus = [], refetch: refetchFire } = useQuery<CheckStatus[]>({
    queryKey: ['fire-status', selectedSiteId],
    queryFn: () =>
      apiFetch(
        `/api/fire-safety/status${selectedSiteId ? `?siteId=${selectedSiteId}` : ''}`,
      ),
  });
  const today = new Date().toISOString().slice(0, 10);
  const { data: kitchenToday } = useQuery<{ submittedAt: string | null } | null>({
    queryKey: ['food-safety', 'today-status', selectedSiteId, today],
    queryFn: async () => {
      try {
        return await apiFetch(`/api/food-safety/by-date/${today}${selectedSiteId ? `?siteId=${selectedSiteId}` : ''}`);
      } catch {
        return null;
      }
    },
  });
  type DailyPeriod = 'am' | 'pm';
  interface DailyOverviewItem { siteId: number; am: { submitted: boolean } | null; pm: { submitted: boolean } | null; }
  interface DailyOverview { sites: DailyOverviewItem[]; enabledTypes: DailyPeriod[]; }
  const { data: dailyOverview } = useQuery<DailyOverview>({
    queryKey: ['daily-overview', selectedSiteId, today],
    queryFn: () => apiFetch(`/api/daily-checklists/overview?date=${today}`),
  });

  const { data: waterStatus = [], refetch: refetchWater } = useQuery<CheckStatus[]>({
    queryKey: ['water-status', selectedSiteId],
    queryFn: () =>
      apiFetch(
        `/api/legionella/status${selectedSiteId ? `?siteId=${selectedSiteId}` : ''}`,
      ),
  });
  const { data: hotTubStatus = [], refetch: refetchHotTub } = useQuery<CheckStatus[]>({
    queryKey: ['hot-tub-status', selectedSiteId],
    queryFn: () =>
      apiFetch(
        `/api/hot-tub/status${selectedSiteId ? `?siteId=${selectedSiteId}` : ''}`,
      ),
  });

  const { data: issues, isLoading: issuesLoading, refetch: refetchIssues } = useQuery<
    FixTrackIssue[]
  >({
    queryKey: ['fix-track-issues', selectedSiteId],
    queryFn: () =>
      apiFetch(
        `/api/fix-track/issues?status=reported&status=in_progress${selectedSiteId ? `&siteId=${selectedSiteId}` : ''}`,
      ),
    placeholderData: [],
  });

  const [refreshing, setRefreshing] = useState(false);
  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([refetchFire(), refetchWater(), refetchHotTub(), refetchIssues()]);
    setRefreshing(false);
  }

  const recentIssues = (issues ?? []).slice(0, 4);
  const selectedSite = sites?.find((s) => s.id === selectedSiteId);
  const relevantDailySites = selectedSite
    ? (dailyOverview?.sites ?? []).filter((site) => site.siteId === selectedSite.id)
    : (dailyOverview?.sites ?? []);
  // The API scopes both sites and available periods to the user/client. An
  // unpurchased AM or PM service is not a missed DailyTrack check.
  const enabledDailyPeriods = dailyOverview?.enabledTypes ?? [];
  const dailyTotal = relevantDailySites.length * enabledDailyPeriods.length;
  const dailyCompleted = relevantDailySites.reduce(
    (count, site) => count + enabledDailyPeriods.filter((period) => site[period]?.submitted).length,
    0,
  );
  const currentHour = new Date().getHours();
  const missingDailyPeriods = relevantDailySites.flatMap((site) =>
    enabledDailyPeriods.filter((period) => !site[period]?.submitted),
  );
  const dailyStatuses: CheckStatus[] = missingDailyPeriods.map((period, index) => ({
    checkType: `daily-${period}-${index}`,
    status: currentHour >= 18 || (currentHour >= 12 && period === 'am') ? 'overdue' : 'due_soon',
    lastDate: null,
    dueDate: today,
  }));
  const kitchenSummary = kitchenToday?.submittedAt ? 'Signed off today' : kitchenToday ? 'Diary in progress' : 'No diary today';
  const topPad =
    Platform.OS === 'web' ? 67 : insets.top;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 24 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
    >
      {/* Dark header */}
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 16 }]}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.headerGreeting}>
              {greeting()}, {user?.name?.split(' ')[0] ?? 'there'}
            </Text>
            <Text style={styles.headerDate}>
              {new Date().toLocaleDateString('en-GB', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.logCheckBtn}
            onPress={() => router.push('/checks' as any)}
          >
            <Feather name="plus" size={18} color={colors.navy} />
          </TouchableOpacity>
        </View>

        {/* Site selector */}
        {(sites?.length ?? 0) > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.siteScroll}
            contentContainerStyle={{ gap: 8, paddingRight: 16 }}
          >
            <TouchableOpacity
              style={[
                styles.siteChip,
                !selectedSiteId && styles.siteChipActive,
                { borderColor: selectedSiteId ? 'rgba(255,255,255,0.3)' : colors.primary },
              ]}
              onPress={() => setSelectedSiteId(undefined)}
            >
              <Text style={[styles.siteChipText, !selectedSiteId && { color: colors.primary }]}>
                All sites
              </Text>
            </TouchableOpacity>
            {sites?.map((site) => (
              <TouchableOpacity
                key={site.id}
                style={[
                  styles.siteChip,
                  selectedSiteId === site.id && styles.siteChipActive,
                  {
                    borderColor:
                      selectedSiteId === site.id
                        ? colors.primary
                        : 'rgba(255,255,255,0.3)',
                  },
                ]}
                onPress={() =>
                  setSelectedSiteId(
                    selectedSiteId === site.id ? undefined : site.id,
                  )
                }
              >
                <Text
                  style={[
                    styles.siteChipText,
                    selectedSiteId === site.id && { color: colors.primary },
                  ]}
                >
                  {site.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>

      {/* Module status cards */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
          Compliance status
        </Text>
        <View style={styles.moduleGrid}>
          <ModuleStatusCard
            label="FireTrack"
            icon="alert-triangle"
            statuses={fireStatus}
            onPress={() => router.push(`/controls/fire${selectedSiteId ? `?siteId=${selectedSiteId}` : ''}` as any)}
          />
          <ModuleStatusCard
            label="LegionellaTrack"
            icon="droplet"
            statuses={waterStatus}
            onPress={() => router.push(`/controls/water${selectedSiteId ? `?siteId=${selectedSiteId}` : ''}` as any)}
          />
          <ModuleStatusCard
            label="HotTubTrack"
            icon="droplet"
            statuses={hotTubStatus}
            onPress={() => router.push('/checks/hot-tub' as any)}
          />
          <ModuleStatusCard
            label="KitchenTrack"
            icon="thermometer"
            statuses={kitchenToday ? [{ checkType: 'diary', status: kitchenToday.submittedAt ? 'ok' : 'due_soon', lastDate: today, dueDate: today }] : [{ checkType: 'diary', status: currentHour >= 18 ? 'overdue' : 'due_soon', lastDate: null, dueDate: today }]}
            summaryOverride={kitchenSummary}
            onPress={() => router.push('/checks/kitchen' as any)}
          />
          <ModuleStatusCard
            label="DailyTrack"
            icon="clipboard"
            statuses={dailyStatuses}
            summaryOverride={dailyTotal ? `${dailyCompleted}/${dailyTotal} complete` : 'No sites'}
            onPress={() => router.push('/checks/daily' as any)}
          />
        </View>
      </View>

      {/* Recent issues */}
      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
            Open issues
          </Text>
          <TouchableOpacity onPress={() => router.push('/(tabs)/issues' as any)}>
            <Text style={[styles.seeAll, { color: colors.primary }]}>
              See all
            </Text>
          </TouchableOpacity>
        </View>

        {issuesLoading ? (
          <ActivityIndicator
            color={colors.primary}
            style={{ marginTop: 16 }}
          />
        ) : recentIssues.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="check-circle" size={24} color={colors.success} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No open issues
            </Text>
          </View>
        ) : (
          recentIssues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} />
          ))
        )}
      </View>

      {/* Quick actions */}
      <View style={[styles.section, styles.actionsRow]}>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: colors.navy }]}
          onPress={() => router.push('/(tabs)/checks' as any)}
        >
          <Feather name="check-square" size={18} color="#ffffff" />
          <Text style={styles.actionBtnText}>Log check</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: colors.primary }]}
          onPress={() => router.push('/issues/new' as any)}
        >
          <Feather name="tool" size={18} color="#ffffff" />
          <Text style={styles.actionBtnText}>Report issue</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  headerGreeting: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    color: '#ffffff',
    marginBottom: 2,
  },
  headerDate: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.6)',
    fontFamily: 'Inter_400Regular',
  },
  logCheckBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  siteScroll: { marginTop: 4 },
  siteChip: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  siteChipActive: {},
  siteChipText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: 'rgba(255,255,255,0.7)',
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 12,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  seeAll: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  moduleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  moduleCard: {
    width: '48%',
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    gap: 6,
  },
  moduleIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moduleLabel: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textAlign: 'center',
  },
  moduleStatus: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    textAlign: 'center',
  },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular' },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
    paddingBottom: 8,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 4,
    gap: 8,
  },
  actionBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
});
