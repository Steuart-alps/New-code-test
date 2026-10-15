/**
 * Shared pieces of the read-only register screens (app/manage/allergens.tsx,
 * coshh.tsx, asbestos.tsx): navy header, search, site filter, the "saved on
 * this phone" note, a full-screen detail view and labelled fields.
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';
import { onlineActionMessage } from '@/components/outbox-status-logic';
import { lastUpdatedText, READ_ONLY_NOTE, type Site } from '@/components/registers-logic';

type FeatherName = React.ComponentProps<typeof Feather>['name'];

export function RegisterHeader({ title, subtitle, testID, onBack }: {
  title: string;
  subtitle: string;
  testID: string;
  onBack?: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  return (
    <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
      <TouchableOpacity
        testID={`${testID}-back`}
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={onBack ?? (() => router.back())}
        style={styles.back}
      >
        <Feather name="arrow-left" size={22} color="#ffffff" />
      </TouchableOpacity>
      <Text style={styles.headerTitle} accessibilityRole="header">{title}</Text>
      <Text style={styles.headerSub}>{subtitle}</Text>
    </View>
  );
}

export function RegisterFilters({ query, onQuery, placeholder, sites, siteId, onSite, testID }: {
  query: string;
  onQuery: (value: string) => void;
  placeholder: string;
  sites: readonly Site[];
  siteId: number | null;
  onSite: (siteId: number | null) => void;
  testID: string;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 10 }}>
      <View style={[styles.search, { borderColor: colors.border, backgroundColor: colors.card }]}>
        <Feather name="search" size={16} color={colors.mutedForeground} />
        <TextInput
          testID={`${testID}-search`}
          value={query}
          onChangeText={onQuery}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel={placeholder}
          autoCorrect={false}
          returnKeyType="search"
          style={[styles.searchInput, { color: colors.foreground }]}
        />
        {query ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => onQuery('')}>
            <Feather name="x" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        ) : null}
      </View>
      {sites.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {[{ id: null as number | null, name: 'All sites' }, ...sites].map((site) => {
            const selected = siteId === site.id;
            return (
              <TouchableOpacity
                key={site.id ?? 'all'}
                testID={`${testID}-site-${site.id ?? 'all'}`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => onSite(site.id)}
                style={[styles.chip, { borderColor: selected ? colors.navy : colors.border, backgroundColor: selected ? colors.navy : colors.card }]}
              >
                <Text style={[styles.chipText, { color: selected ? '#ffffff' : colors.foreground }]}>{site.name}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

/** Loading, error, offline-copy and read-only notes above a register list. */
export function RegisterStatus({ loading, error, savedAt, onRetry }: {
  loading: boolean;
  error: string | null;
  savedAt: string | null;
  onRetry: () => void;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 8 }}>
      {savedAt && (
        <View testID="register-saved-copy" style={[styles.note, { backgroundColor: '#fef3c7', borderColor: '#fcd34d' }]}>
          <Feather name="wifi-off" size={14} color="#92400e" />
          <Text style={[styles.noteText, { color: '#92400e' }]}>
            {lastUpdatedText(savedAt)}{loading ? ' Checking for changes…' : ' It may be out of date until you are back online.'}
          </Text>
        </View>
      )}
      {loading && !savedAt && <ActivityIndicator color={colors.navy} style={{ marginVertical: 16 }} />}
      {error && (
        <View testID="register-error" style={[styles.note, { backgroundColor: '#fee2e2', borderColor: '#fca5a5' }]}>
          <Feather name="alert-circle" size={14} color="#991b1b" />
          <Text style={[styles.noteText, { color: '#991b1b' }]}>{error}</Text>
          <TouchableOpacity accessibilityRole="button" onPress={onRetry}>
            <Text style={[styles.retry, { color: '#991b1b' }]}>Try again</Text>
          </TouchableOpacity>
        </View>
      )}
      <Text style={[styles.readOnly, { color: colors.mutedForeground }]}>{READ_ONLY_NOTE}</Text>
    </View>
  );
}

export function InfoNote({ text, tone = 'info', icon }: { text: string; tone?: 'info' | 'danger' | 'warning'; icon?: FeatherName }) {
  const palette = {
    info: { bg: '#eff6ff', border: '#bfdbfe', fg: '#1e3a8a', icon: 'info' as FeatherName },
    warning: { bg: '#fffbeb', border: '#fcd34d', fg: '#92400e', icon: 'alert-circle' as FeatherName },
    danger: { bg: '#fef2f2', border: '#f87171', fg: '#7f1d1d', icon: 'alert-triangle' as FeatherName },
  }[tone];
  return (
    <View
      accessibilityRole={tone === 'danger' ? 'alert' : undefined}
      style={[styles.note, { backgroundColor: palette.bg, borderColor: palette.border, borderWidth: tone === 'danger' ? 2 : 1 }]}
    >
      <Feather name={icon ?? palette.icon} size={tone === 'danger' ? 18 : 14} color={palette.fg} />
      <Text style={[tone === 'danger' ? styles.dangerText : styles.noteText, { color: palette.fg }]}>{text}</Text>
    </View>
  );
}

