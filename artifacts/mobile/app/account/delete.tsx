import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { CONTACT_URL, canRequestBusinessDeletion, webSettingsUrl } from '@/lib/links';

interface DeletionStatus {
  eligible: boolean;
  request: {
    id: number;
    requested_at: string;
    earliest_deletion_at: string;
    notification_state: string;
    status: 'pending' | 'approved';
  } | null;
}

const formatDate = (date: string) => new Date(date).toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London',
});

const open = (url: string) => { Linking.openURL(url).catch(() => undefined); };

/**
 * "Delete my account". Logins are created by the business, so a business
 * owner requests erasure of the whole business account through the same
 * reviewed request as the web Settings page (POST /api/data-deletion/request:
 * 30-day minimum, independent review, legal holds). Staff and viewer logins
 * belong to the business, so their manager removes them.
 */
export default function DeleteAccountScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const owner = canRequestBusinessDeletion(user?.role);
  const [error, setError] = useState('');

  const status = useQuery<DeletionStatus>({
    queryKey: ['data-deletion-request', user?.clientId],
    enabled: owner && user?.clientId != null,
    queryFn: () => apiFetch('/api/data-deletion/request'),
  });

  const submit = useMutation({
    mutationFn: () => apiFetch('/api/data-deletion/request', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: async () => {
      setError('');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await queryClient.invalidateQueries({ queryKey: ['data-deletion-request'] });
    },
    onError: async (err: Error) => {
      setError(err.message || 'Could not submit the deletion request.');
      // The request may have been saved even if the notification failed.
      await queryClient.invalidateQueries({ queryKey: ['data-deletion-request'] });
    },
  });

  function confirmRequest() {
    Alert.alert(
      'Request permanent deletion?',
      'Nothing is deleted now. Your business account and its records are kept for at least 30 days while an administrator reviews the request and any legal retention obligations. If deletion is approved and carried out, it cannot be undone.',
      [
        { text: 'Keep my data', style: 'cancel' },
        { text: 'Submit request', style: 'destructive', onPress: () => submit.mutate() },
      ],
    );
  }

  const request = status.data?.request ?? null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={[styles.hero, { backgroundColor: colors.navy, paddingTop: (Platform.OS === 'web' ? 24 : insets.top) + 12 }]}>
        <TouchableOpacity
          testID="delete-account-back"
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="arrow-left" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.heroTitle} accessibilityRole="header">Delete my account</Text>
      </View>

      <View style={styles.section}>
        {!owner ? (
          <>
            <Text style={[styles.body, { color: colors.foreground }]}>
              Your ComplyTrack login was created by your employer and belongs to their business account. To delete it, ask your manager (a ComplyTrack admin for your business) to remove you. Your check records stay with the business as part of its compliance history.
            </Text>
            <Text style={[styles.body, { color: colors.mutedForeground }]}>
              If you cannot reach your manager, or you want to exercise another data protection right, contact ALPS Consultancy.
            </Text>
            <TouchableOpacity
              testID="delete-account-contact"
              style={[styles.button, { backgroundColor: colors.navy }]}
              onPress={() => open(CONTACT_URL)}
              accessibilityRole="link"
            >
              <Text style={styles.buttonText}>Contact ALPS Consultancy</Text>
            </TouchableOpacity>
          </>
        ) : status.isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
        ) : status.isError ? (
          <>
            <Text style={[styles.body, { color: colors.foreground }]}>
              {status.error instanceof Error ? status.error.message : 'The deletion request status could not be loaded.'}
            </Text>
            <TouchableOpacity style={[styles.button, { backgroundColor: colors.navy }]} onPress={() => status.refetch()} accessibilityRole="button">
              <Text style={styles.buttonText}>Try again</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.linkButton} onPress={() => open(CONTACT_URL)} accessibilityRole="link">
              <Text style={[styles.link, { color: colors.primary }]}>Contact ALPS Consultancy</Text>
            </TouchableOpacity>
          </>
        ) : request ? (
          <View testID="delete-account-request" style={[styles.notice, { backgroundColor: colors.warning + '14', borderColor: colors.warning + '66' }]}>
            <Text style={[styles.noticeTitle, { color: colors.foreground }]}>
              {request.status === 'approved' ? 'Deletion request approved' : 'Deletion request received'}
            </Text>
            <Text style={[styles.body, { color: colors.foreground, marginBottom: 0 }]}>
              Requested {formatDate(request.requested_at)}. Records are kept for at least 30 days, until {formatDate(request.earliest_deletion_at)}.{' '}
              {request.status === 'approved'
                ? 'A reviewer approved this request; deletion happens no earlier than that date, subject to legal holds, and cannot be undone.'
                : 'An administrator will review legal retention requirements before anything is deleted.'}
            </Text>
            {request.notification_state !== 'sent' && (
              <Text style={[styles.body, { color: colors.mutedForeground, marginBottom: 0, marginTop: 8 }]}>
                The administrator has not been notified yet. Contact ALPS Consultancy if this does not resolve.
              </Text>
            )}
          </View>
        ) : status.data?.eligible ? (
          <>
            <Text style={[styles.body, { color: colors.foreground }]}>
              As the account owner you can request permanent deletion of your business account, every login in it, and its compliance records.
            </Text>
            <Text style={[styles.body, { color: colors.mutedForeground }]}>
              Nothing is deleted when you submit. Records are kept for at least 30 days while an administrator reviews the request and any legal obligations. Download anything you need from the web app first.
            </Text>
            <TouchableOpacity
              testID="delete-account-submit"
              style={[styles.button, { backgroundColor: colors.destructive }, submit.isPending && { opacity: 0.6 }]}
              onPress={confirmRequest}
              disabled={submit.isPending}
              accessibilityRole="button"
            >
              {submit.isPending ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Request account deletion</Text>}
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={[styles.body, { color: colors.foreground }]}>
              Your business has an active subscription. Deleting the account removes the records of everyone in your business, so deletion can be requested once the subscription is cancelled.
            </Text>
            <Text style={[styles.body, { color: colors.mutedForeground }]}>
              Cancel the subscription in Settings on the ComplyTrack website, then come back here (or use Settings → Data deletion on the website). Contact ALPS Consultancy if you need help.
            </Text>
            <TouchableOpacity style={[styles.button, { backgroundColor: colors.navy }]} onPress={() => open(webSettingsUrl())} accessibilityRole="link">
              <Text style={styles.buttonText}>Open web settings</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.linkButton} onPress={() => open(CONTACT_URL)} accessibilityRole="link">
              <Text style={[styles.link, { color: colors.primary }]}>Contact ALPS Consultancy</Text>
            </TouchableOpacity>
          </>
        )}
        {!!error && <Text accessibilityRole="alert" style={[styles.body, { color: colors.destructive, marginTop: 12 }]}>{error}</Text>}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingBottom: 18 },
  heroTitle: { color: '#fff', fontSize: 20, fontFamily: 'Inter_700Bold', flex: 1 },
  section: { padding: 16 },
  body: { fontSize: 15, fontFamily: 'Inter_400Regular', lineHeight: 22, marginBottom: 14 },
  notice: { borderWidth: 1, borderRadius: 8, padding: 14 },
  noticeTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginBottom: 6 },
  button: { minHeight: 50, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 12, marginTop: 6 },
  buttonText: { color: '#fff', fontSize: 15, fontFamily: 'Inter_600SemiBold', textAlign: 'center' },
  linkButton: { paddingVertical: 14, alignItems: 'center' },
  link: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
});
