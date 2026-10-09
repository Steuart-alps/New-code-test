/**
 * IncidentTrack Screen
 * Logs accidents/incidents and shows a recent incident list.
 * Gated behind hasService("incidenttrack").
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
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

const MODULE_COLOR = '#ef4444';

const DEFAULT_INCIDENT_TYPES = [
  { value: 'accident', label: 'Accident' },
  { value: 'near_miss', label: 'Near miss' },
  { value: 'dangerous_occurrence', label: 'Dangerous occurrence' },
  { value: 'occupational_disease', label: 'Occupational disease' },
] as const;

const DEFAULT_SEVERITIES = [
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

type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]['value'];

interface Site {
  id: number;
  name: string;
}

interface Incident {
  id: number;
  incidentType: string;
  severity: string;
  incidentDate: string;
  location: string;
  involvedName: string;
  status: string;
  riddorReportable: boolean;
}

interface FormOptionsResponse {
  options?: {
    incident_types?: string[];
  };
}

function optionLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function severityColor(severity: string): string {
  const found = DEFAULT_SEVERITIES.find((s) => s.value === severity);
  return found?.color ?? '#94a3b8';
}

export default function IncidentScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const { hasService, user } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const [showForm, setShowForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Form state
  const [incidentType, setIncidentType] = useState('accident');
  const [severity, setSeverity] = useState('minor');
  const [incidentDate, setIncidentDate] = useState(today());
  const [incidentTime, setIncidentTime] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [involvedName, setInvolvedName] = useState('');
  const [involvedJobTitle, setInvolvedJobTitle] = useState('');
  const [involvedEmploymentType, setInvolvedEmploymentType] = useState<EmploymentType>('employee');
  const [injuriesSustained, setInjuriesSustained] = useState('');
  const [firstAidGiven, setFirstAidGiven] = useState(false);
  const [firstAiderName, setFirstAiderName] = useState('');
  const [witnesses, setWitnesses] = useState('');
  const [immediateActions, setImmediateActions] = useState('');
  const [riddorReportable, setRiddorReportable] = useState<boolean | null>(null);
  const [riddorRationale, setRiddorRationale] = useState('');
  const [reportedBy, setReportedBy] = useState('');
  const [siteId, setSiteId] = useState<number | null>(null);

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ['sites', user?.clientId],
    queryFn: () => apiFetch('/api/sites'),
    enabled: hasService('incidenttrack'),
  });

  const {
    data: formOptions,
    isLoading: optionsLoading,
    isError: optionsError,
    refetch: refetchOptions,
  } = useQuery<FormOptionsResponse>({
    queryKey: ['form-options', user?.clientId],
    queryFn: () => apiFetch('/api/form-options'),
    enabled: hasService('incidenttrack'),
  });

  const {
    data: incidents = [],
    isLoading: incidentsLoading,
    refetch: refetchIncidents,
  } = useQuery<Incident[]>({
    queryKey: ['incidents', user?.clientId],
    queryFn: () => apiFetch('/api/incidents'),
    enabled: hasService('incidenttrack'),
  });

  const incidentTypes =
    formOptions?.options?.incident_types?.length
      ? formOptions.options.incident_types
      : [];
  const severities: readonly string[] = DEFAULT_SEVERITIES.map((option) => option.value);
  const optionsReady = incidentTypes.length > 0;
  const effectiveIncidentType = incidentTypes.includes(incidentType)
    ? incidentType
    : (incidentTypes[0] ?? 'accident');
  const effectiveSeverity = severities.includes(severity)
    ? severity
    : (severities[0] ?? 'minor');

  const { mutate, isPending } = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/incidents', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['incidents', user?.clientId] });
      // Reset form
      setIncidentType(incidentTypes[0] ?? 'accident');
      setSeverity(severities[0] ?? 'minor');
      setIncidentDate(today());
      setIncidentTime('');
      setLocation('');
      setDescription('');
      setInvolvedName('');
      setInvolvedJobTitle('');
      setInvolvedEmploymentType('employee');
      setInjuriesSustained('');
      setFirstAidGiven(false);
      setFirstAiderName('');
      setWitnesses('');
      setImmediateActions('');
      setRiddorReportable(null);
      setRiddorRationale('');
      setReportedBy('');
      setSiteId(null);
      setShowForm(false);
      Alert.alert('Logged', 'Incident recorded successfully.');
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message || 'Something went wrong.');
    },
  });

  function handleSubmit() {
    if (!optionsReady) {
      Alert.alert('Form unavailable', 'Incident options have not loaded. Please retry.');
      return;
    }
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
    if (riddorReportable === null || !riddorRationale.trim()) {
      Alert.alert('RIDDOR assessment required', 'Choose whether this incident may be reportable and explain your assessment.');
      return;
    }
    const body: Record<string, unknown> = {
      incidentType: effectiveIncidentType,
      severity: effectiveSeverity,
      incidentDate,
      location: location.trim(),
      description: description.trim(),
      involvedName: involvedName.trim(),
      involvedEmploymentType,
      firstAidGiven,
      reportedBy: reportedBy.trim(),
      riddorReportable,
      reportedToHse: false,
      riddorRationale: riddorRationale.trim(),
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

  async function onRefresh() {
    setRefreshing(true);
    await refetchIncidents();
    setRefreshing(false);
  }

  const recentIncidents = [...incidents].slice(0, 15);

  if (!hasService('incidenttrack')) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>IncidentTrack</Text>
        <Text style={[styles.gatedSub, { color: colors.mutedForeground }]}>
          IncidentTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
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
              <Feather name="alert-octagon" size={14} color={MODULE_COLOR} />
              <Text style={[styles.moduleBadgeText, { color: MODULE_COLOR }]}>IncidentTrack</Text>
            </View>
            <Text style={styles.headerTitle}>Incident Log</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
      </View>

      {/* Log button */}
      <View style={styles.section}>
        {optionsError ? (
          <View style={[styles.optionsError, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.optionsErrorText, { color: colors.foreground }]}>
              Incident form options could not be loaded.
            </Text>
            <TouchableOpacity
              style={[styles.retryBtn, { borderColor: colors.primary }]}
              onPress={() => { void refetchOptions(); }}
            >
              <Feather name="refresh-cw" size={16} color={colors.primary} />
              <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[
              styles.addBtn,
              { backgroundColor: colors.navy },
              (optionsLoading || !optionsReady) && { opacity: 0.6 },
            ]}
            onPress={() => { setShowForm((v) => !v); }}
            disabled={optionsLoading || !optionsReady}
          >
            {optionsLoading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <>
                <Feather name={showForm ? 'x' : 'plus'} size={18} color="#ffffff" />
                <Text style={styles.addBtnText}>{showForm ? 'Cancel' : 'Log new incident'}</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* Form */}
      {showForm && (
        <View style={styles.formCard}>
          {/* Incident type */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Incident type</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {incidentTypes.map((value) => (
                  <TouchableOpacity
                    key={value}
                    style={[
                      styles.chip,
                      {
                        borderColor: effectiveIncidentType === value ? colors.primary : colors.border,
                        backgroundColor: effectiveIncidentType === value ? colors.primary + '1a' : colors.card,
                      },
                    ]}
                    onPress={() => setIncidentType(value)}
                  >
                    <Text style={[styles.chipText, { color: effectiveIncidentType === value ? colors.primary : colors.mutedForeground }]}>
                      {optionLabel(value)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>

          {/* Severity */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>Severity</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {severities.map((value) => {
                const optionColor = severityColor(value);
                return (
                <TouchableOpacity
                  key={value}
                  style={[
                    styles.resultBtn,
                    {
                      borderColor: effectiveSeverity === value ? optionColor : colors.border,
                      backgroundColor: effectiveSeverity === value ? optionColor + '22' : colors.card,
                    },
                  ]}
                  onPress={() => setSeverity(value)}
                >
                  <Text style={[styles.resultBtnText, { color: effectiveSeverity === value ? optionColor : colors.mutedForeground }]}>
                    {optionLabel(value)}
                  </Text>
                </TouchableOpacity>
                );
              })}
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
                      styles.chip,
                      {
                        borderColor: siteId === null ? colors.primary : colors.border,
                        backgroundColor: siteId === null ? colors.primary + '1a' : colors.card,
                      },
                    ]}
                    onPress={() => setSiteId(null)}
                  >
                    <Text style={[styles.chipText, { color: siteId === null ? colors.primary : colors.mutedForeground }]}>
                      Unspecified
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
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {EMPLOYMENT_TYPES.map((t) => (
                <TouchableOpacity
                  key={t.value}
                  style={[
                    styles.chip,
                    {
                      borderColor: involvedEmploymentType === t.value ? colors.primary : colors.border,
                      backgroundColor: involvedEmploymentType === t.value ? colors.primary + '1a' : colors.card,
                    },
                  ]}
                  onPress={() => setInvolvedEmploymentType(t.value)}
                >
                  <Text style={[styles.chipText, { color: involvedEmploymentType === t.value ? colors.primary : colors.mutedForeground }]}>
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
            <Text style={[styles.label, { color: colors.foreground, marginBottom: 0 }]}>First aid given?</Text>
            <Switch value={firstAidGiven} onValueChange={setFirstAidGiven} trackColor={{ true: MODULE_COLOR }} />
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

          {/* Reported by */}
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.foreground }]}>RIDDOR reportability assessment</Text>
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Record your assessment, not an HSE submission. A manager can review and update it on the web app.
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {([false, true] as const).map((value) => (
                <TouchableOpacity
                  key={String(value)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: riddorReportable === value }}
                  style={[
                    styles.chip,
                    {
                      borderColor: riddorReportable === value ? colors.primary : colors.border,
                      backgroundColor: riddorReportable === value ? colors.primary + '1a' : colors.card,
                    },
                  ]}
                  onPress={() => setRiddorReportable(value)}
                >
                  <Text style={[styles.chipText, { color: riddorReportable === value ? colors.primary : colors.mutedForeground }]}>
                    {value ? 'Potentially reportable' : 'Not reportable'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput
              style={[styles.input, styles.textArea, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card, marginTop: 8 }]}
              value={riddorRationale}
              onChangeText={setRiddorRationale}
              placeholder="Why did you reach this decision?"
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
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
          <View style={styles.field}>
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
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Full investigation and corrective actions can be added on the web app.
            </Text>
          </View>
        </View>
      )}

      {/* Recent incidents */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent incidents</Text>
        {incidentsLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : recentIncidents.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="alert-octagon" size={22} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No incidents logged yet</Text>
          </View>
        ) : (
          recentIncidents.map((inc) => {
            const sev = DEFAULT_SEVERITIES.find((s) => s.value === inc.severity);
            const typLabel = optionLabel(inc.incidentType);
            return (
              <View
                key={inc.id}
                style={[styles.recordRow, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={[styles.sevDot, { backgroundColor: severityColor(inc.severity) }]} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Text style={[styles.recordDate, { color: colors.foreground }]}>
                      {formatDate(inc.incidentDate)}
                    </Text>
                    <View style={[styles.typeBadge, { backgroundColor: colors.primary + '1a' }]}>
                      <Text style={[styles.typeBadgeText, { color: colors.primary }]}>{typLabel}</Text>
                    </View>
                    {inc.riddorReportable && (
                      <View style={[styles.typeBadge, { backgroundColor: '#ef4444' + '22' }]}>
                        <Text style={[styles.typeBadgeText, { color: '#ef4444' }]}>RIDDOR</Text>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.recordSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {inc.location} · {inc.involvedName}
                  </Text>
                  {sev && (
                    <Text style={[styles.recordSub, { color: sev.color }]}>
                      {sev.label} · {inc.status.replace(/_/g, ' ')}
                    </Text>
                  )}
                </View>
              </View>
            );
          })
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
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 6,
    gap: 8,
  },
  addBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  optionsError: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    gap: 12,
  },
  optionsErrorText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
  retryBtn: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  retryText: {
    fontSize: 13,
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
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  textArea: { height: 88, paddingTop: 12 },
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
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
  },
  sevDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 4,
    flexShrink: 0,
  },
  recordDate: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  recordSub: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  typeBadgeText: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
  },
});
