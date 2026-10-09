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
import { PoolChecks } from '@/components/PoolChecks';
import { Sessions } from '@/components/Sessions';
import { AquaEmptyState } from '@/components/aqua-track-ui';
import { aquaTrackAccess, hasSelectedAquaSite } from '@/components/aqua-track-logic';
import type { Site } from '@/components/aqua-track-types';

type ActiveTab = 'pool' | 'sessions';

export default function AquaTrackScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { hasService } = useAuth();
  const access = aquaTrackAccess(hasService);
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [activeTab, setActiveTab] = useState<ActiveTab>(access.pool ? 'pool' : 'sessions');
  const [siteId, setSiteId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();
  const sitesQuery = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
    enabled: access.any,
  });

  useEffect(() => {
    if (!sitesQuery.data) return;
    if (sitesQuery.data.length === 1 && siteId !== sitesQuery.data[0].id) {
      setSiteId(sitesQuery.data[0].id);
    } else if (siteId !== null && !sitesQuery.data.some((site) => site.id === siteId)) {
      setSiteId(null);
    }
  }, [siteId, sitesQuery.data]);
  const canUseSite =
    !sitesQuery.isLoading &&
    !sitesQuery.isFetching &&
    !sitesQuery.isError &&
    hasSelectedAquaSite(siteId, sitesQuery.data);

  useEffect(() => {
    if (!access.pool && access.sessions && activeTab !== 'sessions') setActiveTab('sessions');
    if (!access.sessions && access.pool && activeTab !== 'pool') setActiveTab('pool');
  }, [access.pool, access.sessions, activeTab]);

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['pool-checks'] }),
        queryClient.invalidateQueries({ queryKey: ['swim-sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['sites'] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  if (!access.any) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>AquaTrack</Text>
        <Text style={[styles.gatedText, { color: colors.mutedForeground }]}>
          AquaTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 40 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.primary} />}
    >
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 16 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
            <Feather name="arrow-left" size={22} color={colors.primaryForeground} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={[styles.moduleBadge, { backgroundColor: colors.primary + '22' }]}>
              <Feather name="droplet" size={14} color={colors.primary} />
              <Text style={[styles.moduleBadgeText, { color: colors.primary }]}>AquaTrack</Text>
            </View>
            <Text style={[styles.headerTitle, { color: colors.primaryForeground }]}>Pool &amp; Swim Management</Text>
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
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
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
                  testID={`aqua-site-${site.id}`}
                >
                  <Text style={[styles.siteChipText, { color: siteId === site.id ? colors.primary : colors.mutedForeground }]}>
                    {site.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
          {sitesQuery.data.length > 1 && !hasSelectedAquaSite(siteId, sitesQuery.data) && (
            <Text style={[styles.siteChipText, { color: colors.mutedForeground }]}>
              Choose a site before logging a pool check or session.
            </Text>
          )}
        </View>
      ) : (
        <View style={styles.siteSection}>
          <AquaEmptyState colors={colors} message="No sites are available for AquaTrack." />
        </View>
      )}

      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        {access.pool && (
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'pool' && { borderBottomColor: colors.primary }]}
            onPress={() => setActiveTab('pool')}
            disabled={formOpen}
            testID="aqua-tab-pool"
          >
            <Feather name="droplet" size={16} color={activeTab === 'pool' ? colors.primary : colors.mutedForeground} />
            <Text style={[styles.tabLabel, { color: activeTab === 'pool' ? colors.primary : colors.mutedForeground }]}>Pool Checks</Text>
          </TouchableOpacity>
        )}
        {access.sessions && (
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'sessions' && { borderBottomColor: colors.primary }]}
            onPress={() => setActiveTab('sessions')}
            disabled={formOpen}
            testID="aqua-tab-sessions"
          >
            <Feather name="users" size={16} color={activeTab === 'sessions' ? colors.primary : colors.mutedForeground} />
            <Text style={[styles.tabLabel, { color: activeTab === 'sessions' ? colors.primary : colors.mutedForeground }]}>Sessions</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.content}>
        {activeTab === 'pool' && access.pool ? (
          <PoolChecks siteId={siteId} canUseSite={canUseSite} onFormOpenChange={setFormOpen} />
        ) : access.sessions ? (
          <Sessions siteId={siteId} canUseSite={canUseSite} onFormOpenChange={setFormOpen} />
        ) : (
          <AquaEmptyState colors={colors} message="This section is not enabled for your account." />
        )}
      </View>
    </ScrollView>
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
  headerTitle: { fontSize: 17, fontFamily: 'Inter_700Bold', textAlign: 'center' },
  siteSection: { paddingHorizontal: 16, paddingTop: 16, gap: 8 },
  sectionTitle: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  siteRow: { flexDirection: 'row', gap: 8 },
  siteChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  siteChipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  disabled: { opacity: 0.5 },
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
});