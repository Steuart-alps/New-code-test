import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useUnsentSubmissions } from '@/hooks/useUnsentSubmissions';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { KitchenTemperatureForm } from '@/components/KitchenTemperatureForm';
import { DateStepper } from '@/components/DateStepper';
import { UnsentSubmissions } from '@/components/UnsentSubmissions';
import { OutboxEntries } from '@/components/OutboxEntries';
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import { isIsoDate, localIsoDate } from '@/components/date-stepper-logic';

// ─── Fire check types ────────────────────────────────────────────────────────
const FIRE_TYPES = [
  { value: 'alarm', label: 'Alarm test' },
  { value: 'emergency_lights', label: 'Emergency lights' },
  { value: 'extinguishers', label: 'Extinguisher check' },
  { value: 'fire_doors', label: 'Fire doors' },
  { value: 'fire_drill', label: 'Fire drill' },
];

// ─── Water / Legionella check types (HSG274 Part 2 Table 2.1) ────────────────
const WATER_TYPES = [
  { value: 'calorifier_temp',       label: 'Calorifier temperature' },
  { value: 'hot_sentinel_temp',     label: 'Hot sentinel outlet temp' },
  { value: 'hot_nonsent_temp',      label: 'Hot representative outlet temp' },
  { value: 'cold_tank_temp',        label: 'Cold water storage temp' },
  { value: 'cold_sentinel_temp',    label: 'Cold sentinel outlet temp' },
  { value: 'cold_nonsent_temp',     label: 'Cold representative outlet temp' },
  { value: 'cold_tank_inspection',  label: 'Cold water tank inspection' },
  { value: 'cold_tank_clean',       label: 'Cold water tank clean & disinfect' },
  { value: 'calorifier_inspection', label: 'Calorifier inspection' },
  { value: 'calorifier_clean',      label: 'Calorifier clean & disinfect' },
  { value: 'shower_clean',          label: 'Shower head / hose descale' },
  { value: 'tmv_service',           label: 'TMV service & verify' },
  { value: 'outlet_flush',          label: 'Little-used outlet flush (5 min)' },
];
const HOT_TUB_TYPES = [
  { value: 'water_chemistry', label: 'Water chemistry' },
  { value: 'temperature', label: 'Temperature' },
  { value: 'cover_inspection', label: 'Cover inspection' },
];

interface Site {
  id: number;
  name: string;
}
interface LegionellaConfig {
  effectiveTemperatureLimits?: Record<string, { min?: number; max?: number }>;
  controlProfile?: { temperatureLimits?: Record<string, { min?: number; max?: number }> };
}
interface HotTubConfig {
  operatingRanges?: {
    ph?: { min?: number; max?: number };
    sanitiser?: { min?: number; max?: number };
    temperature?: { max?: number };
  };
}

type FireResult = 'pass' | 'fail';
type WaterResult = 'pass' | 'fail';

// Device-local calendar date, not UTC (which is the wrong day near midnight).
function today(): string {
  return localIsoDate();
}

