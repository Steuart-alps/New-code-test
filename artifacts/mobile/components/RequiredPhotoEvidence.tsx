import React from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { StagedPhotoEvidence } from '@/hooks/useStagedPhotoEvidence';
import { STAGED_PHOTO_MAX } from './staged-photo-logic';

export function RequiredPhotoEvidence({
  evidence,
  disabled = false,
  accent,
  testIDPrefix,
}: {
  evidence: StagedPhotoEvidence;
  disabled?: boolean;
  accent?: string;
  testIDPrefix: string;
}) {
  const colors = useColors();
  const tint = accent ?? colors.primary;
  if (!evidence.enabled) return null;
  if (evidence.loading) {
    return (
      <View style={styles.row} testID={`${testIDPrefix}-loading`}>
        <ActivityIndicator color={tint} />
        <Text style={[styles.muted, { color: colors.mutedForeground }]}>Checking photo requirements…</Text>
      </View>
    );
  }
  if (evidence.loadFailed) {
    return (
      <View style={[styles.box, { borderColor: colors.border, backgroundColor: colors.card }]} testID={`${testIDPrefix}-requirements-error`}>
        <Text style={[styles.muted, { color: colors.mutedForeground }]}>
          Photo requirements could not be checked. You can still save; if photos are required you will be asked to add them.
        </Text>
        <TouchableOpacity onPress={evidence.retryRequirements} accessibilityRole="button">
          <Text style={[styles.link, { color: tint }]}>Retry photo requirements</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!evidence.required) return null;

  const busy = disabled || evidence.uploading;
  const full = evidence.photos.length >= STAGED_PHOTO_MAX;
  const met = evidence.photos.length >= evidence.minimum;
  return (
    <View
      style={[styles.box, { borderColor: met ? tint : colors.destructive + '88', backgroundColor: colors.card }]}
      accessibilityLabel="Required photo evidence"
      testID={`${testIDPrefix}-evidence`}
    >
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.foreground }]}>Required photo evidence</Text>
        <Text style={[styles.count, { color: met ? tint : colors.destructive }]} testID={`${testIDPrefix}-count`}>
          {evidence.photos.length}/{evidence.minimum}
        </Text>
      </View>
      <Text style={[styles.muted, { color: colors.mutedForeground }]}>
        Attach at least {evidence.minimum} verified {evidence.minimum === 1 ? 'photo' : 'photos'} before saving.
      </Text>
      {evidence.photos.map((photo) => (
        <View key={photo.id} style={[styles.photoRow, { borderColor: colors.border }]}>
          <Image source={{ uri: photo.uri }} style={styles.thumb} />
          <Text style={[styles.photoName, { color: colors.foreground }]} numberOfLines={1}>{photo.name}</Text>
          <TouchableOpacity
            onPress={() => evidence.removePhoto(photo.id)}
            disabled={busy}
            accessibilityLabel={`Remove ${photo.name}`}
            testID={`${testIDPrefix}-remove-${photo.id}`}
          >
            <Feather name="trash-2" size={18} color={busy ? colors.mutedForeground : colors.destructive} />
          </TouchableOpacity>
        </View>
      ))}
      {!!evidence.uploadError && (
        <Text style={[styles.error, { color: colors.destructive }]} accessibilityRole="alert">{evidence.uploadError}</Text>
      )}
      {evidence.uploading ? (
        <View style={styles.row}>
          <ActivityIndicator color={tint} />
          <Text style={[styles.muted, { color: colors.mutedForeground }]}>Verifying photo…</Text>
        </View>
      ) : (
        <View style={styles.row}>
          {(['camera', 'library'] as const).map((source) => (
            <TouchableOpacity
              key={source}
              onPress={() => void evidence.addPhoto(source)}
              disabled={busy || full}
              style={[styles.button, { borderColor: tint }, (busy || full) && styles.disabled]}
              testID={`${testIDPrefix}-add-${source}`}
            >
              <Feather name={source === 'camera' ? 'camera' : 'image'} size={16} color={tint} />
              <Text style={[styles.buttonText, { color: tint }]}>{source === 'camera' ? 'Take photo' : 'Choose photo'}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 8, marginBottom: 14 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontFamily: 'Inter_600SemiBold', fontSize: 15 },
  count: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  muted: { fontFamily: 'Inter_400Regular', fontSize: 13, flexShrink: 1 },
  link: { fontFamily: 'Inter_600SemiBold', fontSize: 14, marginTop: 6 },
  error: { fontFamily: 'Inter_500Medium', fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
  thumb: { width: 44, height: 44, borderRadius: 6 },
  photoName: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 13 },
  button: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 12 },
  buttonText: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  disabled: { opacity: 0.5 },
});
