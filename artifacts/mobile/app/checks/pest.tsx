/**
 * PestTrack Screen
 * Pick a site, log pest activity (sightings) and contractor visits, and see
 * recent records. Configuration, edits and the register stay on the website.
 * Gated behind hasService("pesttrack").
 */
import React, { useEffect, useState } from 'react';
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { AquaEmptyState } from '@/components/aqua-track-ui';
import { PestActivityLog } from '@/components/PestActivityLog';
import { PestVisits } from '@/components/PestVisits';
import {
  localDate,
  nextPestVisit,
  pestRecordsForSite,
  pestSiteChoice,
  type PestActivity,
  type PestSite,
  type PestVisit,
} from '@/components/pest-track-logic';

const MODULE_COLOR = '#b45309';
type ActiveTab = 'activity' | 'visits';

export default function PestTrackScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, hasService } = useAuth();
  const serviceEnabled = hasService('pesttrack');
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [activeTab, setActiveTab] = useState<ActiveTab>('activity');
  const [siteId, setSiteId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const sitesQuery = useQuery<PestSite[]>({
    queryKey: ['sites', user?.clientId],
    queryFn: () => apiFetch('/api/sites'),
    enabled: serviceEnabled,
  });
  const activityQuery = useQuery<PestActivity[]>({
    queryKey: ['pest-activity', user?.clientId],
    queryFn: () => apiFetch('/api/pest-track/activity'),
    enabled: serviceEnabled,
  });
  const visitsQuery = useQuery<PestVisit[]>({
    queryKey: ['pest-visits', user?.clientId],
    queryFn: () => apiFetch('/api/pest-track/visits'),
    enabled: serviceEnabled,
  });

  useEffect(() => {
    if (!sitesQuery.data) return;
    if (sitesQuery.data.length === 1 && siteId !== sitesQuery.data[0].id) {
      setSiteId(sitesQuery.data[0].id);
    } else if (siteId !== null && !sitesQuery.data.some((site) => site.id === siteId)) {
      setSiteId(null);
    }
  }, [siteId, sitesQuery.data]);

  const choice = pestSiteChoice(siteId, sitesQuery.data);
  const canUseSite = choice.ready && !sitesQuery.isFetching && !sitesQuery.isError;
  const recordSiteId = choice.ready ? choice.siteId : null;

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['pest-activity'] }),
        queryClient.invalidateQueries({ queryKey: ['pest-visits'] }),
        queryClient.invalidateQueries({ queryKey: ['pest-config'] }),
        queryClient.invalidateQueries({ queryKey: ['sites'] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  if (!serviceEnabled) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>PestTrack</Text>
        <Text style={[styles.gatedText, { color: colors.mutedForeground }]}>
          PestTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  const openActivity = canUseSite
    ? pestRecordsForSite(activityQuery.data ?? [], recordSiteId).filter((row) => !row.resolved).length
    : null;
  const nextVisit = canUseSite ? nextPestVisit(pestRecordsForSite(visitsQuery.data ?? [], recordSiteId), localDate()) : null;

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 40 }}
      bottomOffset={20}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.primary} />}
    >
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 16 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
            <Feather name="arrow-left" size={22} color="#ffffff" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={[styles.moduleBadge, { backgroundColor: MODULE_COLOR + '33' }]}>
              <Feather name="crosshair" size={14} color="#fbbf24" />
              <Text style={[styles.moduleBadgeText, { color: '#fbbf24' }]}>PestTrack</Text>
            </View>
            <Text style={styles.headerTitle}>Pest Control</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
      </View>

      {sitesQuery.isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 16 }} />
      ) : sitesQuery.isError ? (
        <View style={styles.siteSection}>
          <AquaEmptyState
            colors={colors}
            error
            message={sitesQuery.error instanceof Error ? sitesQuery.error.message : 'Sites could not be loaded.'}
          >
            <TouchableOpacity onPress={() => void sitesQuery.refetch()}>
              <Text style={{ color: colors.primary }}>Retry loading sites</Text>
            </TouchableOpacity>
          </AquaEmptyState>
        </View>
      ) : sitesQuery.data?.length ? (
        <View style={styles.siteSection}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Site</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <View style={styles.siteRow}>
              {sitesQuery.data.map((site) => (
                <TouchableOpacity
                  key={site.id}
                  style={[
                    styles.siteChip,
                    {
                      borderColor: siteId === site.id ? colors.primary : colors.border,
                      backgroundColor: siteId === site.id ? colors.primary + '1a' : colors.card,
                    },
                    (formOpen || sitesQuery.isFetching) && styles.disabled,
                  ]}
                  onPress={() => setSiteId(site.id)}
                  disabled={formOpen || sitesQuery.isFetching}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: siteId === site.id }}
                  testID={`pest-site-${site.id}`}
                >
                  <Text style={[styles.siteChipText, { color: siteId === site.id ? colors.primary : colors.mutedForeground }]}>
                    {site.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
          {!choice.ready && (
            <Text style={[styles.siteChipText, { color: colors.mutedForeground }]}>
              Choose a site before logging pest activity or a contractor visit.
            </Text>
          )}
        </View>
      ) : null}

      {canUseSite && (
        <View style={styles.summaryRow}>
          <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Open activity</Text>
            <Text style={[styles.summaryValue, { color: openActivity ? colors.warning : colors.foreground }]} testID="pest-open-activity">
              {activityQuery.isLoading ? '…' : String(openActivity ?? 0)}
            </Text>
          </View>
          <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Next contractor visit</Text>
            <Text style={[styles.summaryValue, { color: nextVisit?.overdue ? colors.destructive : colors.foreground }]} testID="pest-next-visit">
              {visitsQuery.isLoading ? '…' : nextVisit ? `${nextVisit.date}${nextVisit.overdue ? ' · overdue' : ''}` : 'Not scheduled'}
            </Text>
          </View>
        </View>
      )}

      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        {([
          { key: 'activity' as const, label: 'Activity', icon: 'alert-circle' as const },
          { key: 'visits' as const, label: 'Contractor visits', icon: 'calendar' as const },
        ]).map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tabButton, activeTab === tab.key && { borderBottomColor: colors.primary }, formOpen && styles.disabled]}
            onPress={() => setActiveTab(tab.key)}
            disabled={formOpen}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === tab.key }}
            testID={`pest-tab-${tab.key}`}
          >
            <Feather name={tab.icon} size={16} color={activeTab === tab.key ? colors.primary : colors.mutedForeground} />
            <Text style={[styles.tabLabel, { color: activeTab === tab.key ? colors.primary : colors.mutedForeground }]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.content}>
        {activeTab === 'activity' ? (
          <PestActivityLog siteId={recordSiteId} canUseSite={canUseSite} onFormOpenChange={setFormOpen} />
        ) : (
          <PestVisits siteId={recordSiteId} canUseSite={canUseSite} onFormOpenChange={setFormOpen} />
        )}
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          Edit records, change PestTrack settings and download the register on the website.
        </Text>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  gated: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
  gatedTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', textAlign: 'center' },
  gatedText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 20 },
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerCenter: { alignItems: 'center', gap: 6 },
  moduleBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  moduleBadgeText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  headerTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: '#ffffff' },
  siteSection: { paddingHorizontal: 16, paddingTop: 16, gap: 8 },
  sectionTitle: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  siteRow: { flexDirection: 'row', gap: 8 },
  siteChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  siteChipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  disabled: { opacity: 0.5 },
  summaryRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 16 },
  summaryCard: { flex: 1, borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
  summaryLabel: { fontSize: 11, fontFamily: 'Inter_500Medium' },
  summaryValue: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  tabBar: { flexDirection: 'row', borderBottomWidth: 1, marginTop: 16, marginHorizontal: 16 },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabLabel: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  content: { paddingHorizontal: 16, paddingTop: 16 },
  hint: { fontSize: 11, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 16, lineHeight: 16 },
});
