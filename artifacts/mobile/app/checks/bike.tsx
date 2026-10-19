/**
 * BikeTrack Screen
 * Pick a site, see the fleet and each bike's status, hire a bike out with
 * its pre-ride safety check, record a return and log a service. Hires and
 * services go through the device outbox; a return updates the hire on the
 * server and needs signal. Adding, editing and deleting bikes, settings and
 * the hire register stay on the website.
 * Gated behind hasService("biketrack").
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
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { AquaEmptyState, aquaUiStyles } from '@/components/aqua-track-ui';
import { OutboxEntries } from '@/components/OutboxEntries';
import { BikeHireForm } from '@/components/BikeHireForm';
import { BikeReturnForm } from '@/components/BikeReturnForm';
import { BikeServices } from '@/components/BikeServices';
import {
  activeHiresForSite,
  bikeSiteChoice,
  bikeStatusLabel,
  bikeTitle,
  bikeTypeLabel,
  bikesForSite,
  dayOf,
  isOverdueReturn,
  localDate,
  normalizeBikeHires,
  normalizeLatestServices,
  pendingHireBikeIds,
  serviceDue,
  type Bike,
  type BikeHire,
  type BikeLatestService,
  type BikeSite,
} from '@/components/bike-track-logic';

const MODULE_COLOR = '#0d9488';
type ActiveTab = 'fleet' | 'hires' | 'services';

export default function BikeTrackScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, hasService } = useAuth();
  const serviceEnabled = hasService('biketrack');
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [activeTab, setActiveTab] = useState<ActiveTab>('fleet');
  const [siteId, setSiteId] = useState<number | null>(null);
  const [hireBikeId, setHireBikeId] = useState<number | null>(null);
  const [returnHireId, setReturnHireId] = useState<number | null>(null);
  const [serviceFormOpen, setServiceFormOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const hireOutbox = useRecordOutbox('bike-hire');

  const sitesQuery = useQuery<BikeSite[]>({
    queryKey: ['sites', user?.clientId],
    queryFn: () => apiFetch('/api/sites'),
    enabled: serviceEnabled,
  });
  const bikesQuery = useQuery<Bike[]>({
    queryKey: ['bike-fleet', user?.clientId],
    queryFn: () => apiFetch('/api/bike-track/bikes'),
    enabled: serviceEnabled,
  });
  const hiresQuery = useQuery<BikeHire[]>({
    queryKey: ['bike-hires', user?.clientId],
    queryFn: async () => normalizeBikeHires(await apiFetch('/api/bike-track/hires?status=active')),
    enabled: serviceEnabled,
  });
  const latestServicesQuery = useQuery<BikeLatestService[]>({
    queryKey: ['bike-services-latest', user?.clientId],
    queryFn: async () => normalizeLatestServices(await apiFetch('/api/bike-track/services/latest')),
    enabled: serviceEnabled,
  });
  const configQuery = useQuery<Record<string, string>>({
    queryKey: ['bike-config', user?.clientId],
    queryFn: () => apiFetch('/api/bike-track/config'),
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

  const choice = bikeSiteChoice(siteId, sitesQuery.data);
  const canUseSite = choice.ready && !sitesQuery.isFetching && !sitesQuery.isError;
  const recordSiteId = choice.ready ? choice.siteId : null;

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bike-fleet'] }),
        queryClient.invalidateQueries({ queryKey: ['bike-hires'] }),
        queryClient.invalidateQueries({ queryKey: ['bike-services'] }),
        queryClient.invalidateQueries({ queryKey: ['bike-services-latest'] }),
        queryClient.invalidateQueries({ queryKey: ['bike-config'] }),
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
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>BikeTrack</Text>
        <Text style={[styles.gatedText, { color: colors.mutedForeground }]}>
          BikeTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  const today = localDate();
  const siteBikes = canUseSite ? bikesForSite(bikesQuery.data ?? [], recordSiteId) : [];
  const siteHires = canUseSite ? activeHiresForSite(hiresQuery.data ?? [], bikesQuery.data ?? [], recordSiteId) : [];
  const latestByBike = new Map((latestServicesQuery.data ?? []).map((row) => [Number(row.bike_id), row]));
  const pendingHires = pendingHireBikeIds(hireOutbox.entries);
  const hireBike = siteBikes.find((bike) => bike.id === hireBikeId);
  const returnHire = siteHires.find((hire) => hire.id === returnHireId);
  // A form whose bike or hire is no longer listed (e.g. after a refresh) closes.
  const formOpen = !!hireBike || !!returnHire || serviceFormOpen;
  const count = (status: string) => siteBikes.filter((bike) => bike.status === status).length;
  const overdueReturns = siteHires.filter((hire) => isOverdueReturn(hire, today)).length;

  const statusTone = (status: string) =>
    status === 'available' ? colors.success : status === 'hired' ? colors.primary : status === 'maintenance' ? colors.warning : colors.mutedForeground;

  function renderFleet() {
    if (hireBike) {
      return <BikeHireForm bike={hireBike} siteId={recordSiteId} config={configQuery.data} onClose={() => setHireBikeId(null)} />;
    }
    return (
      <View>
        <OutboxEntries entries={hireOutbox.entries} readError={hireOutbox.readError} />
        {!canUseSite ? <AquaEmptyState colors={colors} message="Select a site to see its bikes." /> :
          bikesQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
          bikesQuery.isError ? (
            <AquaEmptyState colors={colors} error message={bikesQuery.error instanceof Error ? bikesQuery.error.message : 'Bikes could not be loaded.'}>
              <TouchableOpacity onPress={() => void bikesQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
            </AquaEmptyState>
          ) : siteBikes.length ? siteBikes.map((bike) => {
            const due = serviceDue(latestByBike.get(bike.id), today);
            const waiting = pendingHires.has(bike.id);
            const canHire = bike.status === 'available' && !waiting;
            return (
              <View key={bike.id} style={[aquaUiStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`bike-${bike.id}`}>
                <View style={[aquaUiStyles.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                  <Text style={[aquaUiStyles.cardTitle, { color: colors.foreground }]}>{bikeTitle(bike)}</Text>
                  <View style={[aquaUiStyles.badge, { backgroundColor: statusTone(waiting ? 'hired' : bike.status) + '22' }]}>
                    <Text style={[aquaUiStyles.badgeText, { color: statusTone(waiting ? 'hired' : bike.status) }]} testID={`bike-${bike.id}-status`}>
                      {waiting ? 'Hire saved on device' : bikeStatusLabel(bike.status)}
                    </Text>
                  </View>
                </View>
                <Text style={[aquaUiStyles.detail, { color: colors.mutedForeground }]}>
                  {bikeTypeLabel(bike.type)}
                  {due ? ` · Service due ${due.date}` : ''}
                </Text>
                {due?.overdue ? <Text style={[aquaUiStyles.detail, { color: colors.destructive }]}>Service overdue</Text> : null}
                {canHire ? (
                  <TouchableOpacity
                    style={[aquaUiStyles.primaryButton, styles.cardButton, { backgroundColor: colors.navy }, formOpen && aquaUiStyles.disabled]}
                    onPress={() => setHireBikeId(bike.id)}
                    disabled={formOpen}
                    testID={`bike-${bike.id}-hire`}
                  >
                    <Feather name="log-out" size={16} color="#ffffff" />
                    <Text style={aquaUiStyles.primaryButtonText}>Hire out</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          }) : (
            <AquaEmptyState colors={colors} message="No bikes at this site. Add bikes on the website." />
          )}
      </View>
    );
  }

  function renderHires() {
    if (returnHire) return <BikeReturnForm hire={returnHire} onClose={() => setReturnHireId(null)} />;
    return (
      <View>
        <Text style={[styles.note, { color: colors.mutedForeground }]}>
          Returns need signal: they update the hire on the server, so they are not saved on this device.
        </Text>
        {!canUseSite ? <AquaEmptyState colors={colors} message="Select a site to see its hires." /> :
          hiresQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
          hiresQuery.isError ? (
            <AquaEmptyState colors={colors} error message={hiresQuery.error instanceof Error ? hiresQuery.error.message : 'Hires could not be loaded.'}>
              <TouchableOpacity onPress={() => void hiresQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
            </AquaEmptyState>
          ) : siteHires.length ? siteHires.map((hire) => {
            const overdue = isOverdueReturn(hire, today);
            return (
              <View key={hire.id} style={[aquaUiStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`bike-hire-${hire.id}`}>
                <View style={[aquaUiStyles.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                  <Text style={[aquaUiStyles.cardTitle, { color: colors.foreground }]}>
                    {hire.bike_ref}{hire.bike_name ? ` — ${hire.bike_name}` : ''}
                  </Text>
                  {overdue ? (
                    <View style={[aquaUiStyles.badge, { backgroundColor: colors.destructive + '22' }]}>
                      <Text style={[aquaUiStyles.badgeText, { color: colors.destructive }]}>Overdue</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[aquaUiStyles.detail, { color: colors.foreground }]}>{hire.guest_name}{hire.guest_contact ? ` · ${hire.guest_contact}` : ''}</Text>
                <Text style={[aquaUiStyles.detail, { color: colors.mutedForeground }]}>
                  Out {dayOf(hire.hire_date)}{hire.return_date_expected ? ` · due back ${dayOf(hire.return_date_expected)}` : ''}
                  {hire.pre_result ? ` · pre-ride check ${hire.pre_result}` : ''}
                </Text>
                <TouchableOpacity
                  style={[aquaUiStyles.primaryButton, styles.cardButton, { backgroundColor: colors.navy }, formOpen && aquaUiStyles.disabled]}
                  onPress={() => setReturnHireId(hire.id)}
                  disabled={formOpen}
                  testID={`bike-hire-${hire.id}-return`}
                >
                  <Feather name="rotate-ccw" size={16} color="#ffffff" />
                  <Text style={aquaUiStyles.primaryButtonText}>Record return</Text>
                </TouchableOpacity>
              </View>
            );
          }) : (
            <AquaEmptyState colors={colors} message="No bikes out on hire at this site." />
          )}
      </View>
    );
  }

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
              <Feather name="navigation" size={14} color="#5eead4" />
              <Text style={[styles.moduleBadgeText, { color: '#5eead4' }]}>BikeTrack</Text>
            </View>
            <Text style={styles.headerTitle}>Bike Hire</Text>
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
                  testID={`bike-site-${site.id}`}
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
              Choose a site before hiring out a bike or logging a service.
            </Text>
          )}
        </View>
      ) : null}

      {canUseSite && (
        <View style={styles.summaryRow}>
          {([
            { label: 'Available', value: count('available'), tone: colors.foreground, id: 'available' },
            { label: 'On hire', value: count('hired'), tone: colors.foreground, id: 'hired' },
            { label: 'Maintenance', value: count('maintenance'), tone: count('maintenance') ? colors.warning : colors.foreground, id: 'maintenance' },
            { label: 'Overdue', value: overdueReturns, tone: overdueReturns ? colors.destructive : colors.foreground, id: 'overdue' },
          ]).map((card) => (
            <View key={card.id} style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>{card.label}</Text>
              <Text style={[styles.summaryValue, { color: card.tone }]} testID={`bike-summary-${card.id}`}>
                {bikesQuery.isLoading || hiresQuery.isLoading ? '…' : String(card.value)}
              </Text>
            </View>
          ))}
        </View>
      )}

      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        {([
          { key: 'fleet' as const, label: 'Fleet', icon: 'list' as const },
          { key: 'hires' as const, label: 'On hire', icon: 'clock' as const },
          { key: 'services' as const, label: 'Services', icon: 'tool' as const },
        ]).map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tabButton, activeTab === tab.key && { borderBottomColor: colors.primary }, formOpen && styles.disabled]}
            onPress={() => setActiveTab(tab.key)}
            disabled={formOpen}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === tab.key }}
            testID={`bike-tab-${tab.key}`}
          >
            <Feather name={tab.icon} size={16} color={activeTab === tab.key ? colors.primary : colors.mutedForeground} />
            <Text style={[styles.tabLabel, { color: activeTab === tab.key ? colors.primary : colors.mutedForeground }]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.content}>
        {activeTab === 'fleet' ? renderFleet() : activeTab === 'hires' ? renderHires() : (
          <BikeServices bikes={siteBikes} canUseSite={canUseSite} onFormOpenChange={setServiceFormOpen} />
        )}
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          Add, edit or retire bikes, change BikeTrack settings and download the hire register on the website.
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
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16, paddingTop: 16 },
  summaryCard: { flexGrow: 1, flexBasis: '40%', borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
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
  cardButton: { minHeight: 40, marginTop: 10 },
  note: { fontSize: 12, fontFamily: 'Inter_400Regular', marginBottom: 12, lineHeight: 17 },
  hint: { fontSize: 11, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 16, lineHeight: 16 },
});
