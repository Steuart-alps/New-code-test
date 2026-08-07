import React, { useState } from 'react';
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
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';

const MODULE_COLOR = '#6366f1';

interface Appliance {
  id: number;
  name: string;
  appliance_type?: string | null;
  asset_tag?: string | null;
  location?: string | null;
}

type Result = 'pass' | 'fail';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function handleModuleError(err: Error): void {
  const msg = err.message ?? '';
  if (/not enabled|trial/i.test(msg)) {
    Alert.alert('PATtrack unavailable', msg);
  } else {
    Alert.alert('Error', msg || 'Something went wrong.');
  }
}

export default function PatTestFormScreen() {
  const colors = useColors();
  const router = useRouter();
  const qc = useQueryClient();

  const [applianceId, setApplianceId] = useState<number | null>(null);
  const [result, setResult] = useState<Result>('pass');
  const [testDate, setTestDate] = useState(today());
  const [testedBy, setTestedBy] = useState('');
  const [notes, setNotes] = useState('');

  const {
    data: appliances = [],
    isLoading,
    isError,
    error,
  } = useQuery<Appliance[]>({
    queryKey: ['pat-appliances'],
    queryFn: () => apiFetch('/api/pat-track/appliances'),
    retry: false,
  });

  const { mutate, isPending } = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/pat-track/tests', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['pat-appliances'] });
      qc.invalidateQueries({ queryKey: ['pat-tests'] });
      qc.invalidateQueries({ queryKey: ['pat-status'] });
      Alert.alert('Logged', 'PAT test recorded successfully.', [
        { text: 'Done', onPress: () => router.back() },
      ]);
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      handleModuleError(err);
    },
  });

  function handleSubmit() {
    if (applianceId === null) {
      Alert.alert('Appliance required', 'Please choose the appliance you tested.');
      return;
    }
    const body: Record<string, unknown> = {
      applianceId,
      testDate,
      result,
      ...(testedBy.trim() ? { testedBy: testedBy.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    mutate(body);
  }

  // Module inactive (403) or trial expired (402) → friendly message
  if (isError) {
    const msg = (error as Error)?.message ?? '';
    const friendly = /not enabled|trial/i.test(msg);
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Feather name="alert-circle" size={40} color={colors.mutedForeground} />
        <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
          {friendly ? 'PATtrack unavailable' : 'Could not load appliances'}
        </Text>
        <Text style={[styles.emptyBody, { color: colors.mutedForeground }]}>
          {msg || 'Please try again later.'}
        </Text>
        <TouchableOpacity
          style={[styles.backBtn, { backgroundColor: colors.navy }]}
          onPress={() => router.back()}
        >
          <Text style={styles.submitText}>Go back</Text>
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
          { backgroundColor: MODULE_COLOR + '1a', borderColor: MODULE_COLOR + '44' },
        ]}
      >
        <Feather name="zap" size={14} color={MODULE_COLOR} />
        <Text style={[styles.moduleBadgeText, { color: MODULE_COLOR }]}>PATtrack</Text>
      </View>

      {/* Appliance */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>Appliance</Text>
        {isLoading ? (
          <ActivityIndicator color={colors.mutedForeground} style={{ alignSelf: 'flex-start' }} />
        ) : appliances.length === 0 ? (
          <Text style={[styles.emptyBody, { color: colors.mutedForeground, textAlign: 'left' }]}>
            No appliances found. Add appliances on the web app first.
          </Text>
        ) : (
          <View style={styles.chipWrap}>
            {appliances.map((a) => {
              const selected = applianceId === a.id;
              return (
                <TouchableOpacity
                  key={a.id}
                  style={[
                    styles.typeChip,
                    {
                      borderColor: selected ? colors.primary : colors.border,
                      backgroundColor: selected ? colors.primary + '1a' : colors.card,
                    },
                  ]}
                  onPress={() => setApplianceId(a.id)}
                >
                  <Text
                    style={[
                      styles.typeChipText,
                      { color: selected ? colors.primary : colors.mutedForeground },
                    ]}
                  >
                    {a.name}
                    {a.asset_tag ? ` (${a.asset_tag})` : ''}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>

      {/* Result */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>Result</Text>
        <View style={styles.resultRow}>
          {([
            { value: 'pass' as Result, label: 'Pass', color: '#22c55e' },
            { value: 'fail' as Result, label: 'Fail', color: '#ef4444' },
          ]).map((opt) => (
            <TouchableOpacity
              key={opt.value}
              style={[
                styles.resultBtn,
                {
                  borderColor: result === opt.value ? opt.color : colors.border,
                  backgroundColor: result === opt.value ? opt.color + '22' : colors.card,
                },
              ]}
              onPress={() => setResult(opt.value)}
            >
              <Text
                style={[
                  styles.resultBtnText,
                  { color: result === opt.value ? opt.color : colors.mutedForeground },
                ]}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Test date */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>Test date</Text>
        <TextInput
          style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={testDate}
          onChangeText={setTestDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>

      {/* Tested by */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Tested by <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
        </Text>
        <TextInput
          style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={testedBy}
          onChangeText={setTestedBy}
          placeholder="Name of tester"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>

      {/* Notes */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Notes <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
        </Text>
        <TextInput
          style={[styles.input, styles.textArea, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={notes}
          onChangeText={setNotes}
          placeholder="Any observations..."
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
            (isPending || applianceId === null) && { opacity: 0.6 },
          ]}
          onPress={handleSubmit}
          disabled={isPending || applianceId === null}
        >
          {isPending ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <>
              <Feather name="check" size={18} color="#ffffff" />
              <Text style={styles.submitText}>Log PAT test</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
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
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
  emptyTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', textAlign: 'center' },
  emptyBody: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 20 },
  backBtn: {
    marginTop: 12,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 6,
  },
  submitBtn: {
    height: 52,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitText: { color: '#ffffff', fontSize: 16, fontFamily: 'Inter_600SemiBold' },
});
