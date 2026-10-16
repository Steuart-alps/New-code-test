/**
 * Contractor email approvals (managers): FixTrack and compliance emails
 * waiting to be sent to contractors, grouped by site like the website's
 * Contractor Approvals page. Approve & Send and Cancel / Dismiss use the
 * existing endpoints and need a connection (they send or withdraw an email
 * at once, so they are never queued on the phone). Editing an email's wording
 * stays on the website.
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { isConnectionError, onlineActionMessage } from '@/components/outbox-status-logic';
import {
  approvalButtonLabel,
  approvalConfirmation,
  approvalRequest,
  approvalSuccessMessage,
  canApproveContractorEmails,
  emailTypeLabel,
  formatDay,
  groupApprovalsBySite,
  isCancellation,
  normalizeQueueItems,
  type ApprovalAction,
  type ContractorEmailQueueItem,
} from '@/components/contractors-logic';

const TAG_COLOR: Record<string, string> = {
  cancellation: '#b45309',
  quote_request: '#7c3aed',
};

export default function ContractorApprovalsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const allowed = canApproveContractorEmails(user?.role);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const queueQuery = useQuery({
    queryKey: ['contractor-email-queue', user?.clientId],
    queryFn: async () => normalizeQueueItems(await apiFetch('/api/fix-track/contractor-email-queue?status=pending')),
    enabled: allowed,
  });

  const action = useMutation({
    mutationFn: async ({ item, kind }: { item: ContractorEmailQueueItem; kind: ApprovalAction }) => {
      const request = approvalRequest(item.id, kind);
      await apiFetch(request.path, request.init);
      return { item, kind };
    },
    onSuccess: ({ item, kind }) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.setQueryData<ContractorEmailQueueItem[]>(['contractor-email-queue', user?.clientId],
        (current) => current?.filter((row) => row.id !== item.id));
      void queryClient.invalidateQueries({ queryKey: ['contractor-email-queue-count'] });
      Alert.alert(approvalSuccessMessage(item, kind));
    },
    onError: (err: unknown, { kind }) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(kind === 'approve' ? 'Email not sent' : 'Email not cancelled', onlineActionMessage(err));
      // Someone else may have dealt with it already; show the current queue.
      if (!isConnectionError(err)) void queueQuery.refetch();
    },
  });

  function run(item: ContractorEmailQueueItem, kind: ApprovalAction) {
    const question = approvalConfirmation(item, kind);
    if (!question) {
      action.mutate({ item, kind });
      return;
    }
    const cancellation = isCancellation(item);
    Alert.alert(
      kind === 'approve' ? 'Approve calendar cancellation?' : cancellation ? 'Dismiss calendar cancellation?' : 'Cancel this email?',
      question,
      [
        { text: kind === 'approve' || cancellation ? 'Go back' : 'Keep it', style: 'cancel' },
        {
          text: approvalButtonLabel(item, kind),
          style: kind === 'dismiss' ? 'destructive' : 'default',
          onPress: () => action.mutate({ item, kind }),
        },
      ],
    );
  }

  const toggle = (id: number) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const items = queueQuery.data ?? [];
  const busyId = action.isPending ? action.variables?.item.id : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={queueQuery.isRefetching} onRefresh={() => void queueQuery.refetch()} tintColor={colors.primary} />}
    >
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
        <TouchableOpacity testID="approvals-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
          <Feather name="arrow-left" size={22} color="#ffffff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Contractor Email Approvals</Text>
        <Text style={styles.headerSub}>Review and approve outbound emails before they are sent to contractors.</Text>
      </View>

      <View style={styles.content}>
        {!allowed ? (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Manager approval required.</Text>
        ) : queueQuery.isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
        ) : queueQuery.isError ? (
          <View style={styles.empty}>
            <Text role="alert" style={[styles.emptyText, { color: colors.destructive }]}>
              {isConnectionError(queueQuery.error)
                ? 'Pending contractor emails need a connection to load.'
                : "We couldn't load pending contractor emails. Please try again."}
            </Text>
            <TouchableOpacity accessibilityRole="button" onPress={() => void queueQuery.refetch()}>
              <Text style={[styles.link, { color: colors.primary }]}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.empty} testID="approvals-empty">
            <Feather name="check-circle" size={36} color="#059669" />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>All caught up</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No contractor emails are waiting for approval.</Text>
          </View>
        ) : (
          <>
            <Text style={[styles.note, { color: colors.mutedForeground }]}>
              Approving sends the email straight away, so it needs a connection. To change an email's wording first, use Edit on the website.
            </Text>
            {groupApprovalsBySite(items).map(([site, siteItems]) => (
              <View key={site} style={{ gap: 10 }}>
                <Text style={[styles.siteTitle, { color: colors.foreground }]}>{site} ({siteItems.length})</Text>
                {siteItems.map((item) => {
                  const cancellation = isCancellation(item);
                  const tagColor = TAG_COLOR[item.emailType] ?? '#2563eb';
                  const open = expanded.has(item.id);
                  const busy = busyId === item.id;
                  return (
                    <View key={item.id} testID={`approval-${item.id}`} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                      <View style={styles.tagRow}>
                        <View style={[styles.tag, { borderColor: tagColor + '55', backgroundColor: tagColor + '14' }]}>
                          <Text style={[styles.tagText, { color: tagColor }]}>{emailTypeLabel(item).toUpperCase()}</Text>
                        </View>
                        {item.createdAt ? (
                          <Text style={[styles.small, { color: colors.mutedForeground }]}>{formatDay(item.createdAt)}</Text>
                        ) : null}
                      </View>
                      <Text style={[styles.cardTitle, { color: colors.foreground }]}>{item.jobTitle || 'Untitled Job'}</Text>
                      <Text style={[styles.small, { color: colors.mutedForeground }]}>{item.contractorName || 'Unknown Contractor'}</Text>
                      {item.requestedBy ? (
                        <Text style={[styles.small, { color: colors.mutedForeground }]}>Requested by: {item.requestedBy}</Text>
                      ) : null}
                      {cancellation && (
                        <View style={styles.warning}>
                          <Text style={styles.warningTitle}>This cancels an existing calendar event</Text>
                          <Text style={styles.warningText}>
                            Approving sends the contractor a cancellation notice and removes the previously sent assignment from their calendar.
                          </Text>
                        </View>
                      )}
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityState={{ expanded: open }}
                        onPress={() => toggle(item.id)}
                        style={[styles.preview, { borderColor: colors.border, backgroundColor: colors.background }]}
                      >
                        <Text style={[styles.previewSubject, { color: colors.foreground }]}>Subject: {item.subject}</Text>
                        <Text style={[styles.previewText, { color: colors.foreground }]} numberOfLines={open ? undefined : 4}>{item.text}</Text>
                        <Text style={[styles.small, { color: colors.primary }]}>{open ? 'Show less' : 'Show full email'}</Text>
                      </TouchableOpacity>
                      <View style={styles.actions}>
                        <TouchableOpacity
                          testID={`approval-dismiss-${item.id}`}
                          accessibilityRole="button"
                          disabled={action.isPending}
                          onPress={() => run(item, 'dismiss')}
                          style={[styles.secondaryBtn, { borderColor: colors.border }, action.isPending && styles.disabled]}
                        >
                          <Text style={[styles.secondaryText, { color: colors.foreground }]}>{approvalButtonLabel(item, 'dismiss')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          testID={`approval-approve-${item.id}`}
                          accessibilityRole="button"
                          disabled={action.isPending}
                          onPress={() => run(item, 'approve')}
                          style={[styles.primaryBtn, { backgroundColor: cancellation ? '#d97706' : '#2563eb' }, action.isPending && styles.disabled]}
                        >
                          {busy ? <ActivityIndicator color="#ffffff" size="small" /> : (
                            <Feather name={cancellation ? 'calendar' : 'send'} size={14} color="#ffffff" />
                          )}
                          <Text style={styles.primaryText}>{approvalButtonLabel(item, 'approve')}</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
              </View>
            ))}
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  back: { marginBottom: 10, alignSelf: 'flex-start', padding: 2 },
  headerTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: '#ffffff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter_400Regular' },
  content: { padding: 16, gap: 14 },
  note: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  siteTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  card: { borderWidth: 1, borderRadius: 8, padding: 14, gap: 6 },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  tag: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  tagText: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 0.5 },
  cardTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  small: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  warning: { borderWidth: 1, borderColor: '#fde68a', backgroundColor: '#fffbeb', borderRadius: 6, padding: 10, gap: 2, marginTop: 4 },
  warningTitle: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: '#78350f' },
  warningText: { fontSize: 12, fontFamily: 'Inter_400Regular', color: '#92400e' },
  preview: { borderWidth: 1, borderRadius: 6, padding: 10, gap: 6, marginTop: 4 },
  previewSubject: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  previewText: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  secondaryBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, minHeight: 40, justifyContent: 'center' },
  secondaryText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 8, paddingHorizontal: 14, minHeight: 40 },
  primaryText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: '#ffffff' },
  disabled: { opacity: 0.5 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 32, paddingHorizontal: 12 },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  link: { fontSize: 14, fontFamily: 'Inter_500Medium' },
});
