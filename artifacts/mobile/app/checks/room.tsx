/**
 * RoomTrack Screen
 * Daily room housekeeping checks: pick a site, see each active room's status
 * for today, record a check (clean / tidy / to standard, notes, checked by)
 * and see recent checks. Rooms are added, edited and archived on the website.
 * Gated behind hasService("roomtrack").
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { OutboxEntries } from '@/components/OutboxEntries';
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import {
  RECENT_CHECK_DAYS,
  ROOM_OUTCOMES,
  buildRoomCheckBody,
  checksByRoom,
  localIsoDate,
  localIsoDateDaysBefore,
  outcomeCount,
  recentChecks,
  roomLabel,
  roomStatus,
  roomsSavedOnDevice,
  visibleRooms,
  type RoomCheckValues,
  type RoomStatus,
  type RoomTrackCheck,
  type RoomTrackRoom,
} from '@/components/room-track-logic';

const MODULE_COLOR = '#0284c7';
const EMPTY_VALUES: RoomCheckValues = { clean: false, tidy: false, toStandard: false };

interface Site { id: number; name: string }

function formatDate(dateStr: string): string {
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export default function RoomTrackScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const { user, hasService } = useAuth();
  const serviceEnabled = hasService('roomtrack');
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const today = localIsoDate();
  const recentFrom = localIsoDateDaysBefore(RECENT_CHECK_DAYS - 1);
  const [siteId, setSiteId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Form state
  const [room, setRoom] = useState<RoomTrackRoom | null>(null);
  const [values, setValues] = useState<RoomCheckValues>(EMPTY_VALUES);
  const [checkedBy, setCheckedBy] = useState(user?.name ?? '');
  const [notes, setNotes] = useState('');

  const sitesQuery = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
    enabled: serviceEnabled,
  });
  // A site that is no longer available falls back to all sites.
  useEffect(() => {
    if (siteId !== null && sitesQuery.data && !sitesQuery.data.some((site) => site.id === siteId)) setSiteId(null);
  }, [siteId, sitesQuery.data]);

  const roomsQuery = useQuery<RoomTrackRoom[]>({
    queryKey: ['room-track-rooms', siteId],
    queryFn: () => apiFetch(`/api/room-track/rooms?active=true${siteId === null ? '' : `&siteId=${siteId}`}`),
    enabled: serviceEnabled,
  });
  const checksQuery = useQuery<RoomTrackCheck[]>({
    queryKey: ['room-track-checks', recentFrom],
    queryFn: () => apiFetch(`/api/room-track/checks?from=${recentFrom}`),
    enabled: serviceEnabled,
  });

  function closeForm() {
    setRoom(null);
    setValues(EMPTY_VALUES);
    setNotes('');
    setCheckedBy(user?.name ?? '');
  }

  // Saved on the device first, then sent; resent automatically under the
  // same entry ID after a lost connection (the server never duplicates it).
  const outbox = useRecordOutbox('room-check');
  const { mutate, isPending } = useMutation({
    mutationFn: ({ body, label }: { body: Record<string, unknown>; label: string }) =>
      outbox.send(body, `Room check · ${label} · ${String(body.checkDate)}`),
    onSuccess: async (outcome) => {
      if (outcome.state === 'rejected') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        // e.g. someone else recorded this room today in the meantime.
        void qc.invalidateQueries({ queryKey: ['room-track-checks'] });
        Alert.alert('Not accepted', outcome.error);
        return;
      }
      closeForm();
      if (outcome.state === 'queued') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert('Saved on this device', 'No connection right now. The room check is saved on this device and will be sent automatically when you are back online.');
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const record = outcome.response as RoomTrackCheck | undefined;
      if (record?.id) {
        qc.setQueryData<RoomTrackCheck[]>(['room-track-checks', recentFrom], (current) =>
          current ? [record, ...current.filter((check) => check.id !== record.id)] : [record]);
      }
      void qc.invalidateQueries({ queryKey: ['room-track-checks'] });
      Alert.alert('Logged', 'Room check recorded successfully.');
    },
    onError: (err: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Not saved', err.message || 'Something went wrong.');
    },
  });

  if (!serviceEnabled) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>RoomTrack</Text>
        <Text style={[styles.gatedSub, { color: colors.mutedForeground }]}>
          RoomTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  const rooms = visibleRooms(roomsQuery.data ?? [], siteId);
  const todayChecks = checksByRoom(checksQuery.data ?? [], today);
  const savedOnDevice = roomsSavedOnDevice(outbox.entries, today);
  const recent = recentChecks(checksQuery.data ?? [], siteId);
  const knownRooms = new Map((roomsQuery.data ?? []).map((item) => [item.id, item]));
  const checkedCount = rooms.filter((item) => roomStatus(todayChecks.get(item.id), false).kind === 'complete').length;

  function openRoom(target: RoomTrackRoom) {
    const check = todayChecks.get(target.id);
    if (check) {
      Alert.alert(
        `${roomLabel(target)} · checked today`,
        `${outcomeCount(check)}/3: ${ROOM_OUTCOMES.filter((outcome) => check[outcome.key]).map((outcome) => outcome.label).join(', ') || 'no outcomes ticked'}.`
          + `${check.checkedBy ? `\nChecked by ${check.checkedBy}.` : ''}${check.notes ? `\n${check.notes}` : ''}`
          + '\n\nOne check is kept per room per day. Corrections are made on the website.',
      );
      return;
    }
    if (savedOnDevice.has(target.id)) {
      Alert.alert('Saved on this device', 'A check for this room today is saved on this device and will be sent automatically when you are back online.');
      return;
    }
    setRoom(target);
    setValues(EMPTY_VALUES);
    setNotes('');
    setCheckedBy(user?.name ?? '');
  }

  function handleSubmit() {
    if (!room) return;
    const built = buildRoomCheckBody({ room, checkDate: today, values, notes, checkedBy });
    if ('error' in built) {
      Alert.alert('Check the form', built.error);
      return;
    }
    mutate({ body: built.body, label: roomLabel(room) });
  }

  async function onRefresh() {
    setRefreshing(true);
    try {
      await Promise.all([sitesQuery.refetch(), roomsQuery.refetch(), checksQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  const statusDisplay = (status: RoomStatus): { label: string; color: string; icon: React.ComponentProps<typeof Feather>['name'] } => {
    switch (status.kind) {
      case 'complete': return { label: 'Complete · 3/3', color: colors.success, icon: 'check-circle' };
      case 'attention': return { label: `Requires attention · ${status.count}/3`, color: colors.warning, icon: 'alert-circle' };
      case 'saved-on-device': return { label: 'Saved on device', color: colors.warning, icon: 'upload-cloud' };
      case 'unchecked': return { label: 'Not checked', color: colors.mutedForeground, icon: 'minus-circle' };
    }
  };

  const sites = sitesQuery.data ?? [];
  const siteChoices: { id: number | null; name: string }[] = [{ id: null, name: 'All sites' }, ...sites];

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 40 }}
      bottomOffset={20}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.primary} />
      }
    >
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 16 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()}>
            <Feather name="arrow-left" size={22} color="#ffffff" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={[styles.moduleBadge, { backgroundColor: MODULE_COLOR + '22' }]}>
              <Feather name="home" size={14} color={MODULE_COLOR} />
              <Text style={[styles.moduleBadgeText, { color: MODULE_COLOR }]}>RoomTrack</Text>
            </View>
            <Text style={styles.headerTitle}>Room Checks</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
      </View>

      <OutboxEntries entries={outbox.entries} readError={outbox.readError} />

      {/* Site */}
      {sites.length > 1 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Site</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.siteRow}>
              {siteChoices.map((site) => {
                const selected = siteId === site.id;
                return (
                  <TouchableOpacity
                    key={site.id ?? 'all'}
                    testID={`room-site-${site.id ?? 'all'}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={[
                      styles.chip,
                      {
                        borderColor: selected ? MODULE_COLOR : colors.border,
                        backgroundColor: selected ? MODULE_COLOR + '1a' : colors.card,
                      },
                    ]}
                    onPress={() => setSiteId(site.id)}
                  >
                    <Text style={[styles.chipText, { color: selected ? MODULE_COLOR : colors.mutedForeground }]}>{site.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
        </View>
      )}

      {/* Rooms with today's status */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>{"Today's rooms"}</Text>
        <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
          {rooms.length ? `${checkedCount} of ${rooms.length} complete · ` : ''}Tap a room to record its housekeeping check.
        </Text>
        {roomsQuery.isLoading || checksQuery.isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : roomsQuery.isError || checksQuery.isError ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="wifi-off" size={22} color={colors.destructive} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              {((roomsQuery.error ?? checksQuery.error) as Error | null)?.message || 'Rooms could not be loaded.'}
            </Text>
            <TouchableOpacity accessibilityRole="button" onPress={() => void onRefresh()}>
              <Text style={{ color: colors.primary, fontFamily: 'Inter_600SemiBold' }}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : rooms.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="home" size={22} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No active rooms for this selection. Rooms are added on the website.
            </Text>
          </View>
        ) : (
          rooms.map((item) => {
            const display = statusDisplay(roomStatus(todayChecks.get(item.id), savedOnDevice.has(item.id)));
            return (
              <TouchableOpacity
                key={item.id}
                testID={`room-${item.id}`}
                activeOpacity={0.75}
                style={[styles.roomCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => openRoom(item)}
              >
                <View style={[styles.statusIcon, { backgroundColor: display.color + '1a' }]}>
                  <Feather name={display.icon} size={20} color={display.color} />
                </View>
                <View style={styles.roomBody}>
                  <Text style={[styles.roomName, { color: colors.foreground }]}>{roomLabel(item)}</Text>
                  {item.name && item.roomNumber ? (
                    <Text style={[styles.roomMeta, { color: colors.mutedForeground }]}>{item.name}</Text>
                  ) : null}
                  <Text style={[styles.roomMeta, { color: colors.mutedForeground }]}>
                    {item.floor || 'Floor not recorded'}
                  </Text>
                </View>
                <View style={[styles.statusBadge, { backgroundColor: display.color + '1a' }]}>
                  <Text style={[styles.statusBadgeText, { color: display.color }]}>{display.label}</Text>
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </View>

      {/* Form */}
      <Modal
        visible={room !== null}
        transparent
        animationType="slide"
        onRequestClose={() => { if (!isPending) closeForm(); }}
      >
        <View style={styles.modalOverlay}>
          <KeyboardAwareScrollViewCompat
            style={styles.modalScroll}
            contentContainerStyle={styles.modalContent}
            bottomOffset={20}
            keyboardShouldPersistTaps="handled"
          >
            <View style={[styles.formCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.formHeading}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.formTitle, { color: colors.foreground }]}>Room check · {formatDate(today)}</Text>
                  <Text style={[styles.formRoom, { color: colors.mutedForeground }]}>
                    {room ? [roomLabel(room), room.roomNumber ? room.name : null, room.floor].filter(Boolean).join(' · ') : ''}
                  </Text>
                  {room?.notes ? (
                    <Text style={[styles.formRoom, { color: colors.mutedForeground }]}>{room.notes}</Text>
                  ) : null}
                </View>
                <TouchableOpacity
                  testID="room-close-form"
                  accessibilityRole="button"
                  accessibilityLabel="Close room check form"
                  onPress={closeForm}
                  disabled={isPending}
                >
                  <Feather name="x" size={22} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>

              {/* Outcomes */}
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>
                  Housekeeping checks ({outcomeCount(values)}/3)
                </Text>
                <View style={styles.outcomeRow}>
                  {ROOM_OUTCOMES.map((outcome) => {
                    const on = values[outcome.key];
                    return (
                      <TouchableOpacity
                        key={outcome.key}
                        testID={`room-outcome-${outcome.key}`}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: on, disabled: isPending }}
                        disabled={isPending}
                        style={[
                          styles.outcomeBtn,
                          {
                            borderColor: on ? colors.success : colors.border,
                            backgroundColor: on ? colors.success + '22' : colors.card,
                          },
                        ]}
                        onPress={() => setValues((current) => ({ ...current, [outcome.key]: !current[outcome.key] }))}
                      >
                        <Feather name={on ? 'check-square' : 'square'} size={16} color={on ? colors.success : colors.mutedForeground} />
                        <Text style={[styles.outcomeText, { color: on ? colors.success : colors.mutedForeground }]}>
                          {outcome.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={[styles.hint, { color: colors.mutedForeground, textAlign: 'left' }]}>
                  Clean, Tidy and To standard are all housekeeping outcomes. Use notes to capture anything needing attention.
                </Text>
              </View>

              {/* Checked by */}
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>
                  Checked by <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
                </Text>
                <TextInput
                  testID="room-checked-by"
                  style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
                  value={checkedBy}
                  onChangeText={setCheckedBy}
                  placeholder="Name"
                  placeholderTextColor={colors.mutedForeground}
                  editable={!isPending}
                  maxLength={200}
                />
              </View>

              {/* Notes */}
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>
                  Notes <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
                </Text>
                <TextInput
                  testID="room-notes"
                  style={[styles.input, styles.textArea, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Anything needing attention"
                  placeholderTextColor={colors.mutedForeground}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                  editable={!isPending}
                />
              </View>

              {/* Submit */}
              <View style={styles.field}>
                <TouchableOpacity
                  testID="room-submit-check"
                  style={[styles.submitBtn, { backgroundColor: colors.navy }, isPending && { opacity: 0.5 }]}
                  onPress={handleSubmit}
                  disabled={isPending}
                >
                  {isPending ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <>
                      <Feather name="check" size={18} color="#ffffff" />
                      <Text style={styles.submitText}>Save room check</Text>
                    </>
                  )}
                </TouchableOpacity>
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                  One check per room per day. Manage rooms on the website.
                </Text>
              </View>
            </View>
          </KeyboardAwareScrollViewCompat>
        </View>
      </Modal>

      {/* Recent checks */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent checks</Text>
        {checksQuery.isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : recent.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="home" size={22} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No room checks in the last {RECENT_CHECK_DAYS} days
            </Text>
          </View>
        ) : (
          recent.map((check) => {
            const count = outcomeCount(check);
            const complete = count === ROOM_OUTCOMES.length;
            const tone = complete ? colors.success : colors.warning;
            return (
              <View
                key={check.id}
                testID={`room-check-${check.id}`}
                style={[styles.recordRow, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={[styles.resultDot, { backgroundColor: tone }]} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Text style={[styles.recordDate, { color: colors.foreground }]}>{formatDate(check.checkDate)}</Text>
                    <View style={[styles.typeBadge, { backgroundColor: tone + '22' }]}>
                      <Text style={[styles.typeBadgeText, { color: tone }]}>
                        {complete ? 'Complete · 3/3' : `Requires attention · ${count}/3`}
                      </Text>
                    </View>
                  </View>
                  <Text style={[styles.recordSub, { color: colors.foreground }]}>
                    {roomLabel(knownRooms.get(check.roomId), check.roomId)}
                  </Text>
                  <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>
                    {ROOM_OUTCOMES.map((outcome) => `${check[outcome.key] ? '✓' : '✗'} ${outcome.label}`).join('  ')}
                  </Text>
                  {check.checkedBy ? (
                    <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>Checked by: {check.checkedBy}</Text>
                  ) : null}
                  {check.notes ? (
                    <Text style={[styles.recordSub, { color: colors.mutedForeground }]} numberOfLines={2}>{check.notes}</Text>
                  ) : null}
                </View>
              </View>
            );
          })
        )}
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  gated: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  gatedTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', textAlign: 'center' },
  gatedSub: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 20 },
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerCenter: { alignItems: 'center', gap: 6 },
  moduleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  moduleBadgeText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  headerTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: '#ffffff' },
  section: { paddingHorizontal: 16, paddingTop: 20, gap: 10 },
  sectionTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
  sectionSub: { fontSize: 12, fontFamily: 'Inter_400Regular', marginBottom: 2 },
  siteRow: { flexDirection: 'row', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  chipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  roomCard: {
    minHeight: 72,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  roomBody: { flex: 1 },
  roomName: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  roomMeta: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
  statusBadge: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, maxWidth: 140 },
  statusBadgeText: { fontSize: 10, fontFamily: 'Inter_600SemiBold', textAlign: 'center' },
  formCard: { width: '100%', padding: 16, borderRadius: 8, borderWidth: 1 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalScroll: { flexGrow: 0, maxHeight: '92%' },
  modalContent: { paddingHorizontal: 12, paddingTop: 24, paddingBottom: 12 },
  formHeading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 18,
  },
  formTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  formRoom: { fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 2 },
  field: { marginBottom: 18 },
  label: { fontSize: 13, fontFamily: 'Inter_600SemiBold', marginBottom: 8 },
  outcomeRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  outcomeBtn: {
    flexGrow: 1,
    flexBasis: 90,
    minHeight: 46,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 6,
    borderWidth: 1.5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  outcomeText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  textArea: { minHeight: 88, paddingTop: 12 },
  submitBtn: {
    minHeight: 52,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitText: { color: '#ffffff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  hint: { fontSize: 11, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 8, lineHeight: 16 },
  emptyCard: { borderWidth: 1, borderRadius: 8, padding: 24, alignItems: 'center', gap: 8 },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
  },
  resultDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4, flexShrink: 0 },
  recordDate: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  recordSub: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  typeBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  typeBadgeText: { fontSize: 11, fontFamily: 'Inter_500Medium' },
});
