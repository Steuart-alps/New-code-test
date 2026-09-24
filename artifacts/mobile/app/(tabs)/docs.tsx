import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';

type Tab = 'my-documents' | 'documents' | 'training';

interface DocFile {
  id: number;
  title: string;
  category: string | null;
  created_at: string;
}

interface MyDoc {
  id: number;
  title: string;
  category: string | null;
  description: string | null;
  file_name: string | null;
  mime_type: string | null;
  site_name: string | null;
  department: string | null;
  acknowledged_at: string | null;
  signature: string | null;
}

interface MyAcknowledgements {
  rosterLinked: boolean;
  pending: MyDoc[];
  completed: MyDoc[];
}

interface TrainingRecord {
  id: number;
  staffName: string;
  courseName: string;
  completedAt: string | null;
  expiresAt: string | null;
  status: 'valid' | 'expiring_soon' | 'expired';
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

function formatCategory(category: string | null): string {
  if (!category) return '';
  return category
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function MyDocumentRow({
  doc,
  completed = false,
  onRead,
  onAcknowledge,
  isOpening,
  canAcknowledge = false,
  signature,
  onSignatureChange,
  isSaving,
}: {
  doc: MyDoc;
  completed?: boolean;
  onRead: (doc: MyDoc) => void;
  onAcknowledge?: (doc: MyDoc) => void;
  isOpening: boolean;
  canAcknowledge?: boolean;
  signature?: string;
  onSignatureChange?: (doc: MyDoc, value: string) => void;
  isSaving?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.rowIcon, { backgroundColor: colors.primary + '1a' }]}>
        <Feather name="file-text" size={18} color={colors.primary} />
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: colors.foreground }]}>{doc.title}</Text>
        {!!doc.category && (
          <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
            {formatCategory(doc.category)}
          </Text>
        )}
        {(doc.site_name || doc.department) && (
          <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
            {[doc.site_name, doc.department].filter(Boolean).join(' · ')}
          </Text>
        )}
        <Text style={[styles.rowSub, { color: completed ? colors.success : colors.warning, marginTop: 5 }]}>
          {completed && doc.acknowledged_at
            ? `Acknowledged ${new Date(doc.acknowledged_at).toLocaleDateString()}`
            : 'Awaiting your acknowledgement'}
        </Text>
        {!completed && onAcknowledge && (
          <View style={styles.signatureField}>
            <Text style={[styles.signatureLabel, { color: colors.mutedForeground }]}>
              Typed signature (optional)
            </Text>
            <TextInput
              value={signature ?? ''}
              onChangeText={(value) => onSignatureChange?.(doc, value)}
              placeholder="Enter your signature"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="words"
              returnKeyType="done"
              style={[
                styles.signatureInput,
                { color: colors.foreground, borderColor: colors.border },
              ]}
            />
          </View>
        )}
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.ackBtn, { backgroundColor: colors.primary }]}
            onPress={() => onRead(doc)}
            disabled={isOpening}
            activeOpacity={0.8}
          >
            {isOpening ? <ActivityIndicator color="#ffffff" size="small" /> : (
              <>
                <Feather name="book-open" size={13} color="#ffffff" />
                <Text style={styles.ackBtnText}>Open / read</Text>
              </>
            )}
          </TouchableOpacity>
          {!completed && onAcknowledge && (
            <>
              <TouchableOpacity
                style={[
                  styles.ackBtn,
                  {
                    backgroundColor: canAcknowledge && !isSaving
                      ? colors.navy
                      : colors.mutedForeground,
                  },
                ]}
                onPress={() => onAcknowledge(doc)}
                disabled={!canAcknowledge || !!isSaving}
                activeOpacity={0.8}
              >
                {isSaving
                  ? <ActivityIndicator color="#ffffff" size="small" />
                  : (
                    <>
                      <Feather name="check" size={13} color="#ffffff" />
                      <Text style={styles.ackBtnText}>Acknowledge</Text>
                    </>
                  )}
              </TouchableOpacity>
              {!canAcknowledge && (
                <Text style={[styles.ackHelp, { color: colors.mutedForeground }]}>
                  Open and read this document before acknowledging it.
                </Text>
              )}
            </>
          )}
        </View>
      </View>
    </View>
  );
}

function TrainingRow({ record }: { record: TrainingRecord }) {
  const colors = useColors();
  const days = daysUntil(record.expiresAt);
  let accent = colors.success;
  let expLabel = record.expiresAt
    ? `Expires in ${days} days`
    : 'No expiry';
  if (!record.completedAt) {
    expLabel = 'Not completed';
    accent = colors.mutedForeground;
  } else if (record.status === 'expired' || (days !== null && days < 0)) {
    expLabel = 'Expired';
    accent = colors.destructive;
  } else if (record.status === 'expiring_soon' || (days !== null && days <= 30)) {
    accent = colors.warning;
    expLabel = `Expires in ${days} days`;
  }

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={[styles.rowIcon, { backgroundColor: accent + '1a' }]}>
        <Feather name="award" size={18} color={accent} />
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: colors.foreground }]}>
          {record.courseName}
        </Text>
        <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
          {record.staffName}
        </Text>
        <Text style={[styles.rowBadge, { color: accent }]}>{expLabel}</Text>
      </View>
    </View>
  );
}

