/**
 * TrainTrack (read-only): managers and viewers see each active staff member's
 * training status — expired, missing required training, expiring soon or up
 * to date — filtered by site, department and course, and open a person for
 * their records and certificates. Staff are sent to their own records. Adding
 * and editing records stays on the website. Gated on hasService("traintrack").
 */
import React, { useMemo, useState } from 'react';
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
import { Redirect, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { MODULE_COLOR, staffRosterQuery, statusColor, trainRecordsQuery } from '@/components/train-track-ui';
import {
  CERT_STATUS_LABELS,
  EMPTY_FILTERS,
  PERSON_STATUSES,
  PERSON_STATUS_LABELS,
  formatDate,
  seesOwnTrainingOnly,
  statusFor,
  trainingOverview,
  type Person,
  type TrainingFilters,
} from '@/components/train-track-logic';

interface Site { id: number; name: string }

function personSummary(person: Person, course: string | null): string {
  if (course) {
    const cell = person.courses.find((entry) => entry.course === course);
    if (!cell) return '';
    if (cell.state === 'missing') return `${course}: no certificate`;
    return `${course}: ${CERT_STATUS_LABELS[cell.state]}${cell.expiryDate ? ` · expires ${formatDate(cell.expiryDate)}` : ''}`;
  }
  const count = (state: string) => person.courses.filter((cell) => cell.state === state).length;
  const parts = [
    count('expired') ? `${count('expired')} expired` : '',
    count('missing') ? `${count('missing')} missing` : '',
    count('expiring_soon') ? `${count('expiring_soon')} expiring soon` : '',
  ].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  return person.records.length === 1 ? '1 record' : `${person.records.length} records`;
}

export default function TrainTrackScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, hasService } = useAuth();
  const enabled = hasService('traintrack');
  const ownOnly = seesOwnTrainingOnly(user?.role);
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [filters, setFilters] = useState<TrainingFilters>(EMPTY_FILTERS);
  const update = (patch: Partial<TrainingFilters>) => setFilters((current) => ({ ...current, ...patch }));

  const records = useQuery({ ...trainRecordsQuery(user?.clientId), enabled: enabled && !ownOnly });
  const roster = useQuery({ ...staffRosterQuery(user?.clientId), enabled: enabled && !ownOnly });
  const sites = useQuery<Site[]>({ queryKey: ['sites'], queryFn: () => apiFetch('/api/sites'), enabled: enabled && !ownOnly });

  const overview = useMemo(
    () => trainingOverview(records.data ?? [], roster.data ?? [], filters),
    [records.data, roster.data, filters],
  );

  if (enabled && ownOnly) return <Redirect href="/manage/training-person?key=me" />;

  const loading = records.isLoading || roster.isLoading;
  const error = records.error ?? roster.error;
  const refreshing = records.isRefetching || roster.isRefetching;
  const refresh = () => { records.refetch(); roster.refetch(); sites.refetch(); };

  const chip = (key: string, label: string, selected: boolean, onPress: () => void) => (
    <TouchableOpacity
      key={key}
      testID={`training-filter-${key}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, { borderColor: selected ? MODULE_COLOR : colors.border, backgroundColor: selected ? MODULE_COLOR + '14' : colors.card }]}
    >
      <Text style={[styles.chipText, { color: selected ? MODULE_COLOR : colors.mutedForeground }]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
        <TouchableOpacity testID="training-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
          <Feather name="arrow-left" size={22} color="#ffffff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>TrainTrack</Text>
        <Text style={styles.headerSub}>Training certificates, document sign-offs, and internal training records</Text>
      </View>

      {!enabled ? (
        <View style={styles.gated}>
          <Feather name="lock" size={32} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>TrainTrack not enabled</Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            TrainTrack is not enabled on your account. Contact your administrator to activate this module.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={MODULE_COLOR} />}
        >
          {loading ? (
            <ActivityIndicator color={MODULE_COLOR} style={{ marginTop: 48 }} />
          ) : error ? (
            <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.destructive }]}>
              <Feather name="alert-circle" size={24} color={colors.destructive} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Could not load training records</Text>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                {error instanceof Error ? error.message : 'Please try again.'}
              </Text>
              <TouchableOpacity testID="training-retry" accessibilityRole="button" style={[styles.retryBtn, { backgroundColor: colors.navy }]} onPress={refresh}>
                <Text style={styles.retryText}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={styles.statGrid}>
                {PERSON_STATUSES.map((status) => {
                  const selected = filters.status === status;
                  const tone = statusColor(status, colors);
                  return (
                    <TouchableOpacity
                      key={status}
                      testID={`training-status-${status}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => update({ status: selected ? null : status })}
                      style={[styles.stat, { borderColor: selected ? tone : colors.border, backgroundColor: tone + (selected ? '22' : '0f') }]}
                    >
                      <Text style={[styles.statValue, { color: tone }]}>{overview.counts[status]}</Text>
                      <Text style={[styles.statLabel, { color: tone }]}>{PERSON_STATUS_LABELS[status]}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={[styles.search, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Feather name="search" size={16} color={colors.mutedForeground} />
                <TextInput
                  testID="training-search"
                  value={filters.search}
                  onChangeText={(search) => update({ search })}
                  placeholder="Search staff or training…"
                  placeholderTextColor={colors.mutedForeground}
                  accessibilityLabel="Search staff or training"
                  style={[styles.searchInput, { color: colors.foreground }]}
                  returnKeyType="search"
                />
              </View>

              {(sites.data?.length ?? 0) > 0 && (
                <>
                  <Text style={[styles.filterLabel, { color: colors.mutedForeground }]}>Site</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                    {chip('site-all', 'All sites', filters.siteId === null, () => update({ siteId: null }))}
                    {(sites.data ?? []).map((site) => chip(`site-${site.id}`, site.name, filters.siteId === site.id, () => update({ siteId: site.id })))}
                  </ScrollView>
                </>
              )}
              {overview.departments.length > 0 && (
                <>
                  <Text style={[styles.filterLabel, { color: colors.mutedForeground }]}>Department</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                    {chip('department-all', 'All departments', filters.department === null, () => update({ department: null }))}
                    {overview.departments.map((department) =>
                      chip(`department-${department}`, department, filters.department === department, () => update({ department })))}
                  </ScrollView>
                </>
              )}
              {overview.courses.length > 0 && (
                <>
                  <Text style={[styles.filterLabel, { color: colors.mutedForeground }]}>Course</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                    {chip('course-all', 'All courses', filters.course === null, () => update({ course: null }))}
                    {overview.courses.map((course) =>
                      chip(`course-${course}`, course, filters.course === course, () => update({ course })))}
                  </ScrollView>
                </>
              )}

              <Text style={[styles.note, { color: colors.mutedForeground }]}>
                Missing means another active staff member in this site holds a certificate type this person has not got, as in the website’s training matrix.
              </Text>

              {overview.people.length === 0 ? (
                <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Feather name="book-open" size={28} color={colors.mutedForeground} />
                  <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                    {overview.total === 0 && !filters.search ? 'No training records' : 'No staff match the current filter'}
                  </Text>
                  <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                    Add staff and training records in TrainTrack on the website.
                  </Text>
                </View>
              ) : overview.people.map((person) => {
                const status = statusFor(person, filters.course) ?? person.status;
                const tone = statusColor(status, colors);
                const meta = [person.jobTitle, person.siteName, person.department].filter(Boolean).join(' · ');
                return (
                  <TouchableOpacity
                    key={person.key}
                    testID={`training-person-${person.key}`}
                    accessibilityRole="button"
                    onPress={() => router.push({ pathname: '/manage/training-person', params: { key: person.key } } as any)}
                    style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
                    activeOpacity={0.75}
                  >
                    <View style={[styles.avatar, { backgroundColor: tone + '1a' }]}>
                      <Feather name={status === 'valid' ? 'check-circle' : status === 'expiring_soon' ? 'clock' : 'alert-triangle'} size={18} color={tone} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.cardTitle, { color: colors.foreground }]}>{person.label}</Text>
                      {!!meta && <Text style={[styles.cardSub, { color: colors.mutedForeground }]}>{meta}</Text>}
                      {person.unlinked && (
                        <Text style={[styles.cardSub, { color: colors.mutedForeground }]}>Not linked to a roster member</Text>
                      )}
                      <Text style={[styles.cardStatus, { color: tone }]}>
                        {PERSON_STATUS_LABELS[status]}{personSummary(person, filters.course) ? ` · ${personSummary(person, filters.course)}` : ''}
                      </Text>
                    </View>
                    <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
                  </TouchableOpacity>
                );
              })}
              <Text style={[styles.note, { color: colors.mutedForeground, textAlign: 'center' }]}>
                Add, edit and print training records on the website.
              </Text>
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  back: { marginBottom: 10, alignSelf: 'flex-start', padding: 2 },
  headerTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: '#ffffff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter_400Regular' },
  gated: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 10 },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { flexBasis: '47%', flexGrow: 1, borderWidth: 1, borderRadius: 8, padding: 12 },
  statValue: { fontSize: 22, fontFamily: 'Inter_700Bold' },
  statLabel: { fontSize: 12, fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', letterSpacing: 0.3 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, minHeight: 44 },
  searchInput: { flex: 1, fontSize: 15, fontFamily: 'Inter_400Regular', paddingVertical: 10 },
  filterLabel: { fontSize: 12, fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 4 },
  chipRow: { gap: 8, paddingRight: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  chipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  note: { fontSize: 12, fontFamily: 'Inter_400Regular', lineHeight: 17 },
  card: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8, padding: 14, gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
  cardSub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  cardStatus: { fontSize: 12, fontFamily: 'Inter_600SemiBold', marginTop: 4 },
  empty: { borderWidth: 1, borderRadius: 8, padding: 24, alignItems: 'center', gap: 8, marginTop: 8 },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'center' },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  retryBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 6, marginTop: 4 },
  retryText: { color: '#ffffff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
