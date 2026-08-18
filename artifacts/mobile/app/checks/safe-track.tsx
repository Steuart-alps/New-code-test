/**
 * SafeTrack Screen
 * Shows Risk Assessments, SOPs, and Staff Handbook entries that the current
 * user may need to acknowledge. Gated behind hasService("safetrack").
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
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';

const MODULE_COLOR = '#6366f1';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RiskAssessment {
  id: number;
  title: string;
  description: string | null;
  status: string;
  assessedBy: string | null;
  reviewDate: string | null;
  requiresAcknowledgement: boolean;
  createdAt: string;
}

interface Sop {
  id: number;
  title: string;
  scope: string | null;
  version: string;
  requiresAcknowledgement: boolean;
  createdAt: string;
}

interface Handbook {
  id: number;
  title: string;
  section: string | null;
  version: string;
  requiresAcknowledgement: boolean;
  createdAt: string;
}

interface Ack {
  acknowledged_by: number | null;
  staff_name: string;
}

type TabKey = 'risk' | 'sops' | 'handbook';

const TAB_CONFIG: { key: TabKey; label: string; sub: string; icon: React.ComponentProps<typeof Feather>['name'] }[] = [
  { key: 'risk',     label: 'Risk Assessments', sub: 'risk-assessments', icon: 'file-text' },
  { key: 'sops',     label: 'SOPs',             sub: 'sops',             icon: 'clipboard' },
  { key: 'handbook', label: 'Handbook',          sub: 'handbook',         icon: 'book-open' },
];

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

// ── DocCard ───────────────────────────────────────────────────────────────────

function DocCard({
  id,
  title,
  subtitle,
  requiresAcknowledgement,
  sub,
  userId,
  userName,
  onAckSuccess,
}: {
  id: number;
  title: string;
  subtitle: string | null;
  requiresAcknowledgement: boolean;
  sub: string;
  userId: number | null;
  userName: string;
  onAckSuccess: () => void;
}) {
  const colors = useColors();
  const qc = useQueryClient();

  const { data: acks = [], isLoading: acksLoading } = useQuery<Ack[]>({
    queryKey: ['safetrack-acks', sub, id],
    queryFn: () => apiFetch(`/api/safe-track/${sub}/${id}/acknowledgements`),
    enabled: requiresAcknowledgement,
  });

  const alreadyAcked = userId != null
    ? acks.some((a) => a.acknowledged_by === userId)
    : false;

  const { mutate: acknowledge, isPending } = useMutation({
    mutationFn: () =>
      apiFetch(`/api/safe-track/${sub}/${id}/self-acknowledge`, {
        method: 'POST',
        body: JSON.stringify({ staffName: userName }),
      }),
    onSuccess: async (data: any) => {
      if (data?.alreadyAcknowledged) {
        Alert.alert('Already acknowledged', 'You have already confirmed you have read this document.');
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['safetrack-acks', sub, id] });
      onAckSuccess();
    },
    onError: (err: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', err.message || 'Could not record acknowledgement.');
    },
  });

  function handleAck() {
    Alert.alert(
      'Confirm acknowledgement',
      `By tapping Confirm, you acknowledge that you have read and understood "${title}".`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Confirm', onPress: () => acknowledge() },
      ],
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.cardBody}>
        <Text style={[styles.cardTitle, { color: colors.foreground }]} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.cardSub, { color: colors.mutedForeground }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {requiresAcknowledgement && (
        <View style={styles.ackArea}>
          {acksLoading ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : alreadyAcked ? (
            <View style={styles.ackedBadge}>
              <Feather name="check-circle" size={14} color="#22c55e" />
              <Text style={styles.ackedText}>Acknowledged</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.ackBtn, { backgroundColor: MODULE_COLOR }, isPending && { opacity: 0.6 }]}
              onPress={handleAck}
              disabled={isPending}
            >
              {isPending ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text style={styles.ackBtnText}>Acknowledge</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function SafeTrackScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { hasService, user } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const [activeTab, setActiveTab] = useState<TabKey>('risk');
  const [refreshing, setRefreshing] = useState(false);

  // Service gate
  if (!hasService('safetrack')) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>SafeTrack</Text>
        <Text style={[styles.gatedSub, { color: colors.mutedForeground }]}>
          SafeTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  const {
    data: ras = [],
    isLoading: rasLoading,
    refetch: refetchRas,
  } = useQuery<RiskAssessment[]>({
    queryKey: ['safetrack-ras'],
    queryFn: () => apiFetch('/api/safe-track/risk-assessments'),
  });

  const {
    data: sops = [],
    isLoading: sopsLoading,
    refetch: refetchSops,
  } = useQuery<Sop[]>({
    queryKey: ['safetrack-sops'],
    queryFn: () => apiFetch('/api/safe-track/sops'),
  });

  const {
    data: handbook = [],
    isLoading: handbookLoading,
    refetch: refetchHandbook,
  } = useQuery<Handbook[]>({
    queryKey: ['safetrack-handbook'],
    queryFn: () => apiFetch('/api/safe-track/handbook'),
  });

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([refetchRas(), refetchSops(), refetchHandbook()]);
    setRefreshing(false);
  }

  const currentTab = TAB_CONFIG.find((t) => t.key === activeTab)!;
  const isLoading = activeTab === 'risk' ? rasLoading : activeTab === 'sops' ? sopsLoading : handbookLoading;
  const items: Array<{ id: number; title: string; subtitle: string | null; requiresAcknowledgement: boolean }> =
    activeTab === 'risk'
      ? ras.map((r) => ({
          id: r.id,
          title: r.title,
          subtitle: r.assessedBy ? `Assessed by ${r.assessedBy}` : r.reviewDate ? `Review: ${formatDate(r.reviewDate)}` : null,
          requiresAcknowledgement: r.requiresAcknowledgement,
        }))
      : activeTab === 'sops'
      ? sops.map((s) => ({
          id: s.id,
          title: s.title,
          subtitle: s.scope ?? null,
          requiresAcknowledgement: s.requiresAcknowledgement,
        }))
      : handbook.map((h) => ({
          id: h.id,
          title: h.title,
          subtitle: h.section ?? null,
          requiresAcknowledgement: h.requiresAcknowledgement,
        }));

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 40 }}
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
              <Feather name="shield" size={14} color={MODULE_COLOR} />
              <Text style={[styles.moduleBadgeText, { color: MODULE_COLOR }]}>SafeTrack</Text>
            </View>
            <Text style={styles.headerTitle}>Safety Documents</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
      </View>

      {/* Tabs */}
      <View style={[styles.tabBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        {TAB_CONFIG.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[
              styles.tab,
              activeTab === tab.key && { borderBottomColor: MODULE_COLOR, borderBottomWidth: 2 },
            ]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Feather
              name={tab.icon}
              size={15}
              color={activeTab === tab.key ? MODULE_COLOR : colors.mutedForeground}
            />
            <Text
              style={[
                styles.tabText,
                { color: activeTab === tab.key ? MODULE_COLOR : colors.mutedForeground },
                activeTab === tab.key && { fontFamily: 'Inter_600SemiBold' },
              ]}
            >
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      <View style={styles.content}>
        {isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 32 }} />
        ) : items.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name={currentTab.icon} size={28} color={colors.mutedForeground} style={{ opacity: 0.4 }} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No {currentTab.label.toLowerCase()} yet
            </Text>
          </View>
        ) : (
          items.map((item) => (
            <DocCard
              key={item.id}
              id={item.id}
              title={item.title}
              subtitle={item.subtitle}
              requiresAcknowledgement={item.requiresAcknowledgement}
              sub={currentTab.sub}
              userId={user?.id ?? null}
              userName={user?.name ?? 'Unknown'}
              onAckSuccess={() => {
                Alert.alert('Acknowledged', 'Your acknowledgement has been recorded.');
              }}
            />
          ))
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
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  content: {
    padding: 16,
    gap: 10,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    gap: 12,
  },
  cardBody: {
    flex: 1,
    gap: 3,
  },
  cardTitle: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    lineHeight: 20,
  },
  cardSub: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  ackArea: {
    flexShrink: 0,
    alignItems: 'flex-end',
  },
  ackedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ackedText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: '#22c55e',
  },
  ackBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    minWidth: 100,
    alignItems: 'center',
  },
  ackBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 32,
    alignItems: 'center',
    gap: 10,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
});
