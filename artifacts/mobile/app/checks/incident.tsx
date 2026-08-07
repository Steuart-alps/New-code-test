import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
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

const MODULE_COLOR = '#ef4444';

// ─── Enums (match api-server createSchema exactly) ───────────────────────────
const INCIDENT_TYPES = [
  { value: 'accident', label: 'Accident' },
  { value: 'near_miss', label: 'Near miss' },
  { value: 'dangerous_occurrence', label: 'Dangerous occurrence' },
  { value: 'occupational_disease', label: 'Occupational disease' },
] as const;

const SEVERITIES = [
  { value: 'minor', label: 'Minor', color: '#22c55e' },
  { value: 'moderate', label: 'Moderate', color: '#f59e0b' },
  { value: 'serious', label: 'Serious', color: '#f97316' },
  { value: 'fatal', label: 'Fatal', color: '#ef4444' },
] as const;

const EMPLOYMENT_TYPES = [
  { value: 'employee', label: 'Employee' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'visitor', label: 'Visitor' },
  { value: 'member_of_public', label: 'Member of public' },
] as const;

type IncidentType = (typeof INCIDENT_TYPES)[number]['value'];
type Severity = (typeof SEVERITIES)[number]['value'];
type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]['value'];

interface Site {
  id: number;
  name: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function handleModuleError(err: Error): void {
  const msg = err.message ?? '';
  if (/not enabled|trial/i.test(msg)) {
    Alert.alert('IncidentTrack unavailable', msg);
  } else {
    Alert.alert('Error', msg || 'Something went wrong.');
  }
}

export default function IncidentFormScreen() {
  const colors = useColors();
  const router = useRouter();
  const qc = useQueryClient();

  const [incidentType, setIncidentType] = useState<IncidentType>('accident');
  const [severity, setSeverity] = useState<Severity>('minor');
  const [incidentDate, setIncidentDate] = useState(today());
  const [incidentTime, setIncidentTime] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [involvedName, setInvolvedName] = useState('');
  const [involvedJobTitle, setInvolvedJobTitle] = useState('');
  const [involvedEmploymentType, setInvolvedEmploymentType] =
    useState<EmploymentType>('employee');
  const [injuriesSustained, setInjuriesSustained] = useState('');
  const [firstAidGiven, setFirstAidGiven] = useState(false);
  const [firstAiderName, setFirstAiderName] = useState('');
  const [witnesses, setWitnesses] = useState('');
  const [riddorReportable, setRiddorReportable] = useState(false);
  const [immediateActions, setImmediateActions] = useState('');
  const [reportedBy, setReportedBy] = useState('');
  const [siteId, setSiteId] = useState<number | null>(null);

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
  });

  const { mutate, isPending } = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/incidents', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['incidents'] });
      qc.invalidateQueries({ queryKey: ['incidents-summary'] });
      Alert.alert('Logged', 'Incident recorded successfully.', [
        { text: 'Done', onPress: () => router.back() },
      ]);
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      handleModuleError(err);
    },
  });

  function handleSubmit() {
    if (!location.trim()) {
      Alert.alert('Location required', 'Please enter where the incident happened.');
      return;
    }
    if (!description.trim()) {
      Alert.alert('Description required', 'Please describe what happened.');
      return;
    }
    if (!involvedName.trim()) {
      Alert.alert('Person required', 'Please enter the name of the person involved.');
      return;
    }
    if (!reportedBy.trim()) {
      Alert.alert('Reporter required', 'Please enter who is reporting this incident.');
      return;
    }
    const body: Record<string, unknown> = {
      incidentType,
      severity,
      incidentDate,
      location: location.trim(),
      description: description.trim(),
      involvedName: involvedName.trim(),
      involvedEmploymentType,
      firstAidGiven,
      riddorReportable,
      reportedBy: reportedBy.trim(),
      ...(incidentTime.trim() ? { incidentTime: incidentTime.trim() } : {}),
      ...(involvedJobTitle.trim() ? { involvedJobTitle: involvedJobTitle.trim() } : {}),
      ...(injuriesSustained.trim() ? { injuriesSustained: injuriesSustained.trim() } : {}),
      ...(firstAidGiven && firstAiderName.trim() ? { firstAiderName: firstAiderName.trim() } : {}),
      ...(witnesses.trim() ? { witnesses: witnesses.trim() } : {}),
      ...(immediateActions.trim() ? { immediateActions: immediateActions.trim() } : {}),
      ...(siteId ? { siteId } : {}),
    };
    mutate(body);
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
        <Feather name="alert-octagon" size={14} color={MODULE_COLOR} />
        <Text style={[styles.moduleBadgeText, { color: MODULE_COLOR }]}>
          IncidentTrack
        </Text>
      </View>

      {/* Incident type */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>Incident type</Text>
        <View style={styles.chipWrap}>
          {INCIDENT_TYPES.map((t) => (
            <TouchableOpacity
              key={t.value}
              style={[
                styles.typeChip,
                {
                  borderColor: incidentType === t.value ? colors.primary : colors.border,
                  backgroundColor:
                    incidentType === t.value ? colors.primary + '1a' : colors.card,
                },
              ]}
              onPress={() => setIncidentType(t.value)}
            >
              <Text
                style={[
                  styles.typeChipText,
                  {
                    color:
                      incidentType === t.value ? colors.primary : colors.mutedForeground,
                  },
                ]}
              >
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Severity */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>Severity</Text>
        <View style={styles.resultRow}>
          {SEVERITIES.map((s) => (
            <TouchableOpacity
              key={s.value}
              style={[
                styles.resultBtn,
                {
                  borderColor: severity === s.value ? s.color : colors.border,
                  backgroundColor: severity === s.value ? s.color + '22' : colors.card,
                },
              ]}
              onPress={() => setSeverity(s.value)}
            >
              <Text
                style={[
                  styles.resultBtnText,
                  { color: severity === s.value ? s.color : colors.mutedForeground },
                ]}
              >
                {s.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Date + Time */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>Incident date</Text>
        <TextInput
          style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={incidentDate}
          onChangeText={setIncidentDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Time <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
        </Text>
        <TextInput
          style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={incidentTime}
          onChangeText={setIncidentTime}
          placeholder="HH:mm"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>

      {/* Site */}
      {sites.length > 0 && (
        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.foreground }]}>
            Site <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
          </Text>
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
                  Unspecified
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
        <Text style={[styles.label, { color: colors.foreground }]}>Location</Text>
        <TextInput
          style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={location}
          onChangeText={setLocation}
          placeholder="Where did it happen?"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>

      {/* Description */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>What happened?</Text>
        <TextInput
          style={[styles.input, styles.textArea, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={description}
          onChangeText={setDescription}
          placeholder="Describe the incident..."
          placeholderTextColor={colors.mutedForeground}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </View>

      {/* Person involved */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>Person involved</Text>
        <TextInput
          style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={involvedName}
          onChangeText={setInvolvedName}
          placeholder="Full name"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Job title <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
        </Text>
        <TextInput
          style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={involvedJobTitle}
          onChangeText={setInvolvedJobTitle}
          placeholder="e.g. Kitchen porter"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>

      {/* Employment type */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>They are a…</Text>
        <View style={styles.chipWrap}>
          {EMPLOYMENT_TYPES.map((t) => (
            <TouchableOpacity
              key={t.value}
              style={[
                styles.typeChip,
                {
                  borderColor:
                    involvedEmploymentType === t.value ? colors.primary : colors.border,
                  backgroundColor:
                    involvedEmploymentType === t.value ? colors.primary + '1a' : colors.card,
                },
              ]}
              onPress={() => setInvolvedEmploymentType(t.value)}
            >
              <Text
                style={[
                  styles.typeChipText,
                  {
                    color:
                      involvedEmploymentType === t.value
                        ? colors.primary
                        : colors.mutedForeground,
                  },
                ]}
              >
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Injuries */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Injuries sustained <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
        </Text>
        <TextInput
          style={[styles.input, styles.textArea, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={injuriesSustained}
          onChangeText={setInjuriesSustained}
          placeholder="Describe any injuries..."
          placeholderTextColor={colors.mutedForeground}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />
      </View>

      {/* First aid */}
      <View style={[styles.field, styles.switchRow]}>
        <Text style={[styles.label, { color: colors.foreground, marginBottom: 0 }]}>
          First aid given?
        </Text>
        <Switch
          value={firstAidGiven}
          onValueChange={setFirstAidGiven}
          trackColor={{ true: MODULE_COLOR }}
        />
      </View>
      {firstAidGiven && (
        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.foreground }]}>
            First aider name <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
          </Text>
          <TextInput
            style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
            value={firstAiderName}
            onChangeText={setFirstAiderName}
            placeholder="Name of first aider"
            placeholderTextColor={colors.mutedForeground}
          />
        </View>
      )}

      {/* Witnesses */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Witnesses <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
        </Text>
        <TextInput
          style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={witnesses}
          onChangeText={setWitnesses}
          placeholder="Names of any witnesses"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>

      {/* Immediate actions */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Immediate actions taken <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
        </Text>
        <TextInput
          style={[styles.input, styles.textArea, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={immediateActions}
          onChangeText={setImmediateActions}
          placeholder="What was done straight away?"
          placeholderTextColor={colors.mutedForeground}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />
      </View>

      {/* RIDDOR */}
      <View style={[styles.field, styles.switchRow]}>
        <Text style={[styles.label, { color: colors.foreground, marginBottom: 0 }]}>
          RIDDOR reportable?
        </Text>
        <Switch
          value={riddorReportable}
          onValueChange={setRiddorReportable}
          trackColor={{ true: MODULE_COLOR }}
        />
      </View>

      {/* Reported by */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>Reported by</Text>
        <TextInput
          style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={reportedBy}
          onChangeText={setReportedBy}
          placeholder="Your name"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>

      {/* Submit */}
      <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
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
              <Text style={styles.submitText}>Log incident</Text>
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
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  resultRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  resultBtn: {
    flexGrow: 1,
    flexBasis: '22%',
    paddingVertical: 12,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
  },
  resultBtnText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
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