export function Badge({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'danger' | 'warning' | 'success' | 'hazard' }) {
  const palette = {
    neutral: { bg: '#f1f5f9', border: '#cbd5e1', fg: '#334155' },
    danger: { bg: '#fef2f2', border: '#fca5a5', fg: '#b91c1c' },
    warning: { bg: '#fffbeb', border: '#fcd34d', fg: '#92400e' },
    success: { bg: '#ecfdf5', border: '#6ee7b7', fg: '#047857' },
    hazard: { bg: '#fff7ed', border: '#fdba74', fg: '#9a3412' },
  }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <Text style={[styles.badgeText, { color: palette.fg }]}>{text}</Text>
    </View>
  );
}

export function Field({ label, value, empty = 'Not recorded' }: { label: string; value: string | null | undefined; empty?: string }) {
  const colors = useColors();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.fieldValue, { color: value ? colors.foreground : colors.mutedForeground }]}>{value || empty}</Text>
    </View>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.foreground }]} accessibilityRole="header">{title}</Text>
      {children}
    </View>
  );
}

/**
 * Opens a register document (safety data sheet, survey report) from a
 * short-lived signed link, as DocTrack documents open. Needs a connection.
 */
export function useOpenDocument() {
  const [opening, setOpening] = useState<string | null>(null);
  async function open(path: string, failTitle: string) {
    setOpening(path);
    try {
      const { downloadUrl } = await apiFetch<{ downloadUrl: string }>(path);
      await Linking.openURL(downloadUrl);
    } catch (error) {
      Alert.alert(failTitle, onlineActionMessage(error, 'Please try again.',
        'Opening documents needs an internet connection. Try again when you have signal.'));
    } finally {
      setOpening(null);
    }
  }
  return { opening, open };
}

/** A button that opens a document; online only (signed links expire). */
export function DocumentButton({ label, onPress, busy, testID }: { label: string; onPress: () => void; busy: boolean; testID: string }) {
  const colors = useColors();
  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      disabled={busy}
      onPress={onPress}
      style={[styles.docButton, { borderColor: colors.navy, opacity: busy ? 0.6 : 1 }]}
    >
      {busy ? <ActivityIndicator size="small" color={colors.navy} /> : <Feather name="file-text" size={16} color={colors.navy} />}
      <Text style={[styles.docButtonText, { color: colors.navy }]}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Full-screen detail; Android back and the header arrow both close it. */
export function DetailModal({ visible, title, subtitle, onClose, testID, children }: {
  visible: boolean;
  title: string;
  subtitle: string;
  onClose: () => void;
  testID: string;
  children: React.ReactNode;
}) {
  const colors = useColors();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <ScrollView testID={testID} style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingBottom: 40 }}>
        <RegisterHeader title={title} subtitle={subtitle} testID={testID} onBack={onClose} />
        <View style={styles.content}>{children}</View>
      </ScrollView>
    </Modal>
  );
}

export function ListCard({ onPress, testID, accessibilityLabel, children, highlight }: {
  onPress: () => void;
  testID: string;
  accessibilityLabel: string;
  children: React.ReactNode;
  highlight?: string;
}) {
  const colors = useColors();
  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      activeOpacity={0.75}
      style={[styles.card, { backgroundColor: colors.card, borderColor: highlight ?? colors.border }]}
    >
      <View style={{ flex: 1, gap: 6 }}>{children}</View>
      <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
    </TouchableOpacity>
  );
}

export const registerStyles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  cardTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  cardSub: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  body: { fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  empty: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 24 },
});

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  back: { marginBottom: 10, alignSelf: 'flex-start', padding: 2 },
  headerTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: '#ffffff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter_400Regular' },
  content: { padding: 16, gap: 12 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, minHeight: 44 },
  searchInput: { flex: 1, fontSize: 15, fontFamily: 'Inter_400Regular', paddingVertical: 10 },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  chipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderWidth: 1, borderRadius: 8, padding: 10 },
  noteText: { flex: 1, fontSize: 12, fontFamily: 'Inter_400Regular', lineHeight: 17 },
  dangerText: { flex: 1, fontSize: 14, fontFamily: 'Inter_600SemiBold', lineHeight: 20 },
  retry: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  readOnly: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  badge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  badgeText: { fontSize: 11, fontFamily: 'Inter_500Medium' },
  field: { gap: 2 },
  fieldLabel: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  fieldValue: { fontSize: 15, fontFamily: 'Inter_400Regular', lineHeight: 21 },
  section: { borderWidth: 1, borderRadius: 8, padding: 14, gap: 10 },
  sectionTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  docButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderRadius: 8, minHeight: 44, paddingHorizontal: 14 },
  docButtonText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  card: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8, padding: 14, gap: 12 },
});
