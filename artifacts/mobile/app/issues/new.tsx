import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
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
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { pendingIssueUploadKey, RecoveryIdentity } from '@/lib/fixTrackRecovery';

interface Site {
  id: number;
  name: string;
}

interface PendingAttachment {
  key: string;
  photo: ImagePicker.ImagePickerAsset;
  objectPath?: string;
}

interface PendingIssueUpload {
  userId: number;
  clientId: number;
  issueId: number;
  attachments: PendingAttachment[];
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
  const { user } = useAuth();

  const [issueType, setIssueType] = useState('general');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [priority, setPriority] = useState('low');
  const [siteId, setSiteId] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [createdIssueId, setCreatedIssueId] = useState<number | null>(null);
  const [hydratedRecoveryKey, setHydratedRecoveryKey] = useState<string | null>(null);
  const recoveryIdentity: RecoveryIdentity | null = user?.clientId === null || !user
    ? null
    : { userId: user.id, clientId: user.clientId };
  const recoveryKey = recoveryIdentity ? pendingIssueUploadKey(recoveryIdentity) : null;

  useEffect(() => {
    let mounted = true;
    // Reset in-memory recovery before reading whenever the signed-in identity
    // changes. This prevents a previous user's issue ID appearing briefly.
    setCreatedIssueId(null);
    setAttachments([]);
    setHydratedRecoveryKey(null);
    if (!recoveryKey || !recoveryIdentity) return () => {
      mounted = false;
    };
    AsyncStorage.getItem(recoveryKey)
      .then((value) => {
        if (!value || !mounted) return;
        const pending = JSON.parse(value) as Partial<PendingIssueUpload>;
        if (
          pending.userId === recoveryIdentity.userId
          && pending.clientId === recoveryIdentity.clientId
          &&
          typeof pending.issueId === 'number'
          && Array.isArray(pending.attachments)
          && pending.attachments.every((attachment) => typeof attachment?.key === 'string' && typeof attachment.photo?.uri === 'string')
        ) {
          setCreatedIssueId(pending.issueId);
          setAttachments(pending.attachments);
        }
      })
      .catch(() => AsyncStorage.removeItem(recoveryKey))
      .finally(() => {
        if (mounted) setHydratedRecoveryKey(recoveryKey);
      });
    return () => {
      mounted = false;
    };
  }, [recoveryKey]);

