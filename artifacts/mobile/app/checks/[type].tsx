import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';

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

interface Site {
  id: number;
  name: string;
}

type FireResult = 'pass' | 'fail';
type WaterResult = 'pass' | 'fail' | 'action_required';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ResultPicker<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; color: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.resultRow}>
      {options.map((opt) => (
        <TouchableOpacity
          key={opt.value}
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
  const qc = useQueryClient();

  const isFire = type === 'fire';
  const isWater = type === 'water';
  const isKitchen = type === 'kitchen';

  const checkTypes = isFire ? FIRE_TYPES : isWater ? WATER_TYPES : [];

  const [checkType, setCheckType] = useState(checkTypes[0]?.value ?? '');
  const [checkDate, setCheckDate] = useState(today());
  const [fireResult, setFireResult] = useState<FireResult>('pass');
  const [waterResult, setWaterResult] = useState<WaterResult>('pass');
  const [temperature, setTemperature] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [performedBy, setPerformedBy] = useState('');
  const [siteId, setSiteId] = useState<number | null>(null);

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
  });

  const endpoint = isFire ? '/api/fire-safety' : '/api/legionella';

  const { mutate, isPending } = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(endpoint, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['fire-status'] });
      qc.invalidateQueries({ queryKey: ['water-status'] });
      Alert.alert('Logged', 'Check recorded successfully.', [
        { text: 'Done', onPress: () => router.back() },
        { text: 'Log another', style: 'default' },
      ]);
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message);
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
    const body: Record<string, unknown> = {
      checkType,
      checkDate,
      result: isFire ? fireResult : waterResult,
      ...(siteId ? { siteId } : {}),
      ...(location ? { location } : {}),
      ...(notes ? { notes } : {}),
      ...(performedBy ? { performedBy } : {}),
      ...(isWater && temperature ? { temperature: parseFloat(temperature) } : {}),
    };
    mutate(body);
  }

  const moduleTitle = isFire
    ? 'FireTrack'
    : isWater
    ? 'LegionellaTrack'
    : 'KitchenTrack';
  const moduleColor = isFire ? '#f97316' : isWater ? '#0ea5e9' : '#eab308';

  if (isKitchen) {
    return (
      <View
        style={[styles.root, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center', padding: 32 }]}
      >
        <Feather name="thermometer" size={48} color={moduleColor} />
        <Text style={[styles.kitchenTitle, { color: colors.foreground }]}>
          KitchenTrack
        </Text>
        <Text style={[styles.kitchenBody, { color: colors.mutedForeground }]}>
          Full temperature diary logging — including fridge, freezer, delivery,
          and hot-holding records — is available on the web app.
        </Text>
        <TouchableOpacity
          style={[styles.backBtn, { backgroundColor: colors.navy }]}
          onPress={() => router.back()}
        >
          <Text style={{ color: '#ffffff', fontFamily: 'Inter_600SemiBold', fontSize: 15 }}>
            Go back
          </Text>
        </TouchableOpacity>
      </View>
    );
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
        <TextInput
          style={[
            styles.input,
            { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card },
          ]}
          value={checkDate}
          onChangeText={setCheckDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.mutedForeground}
        />
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
        ) : (
          <ResultPicker
            options={[
              { value: 'pass' as WaterResult, label: 'Pass', color: '#22c55e' },
              { value: 'fail' as WaterResult, label: 'Fail', color: '#ef4444' },
              {
                value: 'action_required' as WaterResult,
                label: 'Action required',
                color: '#f59e0b',
              },
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
          onChangeText={setPerformedBy}
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
