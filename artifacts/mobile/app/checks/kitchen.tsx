/**
 * KitchenTrack Screen
 * Shows today's food safety diary status, allows adding entries via the append
 * endpoint, and lists recent diary dates. Gated behind hasService("kitchentrack").
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

const MODULE_COLOR = '#eab308';

interface Site {
  id: number;
  name: string;
}

interface DiaryRecord {
  id: number;
  recordDate: string;
  submittedAt: string | null;
}

type KitchenSectionKey =
  | 'coldFood'
  | 'deliveries'
  | 'hotTemperature'
  | 'cooling'
  | 'reheating'
  | 'hotHolding';

interface KitchenField {
  key: string;
  label: string;
  placeholder?: string;
  keyboard?: 'decimal-pad' | 'default';
  optional?: boolean;
}

const SECTIONS: {
  value: KitchenSectionKey;
  label: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  fields: KitchenField[];
}[] = [
  {
    value: 'coldFood',
    label: 'Fridge / Freezer',
    icon: 'box',
    fields: [
      { key: 'unit', label: 'Unit', placeholder: 'e.g. Fridge 1' },
      { key: 'tempAm', label: 'AM temp (°C)', keyboard: 'decimal-pad', optional: true },
      { key: 'tempPm', label: 'PM temp (°C)', keyboard: 'decimal-pad', optional: true },
      { key: 'correctiveAction', label: 'Corrective action', optional: true },
    ],
  },
  {
    value: 'deliveries',
    label: 'Delivery',
    icon: 'truck',
    fields: [
      { key: 'supplier', label: 'Supplier' },
      { key: 'items', label: 'Items', optional: true },
      { key: 'tempChilled', label: 'Chilled temp (°C)', keyboard: 'decimal-pad', optional: true },
      { key: 'tempFrozen', label: 'Frozen temp (°C)', keyboard: 'decimal-pad', optional: true },
      { key: 'correctiveActions', label: 'Corrective actions', optional: true },
    ],
  },
  {
    value: 'hotTemperature',
    label: 'Cooking',
    icon: 'thermometer',
    fields: [
      { key: 'item', label: 'Food item' },
      { key: 'timeStart', label: 'Start time', placeholder: 'HH:mm', optional: true },
      { key: 'timeFinish', label: 'Finish time', placeholder: 'HH:mm', optional: true },
      { key: 'coreTemp', label: 'Core temp (°C)', keyboard: 'decimal-pad' },
    ],
  },
  {
    value: 'cooling',
    label: 'Cooling',
    icon: 'wind',
    fields: [
      { key: 'item', label: 'Food item' },
      { key: 'timeStart', label: 'Start time', placeholder: 'HH:mm', optional: true },
      { key: 'timeFinish', label: 'Finish time', placeholder: 'HH:mm', optional: true },
      { key: 'coreTemp', label: 'Core temp (°C)', keyboard: 'decimal-pad' },
    ],
  },
  {
    value: 'reheating',
    label: 'Reheating',
    icon: 'rotate-cw',
    fields: [
      { key: 'item', label: 'Food item' },
      { key: 'timeStart', label: 'Start time', placeholder: 'HH:mm', optional: true },
      { key: 'timeFinish', label: 'Finish time', placeholder: 'HH:mm', optional: true },
      { key: 'coreTemp', label: 'Core temp (°C)', keyboard: 'decimal-pad' },
    ],
  },
  {
    value: 'hotHolding',
    label: 'Hot holding',
    icon: 'sun',
    fields: [
      { key: 'item', label: 'Food item' },
      { key: 'coreTemp', label: 'Core temp (°C)', keyboard: 'decimal-pad' },
      { key: 'timeOfCheck', label: 'Time of check', placeholder: 'HH:mm', optional: true },
    ],
  },
];

const SECTION_SHOW_KEY: Record<KitchenSectionKey, { key: string; fallbackKey?: string }> = {
  deliveries: { key: 'food_show_deliveries' },
  coldFood: { key: 'food_show_cold_food' },
  hotTemperature: { key: 'food_show_hot_temperature' },
  cooling: { key: 'food_show_cooling', fallbackKey: 'food_show_hot_temperature' },
  reheating: { key: 'food_show_reheating', fallbackKey: 'food_show_hot_temperature' },
  hotHolding: { key: 'food_show_hot_holding' },
};

function localDateParts(now = new Date()): { recordDate: string; recordedAt: string } {
  const pad = (value: number) => String(value).padStart(2, '0');
  const recordDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return {
    recordDate,
    recordedAt: `${recordDate}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offset}`,
  };
}

function createEntryId(): string {
  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function siteQuery(siteId: number | null): string {
  return siteId != null ? `?siteId=${siteId}` : '';
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export default function KitchenTrackScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const { hasService } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const [siteId, setSiteId] = useState<number | null>(null);
  const [section, setSection] = useState<KitchenSectionKey>('coldFood');
  const [values, setValues] = useState<Record<string, string>>({});
  const [showForm, setShowForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [retryMeta, setRetryMeta] = useState<{ entryId: string; recordDate: string; recordedAt: string } | null>(null);

  // Service gate
  if (!hasService('kitchentrack')) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>KitchenTrack</Text>
        <Text style={[styles.gatedSub, { color: colors.mutedForeground }]}>
          KitchenTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
  });

  const today = localDateParts().recordDate;

  const {
    data: todayRecord,
    isLoading: todayLoading,
    refetch: refetchToday,
  } = useQuery<DiaryRecord | null>({
    queryKey: ['food-safety', 'today', siteId],
    queryFn: async () => {
      try {
        return await apiFetch<DiaryRecord>(`/api/food-safety/by-date/${today}${siteQuery(siteId)}`);
      } catch {
        return null;
      }
    },
  });

  const {
    data: recentRecords = [],
    isLoading: recentLoading,
    refetch: refetchRecent,
  } = useQuery<DiaryRecord[]>({
    queryKey: ['food-safety', 'records', siteId],
    queryFn: () => apiFetch(`/api/food-safety${siteQuery(siteId)}`),
  });

  const { data: config } = useQuery<Record<string, string>>({
    queryKey: ['food-safety', 'config', siteId],
    queryFn: () => apiFetch(`/api/food-safety/config${siteQuery(siteId)}`),
  });

  const visibleSections = SECTIONS.filter((s) => {
    const { key, fallbackKey } = SECTION_SHOW_KEY[s.value];
    const raw = config?.[key] ?? (fallbackKey ? config?.[fallbackKey] : undefined);
    return raw !== 'false';
  });

  const sectionDef =
    visibleSections.find((s) => s.value === section) ??
    visibleSections[0] ??
    SECTIONS.find((s) => s.value === section)!;

  const missingRequired = sectionDef?.fields.some(
    (f) => !f.optional && !(values[f.key] ?? '').trim(),
  ) ?? false;

  const { mutate: appendEntry, isPending } = useMutation({
    mutationFn: async () => {
      const meta = retryMeta ?? { entryId: createEntryId(), ...localDateParts() };
      if (!retryMeta) setRetryMeta(meta);
      const row: Record<string, string> = {};
      for (const f of sectionDef.fields) {
        row[f.key] = (values[f.key] ?? '').trim();
      }
      return apiFetch(`/api/food-safety/append${siteQuery(siteId)}`, {
        method: 'POST',
        body: JSON.stringify({
          recordDate: meta.recordDate,
          recordedAt: meta.recordedAt,
          entryId: meta.entryId,
          section: sectionDef.value,
          row,
        }),
      });
    },
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['food-safety'] });
      setValues({});
      setRetryMeta(null);
      setShowForm(false);
      Alert.alert('Logged', "Entry added to today\u2019s diary.", [
        { text: 'OK' },
        { text: 'Add another', onPress: () => setShowForm(true) },
      ]);
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message);
    },
  });

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([refetchToday(), refetchRecent()]);
    setRefreshing(false);
  }

  // Sort recent records newest first, limit to 10
  const sortedRecords = [...recentRecords]
    .sort((a, b) => b.recordDate.localeCompare(a.recordDate))
    .slice(0, 10);

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
              <Feather name="thermometer" size={14} color={MODULE_COLOR} />
              <Text style={[styles.moduleBadgeText, { color: MODULE_COLOR }]}>KitchenTrack</Text>
            </View>
            <Text style={styles.headerTitle}>Food Safety Diary</Text>
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
                onPress={() => { setSiteId(null); setValues({}); setRetryMeta(null); }}
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
                    onPress={() => { setSiteId(s.id); setValues({}); setRetryMeta(null); }}
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

      {/* Today's record status */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Today — {formatDate(today)}</Text>
        {todayLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : todayRecord ? (
          <View style={[styles.statusCard, { backgroundColor: colors.success + '11', borderColor: colors.success + '44' }]}>
            <Feather name="check-circle" size={20} color={colors.success} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.statusTitle, { color: colors.foreground }]}>Diary started</Text>
              <Text style={[styles.statusSub, { color: colors.mutedForeground }]}>
                {todayRecord.submittedAt ? 'Signed off' : 'In progress — add more entries below'}
              </Text>
            </View>
          </View>
        ) : (
          <View style={[styles.statusCard, { backgroundColor: colors.warning + '11', borderColor: colors.warning + '44' }]}>
            <Feather name="alert-circle" size={20} color={colors.warning} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.statusTitle, { color: colors.foreground }]}>No diary entry yet</Text>
              <Text style={[styles.statusSub, { color: colors.mutedForeground }]}>
                Add your first entry to start today&apos;s food safety record
              </Text>
            </View>
          </View>
        )}

        {/* Toggle form */}
        <TouchableOpacity
          style={[styles.addBtn, { backgroundColor: colors.navy }]}
          onPress={() => { setShowForm((v) => !v); setValues({}); setRetryMeta(null); }}
        >
          <Feather name={showForm ? 'x' : 'plus'} size={18} color="#ffffff" />
          <Text style={styles.addBtnText}>{showForm ? 'Cancel' : 'Add entry to today\u2019s diary'}</Text>
        </TouchableOpacity>
      </View>

      {/* Entry form */}
      {showForm && (
        <View style={styles.formCard}>
          {/* Section picker */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Record type</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {visibleSections.map((s) => (
                  <TouchableOpacity
                    key={s.value}
                    style={[
                      styles.chip,
                      {
                        borderColor: sectionDef?.value === s.value ? colors.primary : colors.border,
                        backgroundColor: sectionDef?.value === s.value ? colors.primary + '1a' : colors.card,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                      },
                    ]}
                    onPress={() => { setSection(s.value); setValues({}); setRetryMeta(null); }}
                  >
                    <Feather
                      name={s.icon}
                      size={13}
                      color={sectionDef?.value === s.value ? colors.primary : colors.mutedForeground}
                    />
                    <Text style={[styles.chipText, { color: sectionDef?.value === s.value ? colors.primary : colors.mutedForeground }]}>
                      {s.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>

          {/* Dynamic fields */}
          {sectionDef?.fields.map((f) => (
            <View key={f.key} style={styles.field}>
              <Text style={[styles.label, { color: colors.foreground }]}>
                {f.label}
                {f.optional && (
                  <Text style={{ color: colors.mutedForeground }}> (optional)</Text>
                )}
              </Text>
              <TextInput
                style={[
                  styles.input,
                  { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card },
                ]}
                value={values[f.key] ?? ''}
                onChangeText={(v) => {
                  setValues((prev) => ({ ...prev, [f.key]: v }));
                  setRetryMeta(null);
                }}
                placeholder={f.placeholder ?? (f.keyboard === 'decimal-pad' ? 'e.g. 4.5' : '')}
                placeholderTextColor={colors.mutedForeground}
                keyboardType={f.keyboard ?? 'default'}
              />
            </View>
          ))}

          {/* Submit */}
          <View style={styles.field}>
            <TouchableOpacity
              style={[
                styles.submitBtn,
                { backgroundColor: colors.navy },
                (isPending || missingRequired) && { opacity: 0.5 },
              ]}
              onPress={() => appendEntry()}
              disabled={isPending || missingRequired}
            >
              {isPending ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <>
                  <Feather name="check" size={18} color="#ffffff" />
                  <Text style={styles.submitText}>Add to today&apos;s diary</Text>
                </>
              )}
            </TouchableOpacity>
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Entries are appended to today&apos;s diary. Sign off the full diary on the web app.
            </Text>
          </View>
        </View>
      )}

      {/* Recent records */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent diary dates</Text>
        {recentLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : sortedRecords.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="book-open" size={22} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No diary records yet
            </Text>
          </View>
        ) : (
          sortedRecords.map((rec) => (
            <View
              key={rec.id}
              style={[styles.recordRow, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Feather
                name={rec.submittedAt ? 'check-circle' : 'circle'}
                size={18}
                color={rec.submittedAt ? colors.success : colors.mutedForeground}
              />
              <View style={{ flex: 1 }}>
                <Text style={[styles.recordDate, { color: colors.foreground }]}>
                  {formatDate(rec.recordDate)}
                </Text>
                <Text style={[styles.recordSub, { color: colors.mutedForeground }]}>
                  {rec.submittedAt ? 'Signed off' : 'In progress'}
                </Text>
              </View>
              <Text style={[styles.recordDateSmall, { color: colors.mutedForeground }]}>
                {rec.recordDate}
              </Text>
            </View>
          ))
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
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    color: '#ffffff',
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 20,
    gap: 10,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 2,
  },
  statusCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
  },
  statusTitle: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  statusSub: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 6,
    gap: 8,
    marginTop: 4,
  },
  addBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  formCard: {
    marginHorizontal: 16,
    marginTop: 4,
    paddingTop: 4,
  },
  field: {
    marginBottom: 18,
  },
  label: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 8,
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
  input: {
    height: 46,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  submitBtn: {
    height: 52,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitText: {
    color: '#ffffff',
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
  hint: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 16,
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
  recordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
  },
  recordDate: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  recordSub: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 1,
  },
  recordDateSmall: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
});
