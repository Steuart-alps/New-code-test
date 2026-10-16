import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { useActionSites, useHubActions, useModuleActions } from '@/hooks/useManageActions';
import { AquaChoiceRow, AquaEmptyState } from '@/components/aqua-track-ui';
import { ActionBadge, SeverityBadge } from '@/components/ActionBadges';
import { isConnectionError } from '@/components/outbox-status-logic';
import { localIsoDate } from '@/components/date-stepper-logic';
import {
  ALL, DEFAULT_FILTERS, countHubActions, countModuleActions, filterHubActions, filterModuleActions,
  formatDay, hubStatusLabel, hubTrackOptions, humanise, isOverdue, moduleLabel, moduleTrackOptions,
  reconcileFilters, siteFilterOptions, type ActionFilters,
} from '@/components/compliance-actions-logic';

type Tab = 'module' | 'hub';

// Open actions on the phone: each track's module actions and the Compliance
// Hub's corrective actions. Creating actions, resolved history and templates
// stay on the website.
export default function ManageActionsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();
  const { user } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const today = localIsoDate();
  const [tab, setTab] = useState<Tab>(params.tab === 'hub' ? 'hub' : 'module');
  const [moduleFilters, setModuleFilters] = useState<ActionFilters>(DEFAULT_FILTERS);
  const [hubFilters, setHubFilters] = useState<ActionFilters>(DEFAULT_FILTERS);

  const moduleQuery = useModuleActions();
  const hubQuery = useHubActions();
  const sitesQuery = useActionSites();
  const moduleActions = moduleQuery.data ?? [];
  const hubActions = hubQuery.data ?? [];
  const sites = sitesQuery.data ?? [];

  const moduleTracks = useMemo(() => moduleTrackOptions(moduleActions), [moduleActions]);
  const moduleSites = useMemo(() => siteFilterOptions(moduleActions, sites), [moduleActions, sites]);
  const hubTracks = useMemo(() => hubTrackOptions(hubActions), [hubActions]);
  useEffect(() => { setModuleFilters((f) => reconcileFilters(f, moduleTracks, moduleSites)); }, [moduleTracks, moduleSites]);
  useEffect(() => { setHubFilters((f) => reconcileFilters(f, hubTracks, [])); }, [hubTracks]);

  const moduleCounts = countModuleActions(moduleActions, today);
  const hubCounts = countHubActions(hubActions, today);
  const shownModule = filterModuleActions(moduleActions, moduleFilters, today);
  const shownHub = filterHubActions(hubActions, hubFilters, today);
  const query = tab === 'module' ? moduleQuery : hubQuery;
  const filters = tab === 'module' ? moduleFilters : hubFilters;
  const setFilters = tab === 'module' ? setModuleFilters : setHubFilters;
  const trackOptions = tab === 'module' ? moduleTracks : hubTracks;
  const siteName = (id: number | null | undefined) => sites.find((site) => site.id === id)?.name;
  const viewer = user?.role === 'client_viewer';

  const refresh = () => {
    void moduleQuery.refetch();
    void hubQuery.refetch();
    void sitesQuery.refetch();
  };

  const open = (kind: Tab, id: number) => router.push({ pathname: '/manage/action', params: { kind, id: String(id) } } as any);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={refresh} tintColor="#ffffff" />}
    >
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
        <TouchableOpacity testID="actions-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
          <Feather name="arrow-left" size={22} color="#ffffff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Actions</Text>
        <Text style={styles.headerSub}>
          {viewer ? 'Open corrective actions (view only)' : 'Open corrective actions to update, close or send to FixTrack'}
        </Text>
        <View style={styles.tabs}>
          {([
            { key: 'module', label: 'Module actions', counts: moduleCounts },
            { key: 'hub', label: 'Corrective actions', counts: hubCounts },
          ] as const).map((item) => {
            const selected = tab === item.key;
            return (
              <TouchableOpacity
                key={item.key}
                testID={`actions-tab-${item.key}`}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => setTab(item.key)}
                style={[styles.tab, selected && styles.tabSelected]}
              >
                <Text style={[styles.tabText, { color: selected ? colors.navy : '#ffffff' }]}>
                  {item.label}{item.counts.open ? ` (${item.counts.open})` : ''}
                </Text>
                {item.counts.overdue > 0 && (
                  <Text style={[styles.tabSub, { color: selected ? colors.destructive : '#fca5a5' }]}>{item.counts.overdue} overdue</Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View style={styles.content}>
        <Text style={[styles.intro, { color: colors.mutedForeground }]}>
          {tab === 'module'
            ? 'Corrective actions raised from each track stay with its operational records.'
            : 'Compliance Hub actions. A different client admin or consultant must verify closure after evidence is recorded.'}
        </Text>

        {trackOptions.length > 1 && (
          <AquaChoiceRow
            label="Track"
            options={[{ value: ALL, label: 'All tracks' }, ...trackOptions]}
            value={filters.track}
            onChange={(track) => setFilters((f) => ({ ...f, track }))}
            colors={colors}
            testIDPrefix={`actions-${tab}-track`}
          />
        )}
        {tab === 'module' && moduleSites.length > 0 && (
          <AquaChoiceRow
            label="Site"
            options={[{ value: ALL, label: 'All sites' }, ...moduleSites]}
            value={moduleFilters.site}
            onChange={(site) => setModuleFilters((f) => ({ ...f, site }))}
            colors={colors}
            testIDPrefix="actions-module-site"
          />
        )}
        <AquaChoiceRow
          label="Due"
          options={[{ value: 'all', label: 'All open' }, { value: 'overdue', label: 'Overdue only' }]}
          value={filters.overdueOnly ? 'overdue' : 'all'}
          onChange={(value) => setFilters((f) => ({ ...f, overdueOnly: value === 'overdue' }))}
          colors={colors}
          testIDPrefix={`actions-${tab}-due`}
        />

        {query.error && query.data && (
          <Text testID="actions-stale" style={[styles.stale, { color: colors.mutedForeground }]}>
            {isConnectionError(query.error)
              ? 'No connection: showing the list loaded earlier. Changes need a connection.'
              : 'Couldn’t refresh the list. Pull down to try again.'}
          </Text>
        )}

        {query.isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
        ) : query.error && !query.data ? (
          <AquaEmptyState
            colors={colors}
            error
            message={isConnectionError(query.error)
              ? 'Loading actions needs a connection. Pull down to try again when you have signal.'
              : `Couldn’t load actions: ${query.error instanceof Error ? query.error.message : 'please try again.'}`}
          />
        ) : tab === 'module' ? (
          shownModule.length === 0 ? (
            <AquaEmptyState colors={colors} message={moduleCounts.open === 0 ? 'No unresolved module actions.' : 'No module actions match these filters.'} />
          ) : shownModule.map((action) => {
            const overdue = isOverdue(action.dueDate, today);
            const meta = [moduleLabel(action.module), siteName(action.siteId), action.ownerName && `Owner: ${action.ownerName}`].filter(Boolean).join(' · ');
            return (
              <TouchableOpacity
                key={action.id}
                testID={`actions-module-${action.id}`}
                accessibilityRole="button"
                onPress={() => open('module', action.id)}
                style={[styles.card, { backgroundColor: colors.card, borderColor: overdue ? colors.destructive : colors.border }]}
                activeOpacity={0.75}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cardTitle, { color: colors.foreground }]}>{action.title}</Text>
                  <View style={styles.badges}>
                    <SeverityBadge severity={action.severity} />
                    <ActionBadge label={humanise(action.status)} />
                    {!!action.fixTrackIssueId && <ActionBadge label={`FixTrack #${action.fixTrackIssueId}`} tone="#2563eb" />}
                  </View>
                  <Text style={[styles.meta, { color: colors.mutedForeground }]}>{meta}</Text>
                  {!!action.dueDate && (
                    <Text style={[styles.meta, { color: overdue ? colors.destructive : colors.mutedForeground }]}>
                      {overdue ? 'Overdue · ' : ''}Due {formatDay(action.dueDate)}
                    </Text>
                  )}
                </View>
                <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            );
          })
        ) : shownHub.length === 0 ? (
          <AquaEmptyState colors={colors} message={hubCounts.open === 0 ? 'No open corrective actions are logged for this client.' : 'No corrective actions match these filters.'} />
        ) : shownHub.map((action) => {
          const overdue = isOverdue(action.dueDate, today);
          const meta = [action.sourceTrack, action.sourceRecordId, action.ownerName && `Owner: ${action.ownerName}`].filter(Boolean).join(' · ');
          return (
            <TouchableOpacity
              key={action.id}
              testID={`actions-hub-${action.id}`}
              accessibilityRole="button"
              onPress={() => open('hub', action.id)}
              style={[styles.card, { backgroundColor: colors.card, borderColor: overdue ? colors.destructive : colors.border }]}
              activeOpacity={0.75}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>{action.title}</Text>
                <View style={styles.badges}>
                  <SeverityBadge severity={action.severity} />
                  <ActionBadge label={hubStatusLabel(action.status)} />
                </View>
                <Text style={[styles.meta, { color: colors.mutedForeground }]}>{meta}</Text>
                {!!action.dueDate && (
                  <Text style={[styles.meta, { color: overdue ? colors.destructive : colors.mutedForeground }]}>
                    {overdue ? 'Overdue · ' : ''}Due {formatDay(action.dueDate)}
                  </Text>
                )}
              </View>
              <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          );
        })}

        <Text style={[styles.footnote, { color: colors.mutedForeground }]}>
          Logging new actions, resolved history and required-action templates are on the website.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 16 },
  back: { marginBottom: 10, alignSelf: 'flex-start', padding: 2 },
  headerTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: '#ffffff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter_400Regular' },
  tabs: { flexDirection: 'row', gap: 8, marginTop: 14 },
  tab: { flex: 1, borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, minHeight: 44, justifyContent: 'center' },
  tabSelected: { backgroundColor: '#ffffff', borderColor: '#ffffff' },
  tabText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', textAlign: 'center' },
  tabSub: { fontSize: 11, fontFamily: 'Inter_500Medium', textAlign: 'center', marginTop: 2 },
  content: { padding: 16, gap: 10 },
  intro: { fontSize: 13, fontFamily: 'Inter_400Regular', marginBottom: 4 },
  stale: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  card: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8, padding: 14, gap: 12 },
  cardTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  meta: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 5 },
  footnote: { fontSize: 12, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 12 },
});