export default function DocsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('my-documents');
  const [signatures, setSignatures] = useState<Record<number, string>>({});
  const [openingDocId, setOpeningDocId] = useState<number | null>(null);
  const [openedDocIds, setOpenedDocIds] = useState<Set<number>>(() => new Set());
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const {
    data: myAcknowledgements,
    isLoading: myDocsLoading,
    isError: myDocsError,
    error: myDocsErrorValue,
    refetch: refetchMyDocs,
    isRefetching: myDocsRefetching,
  } = useQuery<MyAcknowledgements>({
    queryKey: ['doc-track-my-acknowledgements'],
    queryFn: () => apiFetch<MyAcknowledgements>('/api/doc-track/acknowledgements/my'),
  });

  const {
    data: docs = [],
    isLoading: docsLoading,
    isError: docsError,
    error: docsErrorValue,
    refetch: refetchDocs,
    isRefetching: docsRefetching,
  } = useQuery<DocFile[]>({
    queryKey: ['doctrack-documents'],
    queryFn: () => apiFetch<DocFile[]>('/api/doc-track/documents'),
  });

  const {
    data: training = [],
    isLoading: trainingLoading,
    isError: trainingError,
    error: trainingErrorValue,
    refetch: refetchTraining,
    isRefetching: trainingRefetching,
  } = useQuery<TrainingRecord[]>({
    queryKey: ['traintrack-records'],
    queryFn: () => apiFetch<TrainingRecord[]>('/api/traintrack/staff'),
  });

  const acknowledgeMutation = useMutation({
    mutationFn: ({ doc, signature }: { doc: MyDoc; signature: string }) =>
      apiFetch<{ created: number; records: unknown[] }>(
        `/api/doc-track/documents/${doc.id}/acknowledge`,
        {
          method: 'POST',
          body: JSON.stringify({ self: true, signature: signature.trim() || null }),
        },
      ),
    onSuccess: async (_result, { doc }) => {
      setSignatures((current) => {
        const next = { ...current };
        delete next[doc.id];
        return next;
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['doc-track-my-acknowledgements'] }),
        qc.invalidateQueries({ queryKey: ['doctrack-documents'] }),
      ]);
    },
    onError: (error: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not acknowledge document', error.message);
    },
  });

  async function openDocument(doc: MyDoc) {
    try {
      setOpeningDocId(doc.id);
      const response = await apiFetch<{ downloadUrl: string }>(
        `/api/doc-track/documents/${doc.id}/download-url`,
      );
      await Linking.openURL(response.downloadUrl);
      setOpenedDocIds((current) => new Set(current).add(doc.id));
    } catch (error) {
      Alert.alert(
        'Could not open document',
        error instanceof Error ? error.message : 'Please try again.',
      );
    } finally {
      setOpeningDocId(null);
    }
  }

  const isLoading =
    tab === 'my-documents' ? myDocsLoading : tab === 'documents' ? docsLoading : trainingLoading;
  const isRefreshing =
    tab === 'my-documents' ? myDocsRefetching : tab === 'documents' ? docsRefetching : trainingRefetching;
  const onRefresh =
    tab === 'my-documents' ? refetchMyDocs : tab === 'documents' ? refetchDocs : refetchTraining;
  const currentError =
    tab === 'my-documents' ? myDocsErrorValue : tab === 'documents' ? docsErrorValue : trainingErrorValue;
  const hasError =
    tab === 'my-documents' ? myDocsError : tab === 'documents' ? docsError : trainingError;

  const showEmpty = (icon: React.ComponentProps<typeof Feather>['name'], title: string, message: string) => (
    <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Feather name={icon} size={32} color={colors.mutedForeground} />
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>{title}</Text>
      <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>{message}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: colors.navy, paddingTop: topPad + 16 },
        ]}
      >
        <Text style={styles.headerTitle}>Documents &amp; Training</Text>

        {/* Tab bar */}
        <View
          style={[styles.tabBar, { backgroundColor: 'rgba(255,255,255,0.1)' }]}
        >
          {(['my-documents', 'documents', 'training'] as Tab[]).map((t) => (
            <TouchableOpacity
              key={t}
              style={[
                styles.tabItem,
                tab === t && { backgroundColor: '#ffffff' },
              ]}
              onPress={() => setTab(t)}
            >
              <Text
                style={[
                  styles.tabText,
                  {
                    color:
                      tab === t ? colors.navy : 'rgba(255,255,255,0.7)',
                  },
                ]}
              >
                {t === 'my-documents' ? 'My Documents' : t === 'documents' ? 'Documents' : 'Training'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Content */}
      <ScrollView
        contentContainerStyle={[
          styles.list,
          { paddingBottom: Platform.OS === 'web' ? 34 : 16 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={!!isRefreshing}
            onRefresh={() => { onRefresh(); }}
            tintColor={colors.primary}
          />
        }
      >
        {isLoading ? (
          <ActivityIndicator
            color={colors.primary}
            style={{ marginTop: 48 }}
          />
        ) : hasError ? (
          <View style={[styles.error, { backgroundColor: colors.card, borderColor: colors.destructive }]}>
            <Feather name="alert-circle" size={24} color={colors.destructive} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Could not load {tab === 'my-documents' ? 'your documents' : tab}</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              {currentError instanceof Error ? currentError.message : 'Please try again.'}
            </Text>
            <TouchableOpacity style={[styles.retryBtn, { backgroundColor: colors.navy }]} onPress={() => { onRefresh(); }}>
              <Text style={styles.ackBtnText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : tab === 'my-documents' ? (
          !myAcknowledgements?.rosterLinked ? (
            showEmpty('link-2', 'Staff record not linked', 'Your account is not linked to an active staff roster record. Ask a manager to check your roster email before signing off documents.')
          ) : (
            <>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Pending</Text>
                <Text style={[styles.sectionCount, { color: colors.warning }]}>{myAcknowledgements.pending.length}</Text>
              </View>
              {myAcknowledgements.pending.length
                ? myAcknowledgements.pending.map((doc) => (
                  <MyDocumentRow
                    key={`pending-${doc.id}`}
                    doc={doc}
                    onRead={openDocument}
                    onAcknowledge={(selected) =>
                      acknowledgeMutation.mutate({
                        doc: selected,
                        signature: signatures[selected.id] ?? '',
                      })
                    }
                    signature={signatures[doc.id] ?? ''}
                    onSignatureChange={(selected, value) =>
                      setSignatures((current) => ({ ...current, [selected.id]: value }))
                    }
                    isSaving={acknowledgeMutation.isPending}
                    canAcknowledge={openedDocIds.has(doc.id)}
                    isOpening={openingDocId === doc.id}
                  />
                ))
                : showEmpty('check-circle', 'All caught up', 'You have no documents waiting for acknowledgement.')}
              <View style={[styles.sectionHeader, { marginTop: 16 }]}>
                <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Completed</Text>
                <Text style={[styles.sectionCount, { color: colors.success }]}>{myAcknowledgements.completed.length}</Text>
              </View>
              {myAcknowledgements.completed.length
                ? myAcknowledgements.completed.map((doc) => (
                  <MyDocumentRow
                    key={`completed-${doc.id}`}
                    doc={doc}
                    completed
                    onRead={openDocument}
                    isOpening={openingDocId === doc.id}
                  />
                ))
                : showEmpty('file-text', 'No completed documents', 'Documents you acknowledge will appear here.')}
            </>
          )
        ) : tab === 'documents' ? (
          docs.length === 0
            ? showEmpty('folder', 'No documents', 'Upload documents in DocTrack on the web app.')
            : docs.map((doc) => (
              <View key={doc.id} style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={[styles.rowIcon, { backgroundColor: colors.primary + '1a' }]}>
                  <Feather name="file-text" size={18} color={colors.primary} />
                </View>
                <View style={styles.rowBody}>
                  <Text style={[styles.rowTitle, { color: colors.foreground }]}>{doc.title}</Text>
                  {!!doc.category && <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>{formatCategory(doc.category)}</Text>}
                  <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>{new Date(doc.created_at).toLocaleDateString()}</Text>
                </View>
              </View>
            ))
        ) : training.length === 0
          ? showEmpty('book-open', 'No training records', 'Add training records in TrainTrack on the web app.')
          : training.map((r) => <TrainingRow key={r.id} record={r} />)}
      </ScrollView>

    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingBottom: 16 },
  headerTitle: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    color: '#ffffff',
    marginBottom: 16,
  },
  tabBar: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 3,
  },
  tabItem: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  tabText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  list: { padding: 16, gap: 8 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    marginBottom: 4,
  },
  sectionTitle: { fontSize: 17, fontFamily: 'Inter_700Bold' },
  sectionCount: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 12,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
  rowSub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  signatureField: { marginTop: 10 },
  signatureLabel: { fontSize: 12, fontFamily: 'Inter_500Medium', marginBottom: 5 },
  ackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
  },
  ackBtnText: { color: '#ffffff', fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  ackHelp: { flexBasis: '100%', fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 1 },
  ackDone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
  },
  ackDoneText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  rowBadge: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    marginTop: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  empty: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 32,
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  emptyText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
  },
  error: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 24,
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  retryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 6,
    marginTop: 4,
  },
  signatureInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
});