// No result is preselected: the person must choose Pass or Fail explicitly.
function ResultPicker<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; color: string }[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.resultRow}>
      {options.map((opt) => (
        <TouchableOpacity
          key={opt.value}
          testID={`check-result-${opt.value}`}
          accessibilityState={{ selected: value === opt.value }}
          style={[
            styles.resultBtn,
            {
              borderColor:
                value === opt.value ? opt.color : colors.border,
              backgroundColor:
                value === opt.value ? opt.color + '22' : colors.card,
            },
          ]}
          onPress={() => onChange(opt.value)}
        >
          <Text
            style={[
              styles.resultBtnText,
              {
                color: value === opt.value ? opt.color : colors.mutedForeground,
              },
            ]}
          >
            {opt.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export default function CheckFormScreen() {
  const { type } = useLocalSearchParams<{ type: string }>();
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();

  const isFire = type === 'fire';
  const isWater = type === 'water';
  const isHotTub = type === 'hot-tub';
  const isKitchen = type === 'kitchen';

  const checkTypes = isFire ? FIRE_TYPES : isWater ? WATER_TYPES : isHotTub ? HOT_TUB_TYPES : [];

  const [checkType, setCheckType] = useState(checkTypes[0]?.value ?? '');
  const [checkDate, setCheckDate] = useState(today());
  const [fireResult, setFireResult] = useState<FireResult | null>(null);
  const [waterResult, setWaterResult] = useState<WaterResult | null>(null);
  const [hotResult, setHotResult] = useState<FireResult | null>(null);
  const [temperature, setTemperature] = useState('');
  const [ph, setPh] = useState('');
  const [sanitiser, setSanitiser] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  // Prefilled with the signed-in person; editable when someone else did it.
  const [performedBy, setPerformedBy] = useState(user?.name ?? '');
  const [performedByEdited, setPerformedByEdited] = useState(false);
  const [siteId, setSiteId] = useState<number | null>(null);
  const unsent = useUnsentSubmissions(`check:${type ?? ''}`);

  useEffect(() => {
    if (!performedByEdited && user?.name) setPerformedBy(user.name);
  }, [performedByEdited, user?.name]);

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
  });
  const { data: legionellaConfig } = useQuery<LegionellaConfig>({
    queryKey: ['legionella-config', siteId],
    queryFn: () => apiFetch(`/api/legionella/config${siteId ? `?siteId=${siteId}` : ''}`),
    enabled: isWater,
  });
  const { data: hotTubConfig } = useQuery<HotTubConfig>({
    queryKey: ['hot-tub-config', siteId],
    queryFn: () => apiFetch(`/api/hot-tub/config${siteId ? `?siteId=${siteId}` : ''}`),
    enabled: isHotTub,
  });

  const outboxKind = isFire ? 'fire-check' : isHotTub ? 'hot-tub-check' : 'legionella-check';

  const moduleTitle = isFire
    ? 'FireTrack'
    : isWater
    ? 'LegionellaTrack'
    : isHotTub
    ? 'HotTubTrack'
    : 'KitchenTrack';
  const checkTypeLabel = (value: unknown) =>
    checkTypes.find((ct) => ct.value === value)?.label ?? String(value ?? '');

  // Every check is saved on the device first, then sent; a lost connection
  // leaves it queued and it is resent automatically under the same entry ID,
  // which the server recognises (no duplicate check).
  const outbox = useRecordOutbox(outboxKind);
  const { mutate, isPending } = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      outbox.send(body, `${moduleTitle} · ${checkTypeLabel(body.checkType)} · ${String(body.checkDate)}`),
    onSuccess: async (outcome, body) => {
      if (outcome.state === 'rejected') {
        // Rejected data: the form keeps it so it can be corrected.
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Not accepted', outcome.error);
        return;
      }
      // The next check needs its own explicit Pass/Fail choice.
      setFireResult(null);
      setWaterResult(null);
      setHotResult(null);
      if (outcome.state === 'queued') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert(
          'Saved on this device',
          'No connection right now. The check is saved on this device and will be sent automatically when you are back online.',
          [
            { text: 'Done', onPress: () => router.back() },
            { text: 'Log another', style: 'default' },
          ],
        );
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const response = outcome.response as { result?: unknown } | undefined;
      Alert.alert('Logged', `Server outcome: ${String(response?.result ?? body.result)}.`, [
        { text: 'Done', onPress: () => router.back() },
        { text: 'Log another', style: 'default' },
      ]);
    },
    onError: (err: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // Nothing was saved (e.g. device storage failed or the account changed).
      Alert.alert('Not saved', err.message || 'Something went wrong.');
    },
  });

  function handleSubmit() {
    if (isKitchen) {
      Alert.alert(
        'KitchenTrack',
        'Full temperature diary logging is available on the web app.',
      );
      return;
    }
    if (!checkDate || !isIsoDate(checkDate)) {
      Alert.alert('Check date required', 'Choose the date the check was done.');
      return;
    }
    if (checkDate > today()) {
      Alert.alert('Check date', 'A check cannot be logged for a future date.');
      return;
    }
    const result = isFire ? fireResult : isHotTub ? hotResult : waterResult;
    if (result === null) {
      Alert.alert('Result required', 'Choose Pass or Fail for this check.');
      return;
    }
    if (isHotTub && checkType === 'water_chemistry' && (!ph || !sanitiser)) {
      Alert.alert('Reading required', 'Enter both pH and sanitiser for a water chemistry check.');
      return;
    }
    if (isHotTub && checkType === 'temperature' && !temperature) {
      Alert.alert('Reading required', 'Enter the water temperature.');
      return;
    }
    const body: Record<string, unknown> = {
      checkType,
      checkDate,
      result,
      ...(siteId ? { siteId } : {}),
      ...(location ? { location } : {}),
      ...(notes ? { notes } : {}),
      ...(performedBy.trim() ? { performedBy: performedBy.trim() } : {}),
      ...(isWater && temperature ? { temperature: parseFloat(temperature) } : {}),
      ...(isHotTub && ph ? { phValue: Number(ph) } : {}),
      ...(isHotTub && sanitiser ? { sanitiserLevel: Number(sanitiser) } : {}),
      ...(isHotTub && temperature ? { temperature: Number(temperature) } : {}),
    };
    const limit = legionellaConfig?.effectiveTemperatureLimits?.[checkType] ??
      legionellaConfig?.controlProfile?.temperatureLimits?.[checkType];
    const value = temperature === '' ? null : Number(temperature);
    const ranges = hotTubConfig?.operatingRanges;
    const hotBreaches = isHotTub && (
      (ph !== '' && ((ranges?.ph?.min !== undefined && Number(ph) < ranges.ph.min) || (ranges?.ph?.max !== undefined && Number(ph) > ranges.ph.max))) ||
      (sanitiser !== '' && ((ranges?.sanitiser?.min !== undefined && Number(sanitiser) < ranges.sanitiser.min) || (ranges?.sanitiser?.max !== undefined && Number(sanitiser) > ranges.sanitiser.max))) ||
      (temperature !== '' && ranges?.temperature?.max !== undefined && Number(temperature) > ranges.temperature.max)
    );
    const outOfRange = isWater && value !== null && !!limit &&
      ((limit.min !== undefined && value < limit.min) || (limit.max !== undefined && value > limit.max));
    if (outOfRange || hotBreaches) {
      Alert.alert('Outside effective site limit', 'This reading is outside the effective site control. The server will evaluate the result when saved.', [
          { text: 'Cancel', style: 'cancel' },
        { text: 'Save anyway', onPress: () => mutate(body) },
      ]);
      return;
    }
    mutate(body);
  }

  const moduleColor =isFire ? '#f97316' : isWater ? '#0ea5e9' : isHotTub ? '#06b6d4' : '#eab308';

  if (isKitchen) {
    return <KitchenTemperatureForm />;
  }

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: 40 }}
      keyboardShouldPersistTaps="handled"
    >
      {/* Module badge */}
      <View
        style={[
          styles.moduleBadge,
          { backgroundColor: moduleColor + '1a', borderColor: moduleColor + '44' },
        ]}
      >
        <Feather
          name={isFire ? 'alert-triangle' : 'droplet'}
          size={14}
          color={moduleColor}
        />
        <Text style={[styles.moduleBadgeText, { color: moduleColor }]}>
          {moduleTitle}
        </Text>
      </View>
      <OutboxEntries entries={outbox.entries} readError={outbox.readError} />
      {/* Copies saved by earlier app versions: "Send" moves each into the
          outbox once, so it is then delivered without duplicates. */}
      <UnsentSubmissions
        drafts={unsent.drafts}
        disabled={isPending}
        primaryLabel="Send"
        onRetry={(draft) => {
          outbox.adoptLegacy(draft, unsent.discard).catch((err: unknown) =>
            Alert.alert('Not saved', err instanceof Error ? err.message : 'Try again.'));
        }}
        onDiscard={(draft) => { void unsent.discard(draft.id); }}
        note="Sends the check exactly as it was saved, with its original date."
      />
      {(isFire || isWater) && (
        <TouchableOpacity
          style={[styles.controlsLink, { borderColor: colors.border, backgroundColor: colors.card }]}
          onPress={() => router.push(`/controls/${type}${siteId ? `?siteId=${siteId}` : ''}` as any)}
          testID="check-form-site-controls"
        >
          <Feather name="book-open" size={16} color={colors.primary} />
          <Text style={[styles.controlsLinkText, { color: colors.foreground }]}>
            Site controls, frequencies and history
          </Text>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
      )}

      {/* Check type */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Check type
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {checkTypes.map((ct) => (
              <TouchableOpacity
                key={ct.value}
                style={[
                  styles.typeChip,
                  {
                    borderColor:
                      checkType === ct.value
                        ? colors.primary
                        : colors.border,
                    backgroundColor:
                      checkType === ct.value
                        ? colors.primary + '1a'
                        : colors.card,
                  },
                ]}
                onPress={() => setCheckType(ct.value)}
              >
                <Text
                  style={[
                    styles.typeChipText,
                    {
                      color:
                        checkType === ct.value
                          ? colors.primary
                          : colors.mutedForeground,
                    },
                  ]}
                >
                  {ct.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </View>

      {/* Date */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Check date
        </Text>
        <DateStepper value={checkDate} onChange={setCheckDate} testID="check-date" />
      </View>

      {/* Result */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>Result</Text>
        {isFire ? (
          <ResultPicker
            options={[
              { value: 'pass' as FireResult, label: 'Pass', color: '#22c55e' },
              { value: 'fail' as FireResult, label: 'Fail', color: '#ef4444' },
            ]}
            value={fireResult}
            onChange={setFireResult}
          />
        ) : isHotTub ? (
          <ResultPicker
            options={[
              { value: 'pass' as FireResult, label: 'Pass', color: '#22c55e' },
              { value: 'fail' as FireResult, label: 'Fail', color: '#ef4444' },
            ]}
            value={hotResult}
            onChange={setHotResult}
          />
        ) : (
          <ResultPicker
            options={[
              { value: 'pass' as WaterResult, label: 'Pass', color: '#22c55e' },
              { value: 'fail' as WaterResult, label: 'Fail', color: '#ef4444' },
            ]}
            value={waterResult}
            onChange={setWaterResult}
          />
        )}
      </View>

      {/* Temperature (water checks only) */}
      {isWater && (
        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.foreground }]}>
            Temperature (°C)
          </Text>
          <TextInput
            style={[
              styles.input,
              { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card },
            ]}
            value={temperature}
            onChangeText={setTemperature}
            placeholder="e.g. 52.4"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="decimal-pad"
          />
        </View>
      )}
      {isHotTub && (checkType === 'water_chemistry' || checkType === 'temperature') && (
        <>
          {checkType === 'water_chemistry' && (
            <>
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>pH</Text>
                <TextInput
                  style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
                  value={ph}
                  onChangeText={setPh}
                  placeholder="e.g. 7.5"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="decimal-pad"
                />
              </View>
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>Sanitiser level</Text>
                <TextInput
                  style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
                  value={sanitiser}
                  onChangeText={setSanitiser}
                  placeholder="e.g. 4"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="decimal-pad"
                />
              </View>
            </>
          )}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Temperature (°C)</Text>
            <TextInput
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              value={temperature}
              onChangeText={setTemperature}
              placeholder="e.g. 38"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="decimal-pad"
            />
          </View>
          {(() => {
            const ranges = hotTubConfig?.operatingRanges;
            const warnings = [
              ph !== '' && ranges?.ph && ((ranges.ph.min !== undefined && Number(ph) < ranges.ph.min) || (ranges.ph.max !== undefined && Number(ph) > ranges.ph.max)) ? 'pH' : '',
              sanitiser !== '' && ranges?.sanitiser && ((ranges.sanitiser.min !== undefined && Number(sanitiser) < ranges.sanitiser.min) || (ranges.sanitiser.max !== undefined && Number(sanitiser) > ranges.sanitiser.max)) ? 'sanitiser' : '',
              temperature !== '' && ranges?.temperature?.max !== undefined && Number(temperature) > ranges.temperature.max ? 'temperature' : '',
            ].filter(Boolean);
            return warnings.length ? <Text style={{ color: '#b45309', paddingHorizontal: 16, marginTop: -12, marginBottom: 16 }}>Warning: {warnings.join(', ')} is outside the site operating range.</Text> : null;
          })()}
        </>
      )}
      {isWater && (() => {
        const limit = legionellaConfig?.effectiveTemperatureLimits?.[checkType] ?? legionellaConfig?.controlProfile?.temperatureLimits?.[checkType];
        const value = temperature === '' ? null : Number(temperature);
        if (value === null || !limit || !((limit.min !== undefined && value < limit.min) || (limit.max !== undefined && value > limit.max))) return null;
        return <Text style={{ color: '#b45309', paddingHorizontal: 16, marginTop: -12, marginBottom: 16 }}>Warning: outside effective site limit; server determines the saved result.</Text>;
      })()}

      {/* Site */}
      {sites.length > 0 && (
        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.foreground }]}>Site</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                style={[
                  styles.typeChip,
                  {
                    borderColor: siteId === null ? colors.primary : colors.border,
                    backgroundColor: siteId === null ? colors.primary + '1a' : colors.card,
                  },
                ]}
                onPress={() => setSiteId(null)}
              >
                <Text style={[styles.typeChipText, { color: siteId === null ? colors.primary : colors.mutedForeground }]}>
                  All / unspecified
                </Text>
              </TouchableOpacity>
              {sites.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={[
                    styles.typeChip,
                    {
                      borderColor: siteId === s.id ? colors.primary : colors.border,
                      backgroundColor: siteId === s.id ? colors.primary + '1a' : colors.card,
                    },
                  ]}
                  onPress={() => setSiteId(s.id)}
                >
                  <Text style={[styles.typeChipText, { color: siteId === s.id ? colors.primary : colors.mutedForeground }]}>
                    {s.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {/* Location */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Location <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
        </Text>
        <TextInput
          style={[
            styles.input,
            { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card },
          ]}
          value={location}
          onChangeText={setLocation}
          placeholder="e.g. Main entrance, Block B"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>

      {/* Performed by */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Performed by <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
        </Text>
        <TextInput
          style={[
            styles.input,
            { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card },
          ]}
          value={performedBy}
          onChangeText={(value) => {
            setPerformedByEdited(true);
            setPerformedBy(value);
          }}
          placeholder="Name of person who completed the check"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>

      {/* Notes */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Notes <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
        </Text>
        <TextInput
          style={[
            styles.input,
            styles.textArea,
            { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card },
          ]}
          value={notes}
          onChangeText={setNotes}
          placeholder="Any observations or actions taken..."
          placeholderTextColor={colors.mutedForeground}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />
      </View>

      {/* Submit */}
      <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
        <TouchableOpacity
          style={[
            styles.submitBtn,
            { backgroundColor: colors.navy },
            isPending && { opacity: 0.6 },
          ]}
          onPress={handleSubmit}
          disabled={isPending}
        >
          {isPending ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <>
              <Feather name="check" size={18} color="#ffffff" />
              <Text style={styles.submitText}>Log check</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  moduleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    margin: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  moduleBadgeText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  controlsLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginTop: -4,
    marginBottom: 20,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 6,
  },
  controlsLinkText: { flex: 1, fontSize: 14, fontFamily: 'Inter_500Medium' },
  field: { paddingHorizontal: 16, marginBottom: 20 },
  label: { fontSize: 13, fontFamily: 'Inter_600SemiBold', marginBottom: 8 },
  input: {
    height: 46,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  textArea: { height: 88, paddingTop: 12 },
  typeChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  typeChipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  resultRow: { flexDirection: 'row', gap: 10 },
  resultBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
  },
  resultBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  submitBtn: {
    height: 52,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitText: { color: '#ffffff', fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  // Kitchen placeholder
  kitchenTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', marginTop: 16, marginBottom: 8 },
  kitchenBody: { fontSize: 15, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 22 },
  backBtn: { marginTop: 24, paddingHorizontal: 32, paddingVertical: 14, borderRadius: 6 },
});
