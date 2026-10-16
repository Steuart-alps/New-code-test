/**
 * One contractor: contact (tap to call or email), compliance (insurance,
 * DBS / PVG, Gas Safe), certificates and licences with their expiry, and the
 * compliance checks assigned to them — the website's contractor profile,
 * read-only. Editing, certificates and reminders stay on the website.
 */
import React from 'react';
import {
  ActivityIndicator,
  Linking,
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
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { isConnectionError } from '@/components/outbox-status-logic';
import {
  CONTRACTOR_STATUS_COLOR,
  CONTRACTOR_STATUS_LABEL,
  certificateExpiry,
  checkStatusLabel,
  contractorListStatus,
  formatDay,
  mailtoUrl,
  normalizeCertificates,
  normalizeChecks,
  normalizeContractor,
  telUrl,
  type CertificateExpiryLevel,
} from '@/components/contractors-logic';

const EXPIRY_COLOR: Record<CertificateExpiryLevel, string> = {
  none: '#64748b',
  expired: '#dc2626',
  expiring: '#d97706',
  valid: '#059669',
};

const open = (url: string | null) => {
  if (url) Linking.openURL(url).catch(() => undefined);
};

export default function ContractorDetailScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = /^\d{1,9}$/.test(String(rawId ?? '')) ? Number(rawId) : null;
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const contractorQuery = useQuery({
    queryKey: ['contractor', id, user?.clientId],
    queryFn: async () => normalizeContractor(await apiFetch(`/api/contractors/${id}`)),
    enabled: id !== null,
  });
  const certsQuery = useQuery({
    queryKey: ['contractor-certs', id, user?.clientId],
    queryFn: async () => normalizeCertificates(await apiFetch(`/api/contractors/${id}/certificates`)),
    enabled: id !== null,
  });
  const checksQuery = useQuery({
    queryKey: ['contractor-checks', id, user?.clientId],
    queryFn: async () => normalizeChecks(await apiFetch(`/api/compliance-items?contractorId=${id}`)),
    enabled: id !== null,
  });

  const refreshing = contractorQuery.isRefetching || certsQuery.isRefetching || checksQuery.isRefetching;
  const refresh = () => {
    void contractorQuery.refetch();
    void certsQuery.refetch();
    void checksQuery.refetch();
  };

  const header = (title: string, sub?: string | null) => (
    <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
      <TouchableOpacity testID="contractor-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
        <Feather name="arrow-left" size={22} color="#ffffff" />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>{title}</Text>
      {sub ? <Text style={styles.headerSub}>{sub}</Text> : null}
    </View>
  );

  if (id === null || contractorQuery.isError || (contractorQuery.isSuccess && !contractorQuery.data)) {
    const offline = isConnectionError(contractorQuery.error);
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {header('Contractor')}
        <View style={styles.empty}>
          <Feather name={offline ? 'wifi-off' : 'alert-circle'} size={36} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.foreground }]}>
            {offline ? 'Opening this contractor needs a connection' : 'Contractor not found'}
          </Text>
          {offline && (
            <TouchableOpacity accessibilityRole="button" onPress={refresh}>
              <Text style={[styles.link, { color: colors.primary }]}>Try again</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  const contractor = contractorQuery.data;
  if (!contractor) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {header('Contractor')}
        <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
      </View>
    );
  }

  const status = contractorListStatus(contractor, new Date());
  const statusColor = CONTRACTOR_STATUS_COLOR[status.level];
  const phoneUrl = telUrl(contractor.phone);
  const emailUrl = mailtoUrl(contractor.email);
  const insurance = formatDay(contractor.publicLiabilityExpiry);
  const dbsRecheck = formatDay(contractor.dbsExpiryDate);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
    >
      {header(contractor.name, contractor.company)}
      <View style={styles.content}>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.badge, { borderColor: statusColor + '55', backgroundColor: statusColor + '14' }]}>
            <Text style={[styles.badgeText, { color: statusColor }]} testID="contractor-status">{CONTRACTOR_STATUS_LABEL[status.level]}</Text>
          </View>
          {status.problems.length === 0 ? (
            <Text style={[styles.body, { color: colors.mutedForeground }]}>Insurance, DBS / PVG and Gas Safe registration are current.</Text>
          ) : status.problems.map((problem) => (
            <Text key={problem} style={[styles.body, { color: colors.foreground }]}>• {problem}</Text>
          ))}
        </View>

        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Contact</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, gap: 0, paddingVertical: 4 }]}>
          <TouchableOpacity
            testID="contractor-email"
            accessibilityRole="link"
            accessibilityLabel={`Email ${contractor.email}`}
            disabled={!emailUrl}
            onPress={() => open(emailUrl)}
            style={[styles.contactRow, { borderBottomColor: colors.border }]}
          >
            <Feather name="mail" size={16} color={colors.mutedForeground} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>Email</Text>
              <Text style={[styles.value, { color: emailUrl ? colors.primary : colors.foreground }]}>{contractor.email || '—'}</Text>
            </View>
          </TouchableOpacity>
          {contractor.phone ? (
            <TouchableOpacity
              testID="contractor-phone"
              accessibilityRole="link"
              accessibilityLabel={`Call ${contractor.phone}`}
              disabled={!phoneUrl}
              onPress={() => open(phoneUrl)}
              style={[styles.contactRow, { borderBottomColor: colors.border }]}
            >
              <Feather name="phone" size={16} color={colors.mutedForeground} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>Phone</Text>
                <Text style={[styles.value, { color: phoneUrl ? colors.primary : colors.foreground }]}>{contractor.phone}</Text>
              </View>
            </TouchableOpacity>
          ) : null}
          {contractor.address ? (
            <View style={[styles.contactRow, { borderBottomColor: colors.border }]}>
              <Feather name="map-pin" size={16} color={colors.mutedForeground} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>Address</Text>
                <Text style={[styles.value, { color: colors.foreground }]}>{contractor.address}</Text>
              </View>
            </View>
          ) : null}
        </View>

        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Compliance</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>Insurance Renewal</Text>
            <Text style={[styles.value, { color: colors.foreground }]}>{insurance ?? '—'}</Text>
          </View>
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>DBS / PVG</Text>
            <Text style={[styles.value, { color: colors.foreground }]}>{contractor.dbsType || '—'}</Text>
            {dbsRecheck && (
              <Text style={[styles.body, { color: colors.mutedForeground }]}>Recheck due {dbsRecheck} (your policy)</Text>
            )}
          </View>
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>Gas Safe No.</Text>
            <Text style={[styles.value, { color: colors.foreground }]}>{contractor.gasSafeNumber || '—'}</Text>
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>{'Certificates & Licences'}</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, gap: 0, paddingVertical: 4 }]}>
          {certsQuery.isLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginVertical: 12 }} />
          ) : certsQuery.isError ? (
            <Text style={[styles.body, styles.pad, { color: colors.destructive }]}>
              {isConnectionError(certsQuery.error) ? 'Certificates need a connection to load.' : 'Could not load certificates.'}
            </Text>
          ) : (certsQuery.data ?? []).length === 0 ? (
            <Text style={[styles.body, styles.pad, { color: colors.mutedForeground }]}>No certificates on record.</Text>
          ) : (certsQuery.data ?? []).map((cert) => {
            const expiry = certificateExpiry(cert.expiryDate);
            const color = EXPIRY_COLOR[expiry.level];
            return (
              <View key={cert.id} testID={`contractor-cert-${cert.id}`} style={[styles.listRow, { borderBottomColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.value, { color: colors.foreground }]}>{cert.name}</Text>
                  <Text style={[styles.body, { color: colors.mutedForeground }]}>
                    {[cert.issuer, cert.expiryDate ? `Expires / recheck ${formatDay(cert.expiryDate)}` : null].filter(Boolean).join(' · ') || '—'}
                  </Text>
                </View>
                <View style={[styles.badge, { borderColor: color + '55', backgroundColor: color + '14' }]}>
                  <Text style={[styles.badgeText, { color }]}>{expiry.label}</Text>
                </View>
              </View>
            );
          })}
        </View>

        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Compliance Checks</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, gap: 0, paddingVertical: 4 }]}>
          {checksQuery.isLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginVertical: 12 }} />
          ) : checksQuery.isError ? (
            <Text style={[styles.body, styles.pad, { color: colors.destructive }]}>
              {isConnectionError(checksQuery.error) ? 'Compliance checks need a connection to load.' : 'Could not load compliance checks.'}
            </Text>
          ) : (checksQuery.data ?? []).length === 0 ? (
            <Text style={[styles.body, styles.pad, { color: colors.mutedForeground }]}>No compliance requirements assigned.</Text>
          ) : (checksQuery.data ?? []).map((check) => (
            <View key={check.id} style={[styles.listRow, { borderBottomColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.value, { color: colors.foreground }]}>{check.title}</Text>
                <Text style={[styles.body, { color: colors.mutedForeground }]}>
                  {[checkStatusLabel(check.status), check.dueDate ? `Due: ${formatDay(check.dueDate)}` : null].filter(Boolean).join(' · ')}
                </Text>
              </View>
            </View>
          ))}
        </View>

        <Text style={[styles.footnote, { color: colors.mutedForeground }]}>
          Edit this contractor, add certificates or send reminders on the website.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  back: { marginBottom: 10, alignSelf: 'flex-start', padding: 2 },
  headerTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: '#ffffff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter_400Regular' },
  content: { padding: 16, gap: 12 },
  sectionTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginTop: 4 },
  card: { borderWidth: 1, borderRadius: 8, padding: 14, gap: 10 },
  badge: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  body: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  pad: { paddingVertical: 10 },
  label: { fontSize: 11, fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { fontSize: 15, fontFamily: 'Inter_500Medium' },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  footnote: { fontSize: 12, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 8 },
  empty: { alignItems: 'center', gap: 10, padding: 32 },
  emptyText: { fontSize: 15, fontFamily: 'Inter_500Medium', textAlign: 'center' },
  link: { fontSize: 14, fontFamily: 'Inter_500Medium' },
});
