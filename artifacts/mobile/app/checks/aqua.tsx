/**
 * AquaTrack Screen
 * Two sub-tabs: Pool Checks and Sessions.
 * Gated behind hasService("aquatrack") || hasService("pooltrack") || hasService("swimtrack").
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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

const MODULE_COLOR = '#0ea5e9';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Site {
  id: number;
  name: string;
}

interface PoolCheck {
  id: number;
  check_date: string;
  check_time: string | null;
  check_type: string;
  ph_level: number | null;
  free_chlorine: number | null;
  water_temp_c: number | null;
  turbidity: string | null;
  result: string;
  notes: string | null;
  performed_by: string | null;
  site_name: string | null;
}

interface SwimSession {
  id: number;
  session_date: string;
  session_type: string;
  lifeguard_name: string | null;
  max_bathers: number | null;
  bather_count_peak: number | null;
  notes: string | null;
  result: string;
  site_name: string | null;
}

type ActiveTab = 'pool' | 'sessions';
type PoolCheckType = 'routine' | 'opening' | 'closing' | 'weekly';
type PoolResult = 'pass' | 'fail' | 'action_required';
type Turbidity = 'clear' | 'slightly_hazy' | 'hazy' | 'cloudy';
type SessionType = 'public_swim' | 'lane_swim' | 'lessons' | 'club' | 'private' | 'other';

const POOL_CHECK_TYPES: { value: PoolCheckType; label: string }[] = [
  { value: 'routine', label: 'Routine' },
  { value: 'opening', label: 'Opening' },
  { value: 'closing', label: 'Closing' },
  { value: 'weekly', label: 'Weekly' },
];

const POOL_RESULTS: { value: PoolResult; label: string; color: string }[] = [
  { value: 'pass', label: 'Pass', color: '#22c55e' },
  { value: 'fail', label: 'Fail', color: '#ef4444' },
  { value: 'action_required', label: 'Action required', color: '#f59e0b' },
];

const TURBIDITY_OPTIONS: { value: Turbidity; label: string }[] = [
  { value: 'clear', label: 'Clear' },
  { value: 'slightly_hazy', label: 'Slightly hazy' },
  { value: 'hazy', label: 'Hazy' },
  { value: 'cloudy', label: 'Cloudy' },
];

const SESSION_TYPES: { value: SessionType; label: string }[] = [
  { value: 'public_swim', label: 'Public swim' },
  { value: 'lane_swim', label: 'Lane swim' },
  { value: 'lessons', label: 'Lessons' },
  { value: 'club', label: 'Club' },
  { value: 'private', label: 'Private' },
  { value: 'other', label: 'Other' },
];

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function resultColor(result: string): string {
  if (result === 'pass') return '#22c55e';
  if (result === 'fail') return '#ef4444';
  return '#f59e0b';
}

// ── Pool Checks Tab ───────────────────────────────────────────────────────────

function PoolChecksTab({ siteId }: { siteId: number | null }) {
  const colors = useColors();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [checkType, setCheckType] = useState<PoolCheckType>('routine');
  const [checkDate, setCheckDate] = useState(todayStr());
  const [checkTime, setCheckTime] = useState('');
  const [phLevel, setPhLevel] = useState('');
  const [freeChlorine, setFreeChlorine] = useState('');
  const [combinedChlorine, setCombinedChlorine] = useState('');
  const [waterTemp, setWaterTemp] = useState('');
  const [turbidity, setTurbidity] = useState<Turbidity>('clear');
  const [actionsTaken, setActionsTaken] = useState('');
  const [performedBy, setPerformedBy] = useState('');
  const [result, setResult] = useState<PoolResult>('pass');
  const [notes, setNotes] = useState('');

  const qs = siteId ? `?siteId=${siteId}` : '';

  const {
    data: checks = [],
    isLoading,
    refetch,
  } = useQuery<PoolCheck[]>({
    queryKey: ['pool-checks', siteId],
    queryFn: () => apiFetch(`/api/pool-track${qs}`),
  });

  const { mutate, isPending } = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/pool-track', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['pool-checks'] });
      setShowForm(false);
      setPhLevel('');
      setFreeChlorine('');
      setCombinedChlorine('');
      setWaterTemp('');
      setActionsTaken('');
      setPerformedBy('');
      setNotes('');
      Alert.alert('Logged', 'Pool check recorded successfully.');
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message);
    },
  });

  function handleSubmit() {
    const body: Record<string, unknown> = {
      checkDate,
      checkType,
      result,
      turbidity,
      ...(siteId ? { siteId } : {}),
      ...(checkTime.trim() ? { checkTime: checkTime.trim() } : {}),
      ...(phLevel ? { phLevel: parseFloat(phLevel) } : {}),
      ...(freeChlorine ? { freeChlorine: parseFloat(freeChlorine) } : {}),
      ...(combinedChlorine ? { combinedChlorine: parseFloat(combinedChlorine) } : {}),
      ...(waterTemp ? { waterTempC: parseFloat(waterTemp) } : {}),
      ...(actionsTaken.trim() ? { actionsTaken: actionsTaken.trim() } : {}),
      ...(performedBy.trim() ? { performedBy: performedBy.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    mutate(body);
  }

  return (
    <View>
      {/* Add button */}
      <TouchableOpacity
        style={[styles.addBtn, { backgroundColor: colors.navy }]}
        onPress={() => setShowForm((v) => !v)}
      >
        <Feather name={showForm ? 'x' : 'plus'} size={18} color="#ffffff" />
        <Text style={styles.addBtnText}>{showForm ? 'Cancel' : 'Log pool check'}</Text>
      </TouchableOpacity>

      {/* Form */}
      {showForm && (
        <View style={styles.formSection}>
          {/* Check type */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Check type</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {POOL_CHECK_TYPES.map((t) => (
                  <TouchableOpacity
                    key={t.value}
                    style={[
                      styles.chip,
                      {
                        borderColor: checkType === t.value ? colors.primary : colors.border,
                        backgroundColor: checkType === t.value ? colors.primary + '1a' : colors.card,
                      },
                    ]}
                    onPress={() => setCheckType(t.value)}
                  >
                    <Text style={[styles.chipText, { color: checkType === t.value ? colors.primary : colors.mutedForeground }]}>
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>

          {/* Date / Time */}
          <View style={styles.row2}>
            <View style={[styles.field, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.foreground }]}>Date</Text>
              <TextInput
                style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
                value={checkDate}
                onChangeText={setCheckDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>
            <View style={[styles.field, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.foreground }]}>Time <Text style={{ color: colors.mutedForeground }}>(opt)</Text></Text>
              <TextInput
                style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
                value={checkTime}
                onChangeText={setCheckTime}
                placeholder="HH:mm"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>
          </View>

          {/* Water quality readings */}
          <View style={styles.row2}>
            <View style={[styles.field, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.foreground }]}>Free Cl (mg/L)</Text>
              <TextInput
                style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
                value={freeChlorine}
                onChangeText={setFreeChlorine}
                placeholder="e.g. 1.5"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
              />
            </View>
            <View style={[styles.field, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.foreground }]}>pH level</Text>
              <TextInput
                style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
                value={phLevel}
                onChangeText={setPhLevel}
                placeholder="e.g. 7.4"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
              />
            </View>
          </View>

          <View style={styles.row2}>
            <View style={[styles.field, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.foreground }]}>Water temp (°C)</Text>
              <TextInput
                style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
                value={waterTemp}
                onChangeText={setWaterTemp}
                placeholder="e.g. 28"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
              />
            </View>
            <View style={[styles.field, { flex: 1 }]}>
              <Text style={[styles.label, { color: colors.foreground }]}>Combined Cl</Text>
              <TextInput
                style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
                value={combinedChlorine}
                onChangeText={setCombinedChlorine}
                placeholder="e.g. 0.2"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
              />
            </View>
          </View>

          {/* Turbidity */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Turbidity</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {TURBIDITY_OPTIONS.map((t) => (
                  <TouchableOpacity
                    key={t.value}
                    style={[
                      styles.chip,
                      {
                        borderColor: turbidity === t.value ? colors.primary : colors.border,
                        backgroundColor: turbidity === t.value ? colors.primary + '1a' : colors.card,
                      },
                    ]}
                    onPress={() => setTurbidity(t.value)}
                  >
                    <Text style={[styles.chipText, { color: turbidity === t.value ? colors.primary : colors.mutedForeground }]}>
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>

          {/* Result */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Result</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {POOL_RESULTS.map((r) => (
                <TouchableOpacity
                  key={r.value}
                  style={[
                    styles.resultBtn,
                    {
                      borderColor: result === r.value ? r.color : colors.border,
                      backgroundColor: result === r.value ? r.color + '22' : colors.card,
                    },
                  ]}
                  onPress={() => setResult(r.value)}
                >
                  <Text style={[styles.resultBtnText, { color: result === r.value ? r.color : colors.mutedForeground }]}>
                    {r.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Actions taken */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Actions taken <Text style={{ color: colors.mutedForeground }}>(optional)</Text></Text>
            <TextInput
              style={[styles.input, styles.textArea, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              value={actionsTaken}
              onChangeText={setActionsTaken}
              placeholder="Describe any corrective actions taken..."
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          {/* Performed by */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Performed by <Text style={{ color: colors.mutedForeground }}>(optional)</Text></Text>
            <TextInput
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              value={performedBy}
              onChangeText={setPerformedBy}
              placeholder="Name"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          {/* Notes */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Notes <Text style={{ color: colors.mutedForeground }}>(optional)</Text></Text>
            <TextInput
              style={[styles.input, styles.textArea, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Any additional observations..."
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          <TouchableOpacity
            style={[styles.submitBtn, { backgroundColor: colors.navy }, isPending && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={isPending}
          >
            {isPending ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <>
                <Feather name="check" size={18} color="#ffffff" />
                <Text style={styles.submitText}>Log pool check</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* List */}
      <View style={{ marginTop: 16 }}>
        {isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : checks.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="droplet" size={22} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No pool checks yet</Text>
          </View>
        ) : (
          checks.slice(0, 15).map((check) => (
            <View
              key={check.id}
              style={[styles.checkRow, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Text style={[styles.checkDate, { color: colors.foreground }]}>
                    {formatDate(check.check_date)}
                    {check.check_time ? ` ${check.check_time}` : ''}
                  </Text>
                  <View style={[styles.typeBadge, { backgroundColor: colors.primary + '1a' }]}>
                    <Text style={[styles.typeBadgeText, { color: colors.primary }]}>
                      {POOL_CHECK_TYPES.find((t) => t.value === check.check_type)?.label ?? check.check_type}
                    </Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
                  {check.free_chlorine != null && (
                    <Text style={[styles.reading, { color: colors.mutedForeground }]}>Cl: {check.free_chlorine}</Text>
                  )}
                  {check.ph_level != null && (
                    <Text style={[styles.reading, { color: colors.mutedForeground }]}>pH: {check.ph_level}</Text>
                  )}
                  {check.water_temp_c != null && (
                    <Text style={[styles.reading, { color: colors.mutedForeground }]}>{check.water_temp_c}°C</Text>
                  )}
                  {check.turbidity && (
                    <Text style={[styles.reading, { color: colors.mutedForeground }]}>{check.turbidity.replace('_', ' ')}</Text>
                  )}
                </View>
                {check.notes && (
                  <Text style={[styles.reading, { color: colors.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
                    {check.notes}
                  </Text>
                )}
              </View>
              <View style={[styles.resultDot, { backgroundColor: resultColor(check.result) }]} />
            </View>
          ))
        )}
      </View>
    </View>
  );
}

// ── Sessions Tab ──────────────────────────────────────────────────────────────

function SessionsTab({ siteId }: { siteId: number | null }) {
  const colors = useColors();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [sessionDate, setSessionDate] = useState(todayStr());
  const [sessionType, setSessionType] = useState<SessionType>('public_swim');
  const [lifeguardName, setLifeguardName] = useState('');
  const [maxBathers, setMaxBathers] = useState('');
  const [notes, setNotes] = useState('');

  const qs = siteId ? `?siteId=${siteId}` : '';

  const {
    data: sessions = [],
    isLoading,
    refetch,
  } = useQuery<SwimSession[]>({
    queryKey: ['swim-sessions', siteId],
    queryFn: () => apiFetch(`/api/swim-track/sessions${qs}`),
  });

  const { mutate, isPending } = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/swim-track/sessions', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['swim-sessions'] });
      setShowForm(false);
      setLifeguardName('');
      setMaxBathers('');
      setNotes('');
      Alert.alert('Logged', 'Session recorded successfully.');
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message);
    },
  });

  function handleSubmit() {
    if (!sessionDate.trim()) {
      Alert.alert('Date required', 'Please enter the session date.');
      return;
    }
    const body: Record<string, unknown> = {
      sessionDate,
      sessionType,
      ...(siteId ? { siteId } : {}),
      ...(lifeguardName.trim() ? { lifeguardName: lifeguardName.trim() } : {}),
      ...(maxBathers ? { maxBathers: parseInt(maxBathers, 10) } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    mutate(body);
  }

  return (
    <View>
      {/* Add button */}
      <TouchableOpacity
        style={[styles.addBtn, { backgroundColor: colors.navy }]}
        onPress={() => setShowForm((v) => !v)}
      >
        <Feather name={showForm ? 'x' : 'plus'} size={18} color="#ffffff" />
        <Text style={styles.addBtnText}>{showForm ? 'Cancel' : 'Log session'}</Text>
      </TouchableOpacity>

      {/* Form */}
      {showForm && (
        <View style={styles.formSection}>
          {/* Session type */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Session type</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {SESSION_TYPES.map((t) => (
                  <TouchableOpacity
                    key={t.value}
                    style={[
                      styles.chip,
                      {
                        borderColor: sessionType === t.value ? colors.primary : colors.border,
                        backgroundColor: sessionType === t.value ? colors.primary + '1a' : colors.card,
                      },
                    ]}
                    onPress={() => setSessionType(t.value)}
                  >
                    <Text style={[styles.chipText, { color: sessionType === t.value ? colors.primary : colors.mutedForeground }]}>
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>

          {/* Date */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Session date</Text>
            <TextInput
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              value={sessionDate}
              onChangeText={setSessionDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          {/* Lifeguard */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Lifeguard name <Text style={{ color: colors.mutedForeground }}>(optional)</Text></Text>
            <TextInput
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              value={lifeguardName}
              onChangeText={setLifeguardName}
              placeholder="Name of lifeguard on duty"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          {/* Max bathers */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Max bathers <Text style={{ color: colors.mutedForeground }}>(optional)</Text></Text>
            <TextInput
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              value={maxBathers}
              onChangeText={setMaxBathers}
              placeholder="e.g. 50"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="number-pad"
            />
          </View>

          {/* Notes */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Notes <Text style={{ color: colors.mutedForeground }}>(optional)</Text></Text>
            <TextInput
              style={[styles.input, styles.textArea, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Any session notes..."
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          <TouchableOpacity
            style={[styles.submitBtn, { backgroundColor: colors.navy }, isPending && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={isPending}
          >
            {isPending ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <>
                <Feather name="check" size={18} color="#ffffff" />
                <Text style={styles.submitText}>Log session</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* List */}
      <View style={{ marginTop: 16 }}>
        {isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : sessions.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="users" size={22} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No sessions yet</Text>
          </View>
        ) : (
          sessions.slice(0, 15).map((session) => (
            <View
              key={session.id}
              style={[styles.checkRow, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={[styles.checkDate, { color: colors.foreground }]}>
                    {formatDate(session.session_date)}
                  </Text>
                  <View style={[styles.typeBadge, { backgroundColor: colors.primary + '1a' }]}>
                    <Text style={[styles.typeBadgeText, { color: colors.primary }]}>
                      {SESSION_TYPES.find((t) => t.value === session.session_type)?.label ?? session.session_type}
                    </Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
                  {session.lifeguard_name && (
                    <Text style={[styles.reading, { color: colors.mutedForeground }]}>
                      Lifeguard: {session.lifeguard_name}
                    </Text>
                  )}
                  {session.max_bathers != null && (
                    <Text style={[styles.reading, { color: colors.mutedForeground }]}>
                      Max: {session.max_bathers}
                    </Text>
                  )}
                </View>
                {session.notes && (
                  <Text style={[styles.reading, { color: colors.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
                    {session.notes}
                  </Text>
                )}
              </View>
              <View style={[styles.resultDot, { backgroundColor: resultColor(session.result) }]} />
            </View>
          ))
        )}
      </View>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function AquaTrackScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { hasService } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const [activeTab, setActiveTab] = useState<ActiveTab>('pool');
  const [siteId, setSiteId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const qc = useQueryClient();

  // Service gate
  const allowed =
    hasService('aquatrack') || hasService('pooltrack') || hasService('swimtrack');

  if (!allowed) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>AquaTrack</Text>
        <Text style={[styles.gatedSub, { color: colors.mutedForeground }]}>
          AquaTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
  });

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['pool-checks'] }),
      qc.invalidateQueries({ queryKey: ['swim-sessions'] }),
    ]);
    setRefreshing(false);
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 40 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
    >
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 16 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()}>
            <Feather name="arrow-left" size={22} color="#ffffff" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={[styles.moduleBadge, { backgroundColor: MODULE_COLOR + '22' }]}>
              <Feather name="droplet" size={14} color={MODULE_COLOR} />
              <Text style={[styles.moduleBadgeText, { color: MODULE_COLOR }]}>AquaTrack</Text>
            </View>
            <Text style={styles.headerTitle}>Pool &amp; Swim Management</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
      </View>

      {/* Site picker */}
      {sites.length > 1 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Site</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                style={[
                  styles.chip,
                  {
                    borderColor: siteId === null ? colors.primary : colors.border,
                    backgroundColor: siteId === null ? colors.primary + '1a' : colors.card,
                  },
                ]}
                onPress={() => setSiteId(null)}
              >
                <Text style={[styles.chipText, { color: siteId === null ? colors.primary : colors.mutedForeground }]}>
                  All sites
                </Text>
              </TouchableOpacity>
              {sites.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={[
                    styles.chip,
                    {
                      borderColor: siteId === s.id ? colors.primary : colors.border,
                      backgroundColor: siteId === s.id ? colors.primary + '1a' : colors.card,
                    },
                  ]}
                  onPress={() => setSiteId(s.id)}
                >
                  <Text style={[styles.chipText, { color: siteId === s.id ? colors.primary : colors.mutedForeground }]}>
                    {s.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {/* Sub-tabs */}
      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={[
            styles.tabBtn,
            activeTab === 'pool' && { borderBottomColor: MODULE_COLOR, borderBottomWidth: 2 },
          ]}
          onPress={() => setActiveTab('pool')}
        >
          <Feather
            name="droplet"
            size={16}
            color={activeTab === 'pool' ? MODULE_COLOR : colors.mutedForeground}
          />
          <Text style={[styles.tabLabel, { color: activeTab === 'pool' ? MODULE_COLOR : colors.mutedForeground }]}>
            Pool Checks
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.tabBtn,
            activeTab === 'sessions' && { borderBottomColor: MODULE_COLOR, borderBottomWidth: 2 },
          ]}
          onPress={() => setActiveTab('sessions')}
        >
          <Feather
            name="users"
            size={16}
            color={activeTab === 'sessions' ? MODULE_COLOR : colors.mutedForeground}
          />
          <Text style={[styles.tabLabel, { color: activeTab === 'sessions' ? MODULE_COLOR : colors.mutedForeground }]}>
            Sessions
          </Text>
        </TouchableOpacity>
      </View>

      {/* Tab content */}
      <View style={styles.tabContent}>
        {activeTab === 'pool' ? (
          <PoolChecksTab siteId={siteId} />
        ) : (
          <SessionsTab siteId={siteId} />
        )}
      </View>
    </ScrollView>
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
  gatedTitle: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
  },
  gatedSub: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerCenter: {
    alignItems: 'center',
    gap: 6,
  },
  moduleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  moduleBadgeText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: 'Inter_700Bold',
    color: '#ffffff',
    textAlign: 'center',
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    marginTop: 16,
    marginHorizontal: 16,
  },
  tabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabLabel: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  tabContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 6,
    gap: 8,
    marginBottom: 4,
  },
  addBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  formSection: {
    marginTop: 16,
    paddingTop: 4,
  },
  field: {
    marginBottom: 16,
  },
  row2: {
    flexDirection: 'row',
    gap: 12,
  },
  label: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 8,
  },
  input: {
    height: 46,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  textArea: {
    height: 80,
    paddingTop: 12,
  },
  resultBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
  },
  resultBtnText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  submitBtn: {
    height: 52,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 8,
  },
  submitText: {
    color: '#ffffff',
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    marginBottom: 8,
  },
  checkDate: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  typeBadgeText: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
  },
  reading: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  resultDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 4,
    flexShrink: 0,
  },
});
