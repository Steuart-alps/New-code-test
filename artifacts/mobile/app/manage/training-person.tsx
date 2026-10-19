/**
 * One person's TrainTrack records (read-only): required training status,
 * certificates (with photos attached on the website), document sign-offs and
 * internal training. Opened from the TrainTrack list with ?key=r:<roster id>
 * or n:<name>; staff always see their own records (?key=me), found by their
 * account email on the staff roster as DocTrack links them.
 */
import React, { useMemo, useState } from 'react';
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
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import {
  CertificatePhotos,
  MODULE_COLOR,
  staffRosterQuery,
  statusColor,
  trainRecordsQuery,
} from '@/components/train-track-ui';
import {
  CERT_STATUS_LABELS,
  PERSON_STATUS_LABELS,
  certificateStatus,
  expiryCountdown,
  findMyRosterMember,
  formatDate,
  personByKey,
  recordDetail,
  recordTitle,
  rosterKey,
  seesOwnTrainingOnly,
  signoffStatus,
  type TrainRecord,
} from '@/components/train-track-logic';

const SECTIONS: { type: string; title: string }[] = [
  { type: 'certificate', title: 'Certificates' },
  { type: 'signoff', title: 'Document Sign-offs' },
  { type: 'internal', title: 'Internal Training' },
];

