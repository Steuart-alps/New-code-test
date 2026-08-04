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

interface Site {
  id: number;
  name: string;
}

const ISSUE_TYPES = [
  { value: 'electrical', label: 'Electrical', icon: 'zap' },
  { value: 'plumbing', label: 'Plumbing', icon: 'droplet' },
  { value: 'hvac', label: 'HVAC', icon: 'wind' },
  { value: 'structural', label: 'Structural', icon: 'home' },
  { value: 'gas', label: 'Gas', icon: 'alert-triangle' },
  { value: 'safety_hazard', label: 'Safety hazard', icon: 'alert-circle' },
  { value: 'equipment', label: 'Equipment', icon: 'settings' },
  { value: 'it_comms', label: 'IT / Comms', icon: 'wifi' },
  { value: 'cleaning', label: 'Cleaning', icon: 'trash-2' },
  { value: 'general', label: 'General', icon: 'tool' },
] as const;

const AUTO_PRIORITY: Record<string, string> = {
  gas: 'urgent',
  safety_hazard: 'urgent',
  electrical: 'high',
  structural: 'high',
  hvac: 'medium',
  plumbing: 'medium',
  equipment: 'medium',
  it_comms: 'low',
  cleaning: 'low',
  general: 'low',
};

const PRIORITIES = [
  { value: 'urgent', label: 'Urgent', color: '#ef4444' },
  { value: 'high', label: 'High', color: '#f97316' },
  { value: 'medium', label: 'Medium', color: '#f59e0b' },
  { value: 'low', label: 'Low', color: '#94a3b8' },
];

export default function NewIssueScreen() {
  const colors = useColors();
  const router = useRouter();
  const qc = useQueryClient();

  const [issueType, setIssueType] = useState('general');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('low');
  const [siteId, setSiteId] = useState<number | null>(null);

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
  });

  function selectType(t: string) {
    setIssueType(t);
    setPriority(AUTO_PRIORITY[t] ?? 'low');
  }

  const { mutate, isPending } = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/fix-track/issues', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['fix-track-issues-all'] });
      qc.invalidateQueries({ queryKey: ['fix-track-issues'] });
      Alert.alert('Issue reported', 'Your issue has been logged.', [
        { text: 'Done', onPress: () => router.back() },
      ]);
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message);
    },
  });

  function handleSubmit() {
    if (!title.trim()) {
      Alert.alert('Title required', 'Please enter a brief title for the issue.');
      return;
    }
    mutate({
      title: title.trim(),
      description: description.trim() || undefined,
      issueType,
      priority,
      ...(siteId ? { siteId } : {}),
    });
  }

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: 40 }}
      keyboardShouldPersistTaps="handled"
    >
      {/* Issue type */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Issue type
        </Text>
        <View style={styles.typeGrid}>
          {ISSUE_TYPES.map((t) => {
            const selected = issueType === t.value;
            return (
              <TouchableOpacity
                key={t.value}
                style={[
                  styles.typeBtn,
                  {
                    borderColor: selected ? colors.primary : colors.border,
                    backgroundColor: selected ? colors.primary + '15' : colors.card,
                  },
                ]}
                onPress={() => selectType(t.value)}
              >
                <Feather
                  name={t.icon as any}
                  size={16}
                  color={selected ? colors.primary : colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.typeBtnText,
                    {
                      color: selected ? colors.primary : colors.mutedForeground,
                    },
                  ]}
                >
                  {t.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Title */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Title
        </Text>
        <TextInput
          style={[
            styles.input,
            { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card },
          ]}
          value={title}
          onChangeText={setTitle}
          placeholder="Brief description of the issue"
          placeholderTextColor={colors.mutedForeground}
          returnKeyType="next"
        />
      </View>

      {/* Description */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Details <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
        </Text>
        <TextInput
          style={[
            styles.input,
            styles.textArea,
            { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card },
          ]}
          value={description}
          onChangeText={setDescription}
          placeholder="What happened? What needs to be done?"
          placeholderTextColor={colors.mutedForeground}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </View>

      {/* Priority */}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          Priority
        </Text>
        <View style={styles.priorityRow}>
          {PRIORITIES.map((p) => (
            <TouchableOpacity
              key={p.value}
              style={[
                styles.priorityBtn,
                {
                  borderColor: priority === p.value ? p.color : colors.border,
                  backgroundColor:
                    priority === p.value ? p.color + '15' : colors.card,
                },
              ]}
              onPress={() => setPriority(p.value)}
            >
              <Text
                style={[
                  styles.priorityText,
                  {
                    color: priority === p.value ? p.color : colors.mutedForeground,
                  },
                ]}
              >
                {p.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
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
                  styles.siteChip,
                  {
                    borderColor: siteId === null ? colors.primary : colors.border,
                    backgroundColor: siteId === null ? colors.primary + '15' : colors.card,
                  },
                ]}
                onPress={() => setSiteId(null)}
              >
                <Text style={[styles.siteChipText, { color: siteId === null ? colors.primary : colors.mutedForeground }]}>
                  Unspecified
                </Text>
              </TouchableOpacity>
              {sites.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={[
                    styles.siteChip,
                    {
                      borderColor: siteId === s.id ? colors.primary : colors.border,
                      backgroundColor: siteId === s.id ? colors.primary + '15' : colors.card,
                    },
                  ]}
                  onPress={() => setSiteId(s.id)}
                >
                  <Text style={[styles.siteChipText, { color: siteId === s.id ? colors.primary : colors.mutedForeground }]}>
                    {s.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {/* Submit */}
      <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
        <TouchableOpacity
          style={[
            styles.submitBtn,
            { backgroundColor: colors.navy },
            isPending && { opacity: 0.6 },
          ]}
          onPress={handleSubmit}
          disabled={isPending || !title.trim()}
        >
          {isPending ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <>
              <Feather name="send" size={18} color="#ffffff" />
              <Text style={styles.submitText}>Report issue</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  field: { paddingHorizontal: 16, marginBottom: 20, marginTop: 16 },
  label: { fontSize: 13, fontFamily: 'Inter_600SemiBold', marginBottom: 10 },
  input: {
    height: 46,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  textArea: { height: 96, paddingTop: 12 },
  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 6,
  },
  typeBtnText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  priorityRow: { flexDirection: 'row', gap: 8 },
  priorityBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderWidth: 1.5,
    borderRadius: 6,
  },
  priorityText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  siteChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  siteChipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
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
