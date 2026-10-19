import React from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import { apiBaseUrl, apiFetch, getToken } from '@/lib/api';
import {
  photoObjectPath,
  photoUrl,
  toRosterMember,
  toTrainRecord,
  type CourseState,
  type PersonStatus,
} from '@/components/train-track-logic';

export const MODULE_COLOR = '#7c3aed';

/** Shared by the TrainTrack list and person screens so both read one cached copy. */
export function trainRecordsQuery(clientId: number | null | undefined) {
  return {
    queryKey: ['train-track-records-raw', clientId],
    queryFn: async () => (await apiFetch<unknown[]>('/api/train-track/records')).map(toTrainRecord),
  };
}

export function staffRosterQuery(clientId: number | null | undefined) {
  return {
    queryKey: ['staff-roster', clientId],
    queryFn: async () => (await apiFetch<unknown[]>('/api/staff-roster')).map(toRosterMember),
  };
}

export function statusColor(status: PersonStatus | CourseState, colors: ReturnType<typeof useColors>): string {
  if (status === 'expired') return colors.destructive;
  if (status === 'missing') return '#c2410c';
  if (status === 'expiring_soon') return colors.warning;
  if (status === 'no_expiry') return colors.mutedForeground;
  return colors.success;
}

/** Photos of a scanned certificate attached on the website (read-only). */
export function CertificatePhotos({ recordId }: { recordId: number }) {
  const colors = useColors();
  const base = apiBaseUrl();
  const token = getToken();
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['train-track-photos', recordId],
    queryFn: async () => (await apiFetch<unknown[]>(`/api/photos?entityType=training_record&entityId=${recordId}`))
      .map(photoObjectPath)
      .filter((path): path is string => !!path),
  });
  if (isLoading) return <ActivityIndicator color={MODULE_COLOR} style={{ marginTop: 8 }} />;
  if (error) {
    return (
      <Text style={[styles.note, { color: colors.destructive }]}>
        Could not load certificate photos. {error instanceof Error ? error.message : ''}
      </Text>
    );
  }
  if (data.length === 0 || !base) {
    return <Text style={[styles.note, { color: colors.mutedForeground }]}>No certificate photos attached.</Text>;
  }
  return (
    <View style={styles.photos}>
      {data.map((path, index) => (
        <Image
          key={path}
          accessibilityLabel={`Certificate photo ${index + 1} of ${data.length}`}
          source={{ uri: photoUrl(base, path), headers: token ? { Authorization: `Bearer ${token}` } : undefined }}
          style={[styles.photo, { borderColor: colors.border }]}
          resizeMode="cover"
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 8 },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  photo: { width: 140, height: 180, borderRadius: 6, borderWidth: 1 },
});