  useEffect(() => {
    if (!recoveryIdentity || !recoveryKey || hydratedRecoveryKey !== recoveryKey) return;
    if (createdIssueId === null) {
      AsyncStorage.removeItem(recoveryKey).catch(() => undefined);
      return;
    }
    AsyncStorage.setItem(
      recoveryKey,
      JSON.stringify({ ...recoveryIdentity, issueId: createdIssueId, attachments }),
    ).catch(() => undefined);
  }, [attachments, createdIssueId, hydratedRecoveryKey, recoveryKey]);

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
  });

  function selectType(t: string) {
    setIssueType(t);
    setPriority(AUTO_PRIORITY[t] ?? 'low');
  }

  function finishIssue(issueId: number, photosAttached: boolean) {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    qc.invalidateQueries({ queryKey: ['fix-track-issues-all'] });
    qc.invalidateQueries({ queryKey: ['fix-track-issues'] });
    Alert.alert(
      photosAttached ? 'Issue reported' : 'Issue saved',
      photosAttached
        ? `Issue #${issueId} has been logged with its photos.`
        : `Issue #${issueId} has been saved. You can add photos later from the issue.`,
      [{ text: 'Done', onPress: () => router.back() }],
    );
  }

  const { mutate: uploadAttachments, isPending: isUploadingAttachments } = useMutation({
    mutationFn: async ({ issueId, pendingAttachments }: { issueId: number; pendingAttachments: PendingAttachment[] }) => {
      const mediaUrls = pendingAttachments
        .map((attachment) => attachment.objectPath)
        .filter((objectPath): objectPath is string => !!objectPath);
      for (const attachment of pendingAttachments) {
        if (attachment.objectPath) continue;
        const { photo } = attachment;
        const contentType = photo.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
        const upload = await apiFetch<{ uploadUrl: string; objectPath: string }>(`/api/fix-track/issues/${issueId}/request-upload`, {
          method: 'POST',
          body: JSON.stringify({ name: photo.fileName ?? `issue-photo-${Date.now()}.jpg`, contentType }),
        });
        const response = await expoFetch(upload.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': contentType },
          body: new File(photo.uri),
        });
        if (!response.ok) throw new Error('A photo could not be uploaded');
        // Preserve each successfully uploaded path immediately. A later upload
        // or finalization failure can then retry this same issue without
        // generating replacement objects for photos already uploaded.
        mediaUrls.push(upload.objectPath);
        setAttachments((current) => current.map((currentAttachment) => (
          currentAttachment.key === attachment.key
            ? { ...currentAttachment, objectPath: upload.objectPath }
            : currentAttachment
        )));
      }
      await apiFetch(`/api/fix-track/issues/${issueId}`, {
        method: 'PUT',
        body: JSON.stringify({ mediaUrls }),
      });
      return issueId;
    },
    onSuccess: (issueId) => {
      setAttachments([]);
      setCreatedIssueId(null);
      finishIssue(issueId, true);
    },
    onError: (err: Error, variables) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        'Issue saved — photos need attention',
        `Issue #${variables.issueId} was saved, but its photos were not all attached. ${err.message} You can retry the photos for this same issue, or finish now without resubmitting it.`,
        [
          { text: 'Finish', onPress: () => router.back() },
          { text: 'Retry photos', onPress: () => uploadAttachments(variables) },
        ],
      );
    },
  });

  const { mutate: createIssue, isPending: isCreatingIssue } = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiFetch<{ id: number }>('/api/fix-track/issues', {
        method: 'POST',
        body: JSON.stringify(body),
    }),
    onSuccess: async (created) => {
      qc.invalidateQueries({ queryKey: ['fix-track-issues-all'] });
      qc.invalidateQueries({ queryKey: ['fix-track-issues'] });
      if (attachments.length === 0) {
        finishIssue(created.id, false);
        return;
      }
      // Write the recovery record before beginning network uploads, so a
      // backgrounded or closed app never loses the issue ID after creation.
      setCreatedIssueId(created.id);
      if (recoveryIdentity && recoveryKey) {
        await AsyncStorage.setItem(
          recoveryKey,
          JSON.stringify({ ...recoveryIdentity, issueId: created.id, attachments }),
        ).catch(() => undefined);
      }
      uploadAttachments({ issueId: created.id, pendingAttachments: attachments });
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Unable to save issue', err.message);
    },
  });

  function handleSubmit() {
    if (createdIssueId !== null) {
      if (attachments.length > 0) {
        uploadAttachments({ issueId: createdIssueId, pendingAttachments: attachments });
      } else {
        finishIssue(createdIssueId, false);
      }
      return;
    }
    if (!title.trim() || !location.trim()) {
      Alert.alert('Details required', 'Please enter a brief title and the issue location.');
      return;
    }
    createIssue({
      title: title.trim(),
      description: description.trim() || undefined,
      issueType,
      priority,
      location: location.trim(),
      reportedBy: user?.name ?? 'Mobile user',
      reportedDate: new Date().toISOString().slice(0, 10),
      ...(siteId ? { siteId } : {}),
    });
  }

  function discardPendingRecovery() {
    if (createdIssueId === null) return;
    const issueId = createdIssueId;
    Alert.alert(
      'Discard photo recovery?',
      `Issue #${issueId} will remain saved, but its pending photo retry information will be removed from this device. You can then report a new issue.`,
      [
        { text: 'Keep recovery', style: 'cancel' },
        {
          text: 'Discard recovery',
          style: 'destructive',
          onPress: () => {
            // Clear storage immediately as well as state, so a screen remount
            // cannot restore this recovery record before the effect runs.
            if (recoveryKey) AsyncStorage.removeItem(recoveryKey).catch(() => undefined);
            setAttachments([]);
            setCreatedIssueId(null);
          },
        },
      ],
    );
  }

  async function selectPhoto(source: 'camera' | 'library') {
    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      const action = permission.canAskAgain || Platform.OS === 'web'
        ? undefined
        : { text: 'Open settings', onPress: () => { Linking.openSettings().catch(() => undefined); } };
      Alert.alert('Permission needed', `Allow access to your ${source === 'camera' ? 'camera' : 'photo library'} to attach an issue photo.`, action ? [{ text: 'Cancel', style: 'cancel' }, action] : [{ text: 'OK' }]);
      return;
    }
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 4, quality: 0.8 });
    if (!result.canceled) {
      setAttachments((current) => [
        ...current,
        ...result.assets.map((photo) => ({
          key: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
          photo,
        })),
      ].slice(0, 4));
    }
  }

  const isPending = isCreatingIssue || isUploadingAttachments;
  const isSavedIssue = createdIssueId !== null;

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

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>Location</Text>
        <TextInput
          testID="issue-location"
          style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
          value={location}
          onChangeText={setLocation}
          placeholder="e.g. Kitchen, ground-floor corridor"
          placeholderTextColor={colors.mutedForeground}
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

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.foreground }]}>Photos <Text style={{ color: colors.mutedForeground }}>(optional)</Text></Text>
        <View style={styles.photoActions}>
          <TouchableOpacity testID="issue-photo-camera" style={[styles.photoButton, { borderColor: colors.border, backgroundColor: colors.card }, isPending && { opacity: 0.6 }]} onPress={() => selectPhoto('camera')} disabled={isPending}>
            <Feather name="camera" size={17} color={colors.primary} /><Text style={[styles.photoButtonText, { color: colors.foreground }]}>Take photo</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="issue-photo-library" style={[styles.photoButton, { borderColor: colors.border, backgroundColor: colors.card }, isPending && { opacity: 0.6 }]} onPress={() => selectPhoto('library')} disabled={isPending}>
            <Feather name="image" size={17} color={colors.primary} /><Text style={[styles.photoButtonText, { color: colors.foreground }]}>Photo library</Text>
          </TouchableOpacity>
        </View>
        {attachments.length > 0 && <View style={styles.photoList}>{attachments.map((attachment, index) => <View key={attachment.key} style={styles.photoWrap}><Image source={{ uri: attachment.photo.uri }} style={styles.photo} />{!attachment.objectPath && <TouchableOpacity testID={`issue-photo-remove-${index}`} disabled={isPending} onPress={() => setAttachments((current) => current.filter((currentAttachment) => currentAttachment.key !== attachment.key))} style={styles.removePhoto}><Feather name="x" size={14} color="#ffffff" /></TouchableOpacity>}</View>)}</View>}
        {isSavedIssue && <View style={styles.recoveryNotice}>
          <Text style={[styles.savedIssueHint, { color: colors.mutedForeground }]}>Issue #{createdIssueId} is already saved. {attachments.some((attachment) => !attachment.objectPath) ? 'Retry attaching its photos or finish without them.' : 'Finalizing its photos can be retried.'}</Text>
          <TouchableOpacity testID="issue-photo-recovery-discard" disabled={isPending} onPress={discardPendingRecovery}>
            <Text style={[styles.discardRecoveryText, { color: colors.destructive }]}>Discard photo recovery and report a new issue</Text>
          </TouchableOpacity>
        </View>}
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
          testID="issue-submit"
          disabled={isPending || (!isSavedIssue && (!title.trim() || !location.trim()))}
        >
          {isPending ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <>
              <Feather name="send" size={18} color="#ffffff" />
              <Text style={styles.submitText}>{isSavedIssue ? (attachments.length > 0 ? 'Retry photos' : 'Finish') : 'Report issue'}</Text>
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
  photoActions: { flexDirection: 'row', gap: 8 },
  photoButton: { flex: 1, height: 44, borderWidth: 1, borderRadius: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  photoButtonText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  photoList: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  photoWrap: { position: 'relative' },
  photo: { width: 76, height: 76, borderRadius: 6 },
  removePhoto: { position: 'absolute', right: -6, top: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: '#ef4444', alignItems: 'center', justifyContent: 'center' },
  recoveryNotice: { marginTop: 10 },
  savedIssueHint: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 18, marginTop: 10 },
  discardRecoveryText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', marginTop: 10 },
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
