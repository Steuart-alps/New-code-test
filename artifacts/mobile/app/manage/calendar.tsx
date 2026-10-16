/**
 * Calendar: what falls due — compliance check due dates, booked contractor
 * visits, contractor insurance, DBS and accreditation expiries, FixTrack and
 * pest control visits, training expiries, COSHH and asbestos reviews — as an
 * agenda (Overdue, Today, This week, Later), filterable by site. Same data
 * and audience as the website's Calendar (GET /api/calendar). Read-only;
 * entries open the matching phone screen where there is one.
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
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { isConnectionError } from '@/components/outbox-status-logic';
import {
  CALENDAR_GROUPS,
  agendaDayLabel,
  agendaWindows,
  buildAgenda,
  calendarPath,
  entryAccessibilityLabel,
  groupOf,
  localIsoDate,
  mergeCalendarEntries,
  normalizeCalendarResponse,
  phoneRouteForCalendarHref,
  type CalendarEntry,
} from '@/components/calendar-agenda-logic';

interface Site { id: number; name: string }

const OVERDUE = '#dc2626';

export default function CalendarScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [siteId, setSiteId] = useState<number | null>(null);
  const localToday = localIsoDate();

  const sitesQuery = useQuery<Site[]>({
    queryKey: ['sites', user?.clientId],
    queryFn: () => apiFetch('/api/sites'),
  });
  const sites = Array.isArray(sitesQuery.data) ? sitesQuery.data : [];

  // A site that is no longer accessible falls back to all sites.
  useEffect(() => {
    if (siteId !== null && sitesQuery.data && !sites.some((site) => site.id === siteId)) setSiteId(null);
  }, [siteId, sitesQuery.data, sites]);

  const calendarQuery = useQuery({
    queryKey: ['calendar-agenda', user?.clientId, siteId, localToday],
    queryFn: async () => {
      const responses = await Promise.all(agendaWindows(localToday).map(async (window) =>
        normalizeCalendarResponse(await apiFetch(calendarPath(window, siteId)))));
      const today = /^\d{4}-\d{2}-\d{2}$/.test(responses[0]?.today ?? '') ? responses[0].today : localToday;
      return {
        today,
        entries: mergeCalendarEntries(responses),
        truncated: responses.some((response) => response.truncated),
      };
    },
  });

  const today = calendarQuery.data?.today ?? localToday;
  const sections = calendarQuery.data ? buildAgenda(calendarQuery.data.entries, today) : [];
  const total = sections.reduce((sum, section) => sum + section.entries.length, 0);

  const refresh = () => {
    void sitesQuery.refetch();
    void calendarQuery.refetch();
  };

  function renderEntry(entry: CalendarEntry) {
    const route = phoneRouteForCalendarHref(entry.href);
    const group = CALENDAR_GROUPS[groupOf(entry.kind)];
    const overdue = entry.status === 'overdue';
    const done = entry.status === 'done';
    const content = (
      <>
        {overdue ? <Feather name="alert-triangle" size={15} color={OVERDUE} style={{ marginTop: 2 }} />
          : done ? <Feather name="check-circle" size={15} color="#15803d" style={{ marginTop: 2 }} />
            : <View style={[styles.dot, { backgroundColor: group.color }]} />}
        <View style={{ flex: 1 }}>
          <Text style={[styles.entryTitle, { color: colors.foreground }, done && styles.done]}>{entry.title}</Text>
          {(entry.detail || entry.siteName) ? (
            <Text style={[styles.entrySub, { color: colors.mutedForeground }]}>{[entry.detail, entry.siteName].filter(Boolean).join(' · ')}</Text>
          ) : null}
          <Text style={[styles.entryDate, { color: overdue ? OVERDUE : colors.mutedForeground }]}>
            {overdue ? `Was due ${agendaDayLabel(entry.date)}` : done ? `Done · ${agendaDayLabel(entry.date)}` : agendaDayLabel(entry.date)}
          </Text>
        </View>
        {route ? <Feather name="chevron-right" size={18} color={colors.mutedForeground} /> : null}
      </>
    );
    const style = [styles.entry, { backgroundColor: colors.card, borderColor: overdue ? OVERDUE + '88' : colors.border }];
    return route ? (
      <TouchableOpacity
        key={entry.id}
        testID={`calendar-entry-${entry.id}`}
        accessibilityRole="button"
        accessibilityLabel={entryAccessibilityLabel(entry)}
        style={style}
        onPress={() => router.push(route as any)}
        activeOpacity={0.75}
      >
        {content}
      </TouchableOpacity>
    ) : (
      <View key={entry.id} testID={`calendar-entry-${entry.id}`} accessible accessibilityLabel={`${entryAccessibilityLabel(entry)}. Details on the website.`} style={style}>
        {content}
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={calendarQuery.isRefetching} onRefresh={refresh} tintColor={colors.primary} />}
    >
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
        <TouchableOpacity testID="calendar-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
          <Feather name="arrow-left" size={22} color="#ffffff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Calendar</Text>
        <Text style={styles.headerSub}>What falls due: overdue, today, this week and later</Text>
      </View>

      {sites.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.siteRow}>
          {[{ id: null as number | null, name: 'All sites' }, ...sites].map((site) => {
            const selected = siteId === site.id;
            return (
              <TouchableOpacity
                key={site.id ?? 'all'}
                testID={`calendar-site-${site.id ?? 'all'}`}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => setSiteId(site.id)}
                style={[styles.siteChip, {
                  borderColor: selected ? colors.primary : colors.border,
                  backgroundColor: selected ? colors.primary + '1a' : colors.card,
                }]}
              >
                <Text style={[styles.siteChipText, { color: selected ? colors.primary : colors.mutedForeground }]}>{site.name}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      <View style={styles.content}>
        <Text style={[styles.note, { color: colors.mutedForeground }]}>
          Compliance check due dates, booked contractor visits, contractor insurance, DBS and accreditation expiries,
          and training expiries, from the last three months to three months ahead.
        </Text>

        {calendarQuery.isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
        ) : calendarQuery.isError ? (
          <View style={styles.empty}>
            <Text role="alert" style={[styles.emptyText, { color: colors.destructive }]}>
              {isConnectionError(calendarQuery.error)
                ? 'The calendar needs a connection to load. Pull down to try again when you have signal.'
                : calendarQuery.error instanceof Error && calendarQuery.error.message
                  ? calendarQuery.error.message : 'The calendar could not be loaded'}
            </Text>
            <TouchableOpacity accessibilityRole="button" onPress={refresh}>
              <Text style={[styles.link, { color: colors.primary }]}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : total === 0 ? (
          <View style={styles.empty} testID="calendar-empty">
            <Feather name="calendar" size={36} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Nothing overdue or falling due in the next three months.</Text>
          </View>
        ) : (
          <>
            {calendarQuery.data?.truncated && (
              <Text style={[styles.note, { color: '#b45309' }]}>Showing the first 1,000 entries. Choose a site to see the rest.</Text>
            )}
            {sections.filter((section) => section.entries.length > 0).map((section) => (
              <View key={section.key} style={{ gap: 8 }} testID={`calendar-section-${section.key}`}>
                <Text style={[styles.sectionTitle, { color: section.key === 'overdue' ? OVERDUE : colors.foreground }]}>
                  {section.title} ({section.entries.length})
                </Text>
                {section.entries.map(renderEntry)}
              </View>
            ))}
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  back: { marginBottom: 10, alignSelf: 'flex-start', padding: 2 },
  headerTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: '#ffffff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter_400Regular' },
  siteRow: { paddingHorizontal: 16, paddingTop: 14, gap: 8 },
  siteChip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  siteChipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  content: { padding: 16, gap: 16 },
  note: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  sectionTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  entry: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderWidth: 1, borderRadius: 8, padding: 12 },
  dot: { width: 9, height: 9, borderRadius: 5, marginTop: 5 },
  entryTitle: { fontSize: 15, fontFamily: 'Inter_500Medium' },
  entrySub: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  entryDate: { fontSize: 12, fontFamily: 'Inter_500Medium', marginTop: 4 },
  done: { textDecorationLine: 'line-through', opacity: 0.7 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 32, paddingHorizontal: 12 },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  link: { fontSize: 14, fontFamily: 'Inter_500Medium' },
});