function RecordCard({ record }: { record: TrainRecord }) {
  const colors = useColors();
  const [showPhotos, setShowPhotos] = useState(false);
  let badge: string;
  let tone: string;
  if (record.record_type === 'certificate') {
    const status = certificateStatus(record.expiry_date);
    badge = CERT_STATUS_LABELS[status];
    tone = statusColor(status, colors);
  } else if (record.record_type === 'signoff') {
    const expired = signoffStatus(record.expiry_date) === 'expired';
    badge = expired ? 'Expired' : 'Acknowledged';
    tone = expired ? colors.destructive : colors.success;
  } else {
    badge = 'Completed';
    tone = colors.mutedForeground;
  }
  const detail = recordDetail(record);
  const countdown = expiryCountdown(record.expiry_date);
  return (
    <View testID={`training-record-${record.id}`} style={[styles.record, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.recordTop}>
        <Text style={[styles.recordTitle, { color: colors.foreground }]}>{recordTitle(record)}</Text>
        <View style={[styles.badge, { backgroundColor: tone + '1a', borderColor: tone + '55' }]}>
          <Text style={[styles.badgeText, { color: tone }]}>{badge}</Text>
        </View>
      </View>
      {!!detail && <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>{detail}</Text>}
      {!!record.site_name && <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>{record.site_name}</Text>}
      <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>
        {record.record_type === 'signoff' ? 'Date signed' : record.record_type === 'internal' ? 'Date' : 'Completed'}: {formatDate(record.completed_date)}
      </Text>
      {!!record.expiry_date && (
        <Text style={[styles.recordSub, { color: tone }]}>
          Expires {formatDate(record.expiry_date)}{countdown ? ` (${countdown})` : ''}
        </Text>
      )}
      {!!record.notes && <Text style={[styles.recordNotes, { color: colors.foreground }]}>{record.notes}</Text>}
      {record.record_type === 'certificate' && (
        <>
          <TouchableOpacity
            testID={`training-photos-${record.id}`}
            accessibilityRole="button"
            accessibilityState={{ expanded: showPhotos }}
            onPress={() => setShowPhotos((value) => !value)}
            style={styles.photoToggle}
          >
            <Feather name="image" size={14} color={MODULE_COLOR} />
            <Text style={[styles.photoToggleText, { color: MODULE_COLOR }]}>
              {showPhotos ? 'Hide certificate photos' : 'Show certificate photos'}
            </Text>
          </TouchableOpacity>
          {showPhotos && <CertificatePhotos recordId={record.id} />}
        </>
      )}
    </View>
  );
}

export default function TrainingPersonScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ key?: string }>();
  const { user, hasService } = useAuth();
  const enabled = hasService('traintrack');
  const ownOnly = seesOwnTrainingOnly(user?.role);
  const wantsOwn = ownOnly || params.key === 'me';
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const records = useQuery({ ...trainRecordsQuery(user?.clientId), enabled });
  const roster = useQuery({ ...staffRosterQuery(user?.clientId), enabled });

  const mine = useMemo(() => findMyRosterMember(roster.data ?? [], user?.email), [roster.data, user?.email]);
  const key = wantsOwn ? (mine.state === 'linked' ? rosterKey(mine.member.id) : null) : (params.key ?? null);
  const person = useMemo(
    () => (key ? personByKey(records.data ?? [], roster.data ?? [], key) : null),
    [records.data, roster.data, key],
  );

  const loading = records.isLoading || roster.isLoading;
  const error = records.error ?? roster.error;
  const refresh = () => { records.refetch(); roster.refetch(); };
  const meta = person ? [person.jobTitle, person.siteName, person.department].filter(Boolean).join(' · ') : '';

  const message = (icon: React.ComponentProps<typeof Feather>['name'], title: string, body: string) => (
    <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Feather name={icon} size={28} color={colors.mutedForeground} />
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>{title}</Text>
      <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>{body}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
        <TouchableOpacity testID="training-person-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
          <Feather name="arrow-left" size={22} color="#ffffff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{wantsOwn ? 'My training' : person?.label ?? 'Training records'}</Text>
        {!!(wantsOwn ? person?.name : meta) && <Text style={styles.headerSub}>{wantsOwn ? person?.name : meta}</Text>}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={records.isRefetching || roster.isRefetching} onRefresh={refresh} tintColor={MODULE_COLOR} />}
      >
        {!enabled ? (
          message('lock', 'TrainTrack not enabled', 'TrainTrack is not enabled on your account. Contact your administrator to activate this module.')
        ) : loading ? (
          <ActivityIndicator color={MODULE_COLOR} style={{ marginTop: 48 }} />
        ) : error ? (
          <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.destructive }]}>
            <Feather name="alert-circle" size={24} color={colors.destructive} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Could not load training records</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>{error instanceof Error ? error.message : 'Please try again.'}</Text>
            <TouchableOpacity testID="training-person-retry" accessibilityRole="button" style={[styles.retryBtn, { backgroundColor: colors.navy }]} onPress={refresh}>
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : wantsOwn && mine.state === 'ambiguous' ? (
          message('link-2', 'Staff record not linked', 'More than one active staff record uses your email. Ask an administrator to resolve this.')
        ) : wantsOwn && mine.state === 'none' ? (
          message('link-2', 'Staff record not linked', 'Your account is not linked to an active staff roster record. Ask a manager to check your roster email.')
        ) : !person ? (
          message('user-x', 'No training records', wantsOwn ? 'You have no training records yet.' : 'This person has no training records in your account.')
        ) : (
          <>
            {person.unlinked && (
              <Text style={[styles.note, { color: colors.mutedForeground }]}>
                Not linked to a roster member. Edit these records on the website and choose the roster member.
              </Text>
            )}
            <View style={[styles.statusCard, { backgroundColor: statusColor(person.status, colors) + '12', borderColor: statusColor(person.status, colors) + '55' }]}>
              <Text style={[styles.statusTitle, { color: statusColor(person.status, colors) }]}>{PERSON_STATUS_LABELS[person.status]}</Text>
              {person.courses.length === 0 ? (
                <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>No certificate types recorded yet.</Text>
              ) : person.courses.map((cell) => (
                <View key={cell.course} style={styles.courseRow}>
                  <Text style={[styles.courseName, { color: colors.foreground }]}>{cell.course}</Text>
                  <Text style={[styles.courseState, { color: statusColor(cell.state, colors) }]}>
                    {CERT_STATUS_LABELS[cell.state]}{cell.expiryDate ? ` · ${formatDate(cell.expiryDate)}` : ''}
                  </Text>
                </View>
              ))}
            </View>
            {SECTIONS.map((section) => {
              const rows = person.records.filter((record) => record.record_type === section.type);
              return (
                <View key={section.type} style={{ gap: 8 }}>
                  <View style={styles.sectionHeader}>
                    <Text style={[styles.sectionTitle, { color: colors.foreground }]}>{section.title}</Text>
                    <Text style={[styles.sectionCount, { color: colors.mutedForeground }]}>{rows.length}</Text>
                  </View>
                  {rows.length === 0
                    ? <Text style={[styles.note, { color: colors.mutedForeground }]}>None recorded.</Text>
                    : rows.map((record) => <RecordCard key={record.id} record={record} />)}
                </View>
              );
            })}
            <Text style={[styles.note, { color: colors.mutedForeground, textAlign: 'center' }]}>
              Add, edit and print training records on the website.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  back: { marginBottom: 10, alignSelf: 'flex-start', padding: 2 },
  headerTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: '#ffffff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter_400Regular' },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  statusCard: { borderWidth: 1, borderRadius: 8, padding: 14, gap: 6 },
  statusTitle: { fontSize: 16, fontFamily: 'Inter_700Bold', marginBottom: 2 },
  courseRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  courseName: { fontSize: 13, fontFamily: 'Inter_500Medium', flexShrink: 1 },
  courseState: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  sectionTitle: { fontSize: 17, fontFamily: 'Inter_700Bold' },
  sectionCount: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  record: { borderWidth: 1, borderRadius: 8, padding: 12, gap: 3 },
  recordTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  recordTitle: { flex: 1, fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  recordSub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  recordNotes: { fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 4 },
  badge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  photoToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6, alignSelf: 'flex-start', paddingVertical: 4 },
  photoToggleText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  note: { fontSize: 12, fontFamily: 'Inter_400Regular', lineHeight: 17 },
  empty: { borderWidth: 1, borderRadius: 8, padding: 24, alignItems: 'center', gap: 8, marginTop: 8 },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'center' },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  retryBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 6, marginTop: 4 },
  retryText: { color: '#ffffff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
