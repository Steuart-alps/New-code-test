import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import {
  getFireSafetyConfig,
  getFireSafetyStatus,
  getLegionellaConfig,
  getLegionellaMonitoringPlan,
  getLegionellaStatus,
  listFireSafetyChecks,
  listLegionellaChecks,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { StatusBadge, type BadgeStatus } from '@/components/StatusBadge';
import {
  cadenceLabel,
  checkLabel,
  controlsReadiness,
  fireControlFields,
  formatControlDate,
  historyByCheckType,
  initialControlsSite,
  localIsoDate,
  monitoringPlanState,
  parseControlModule,
  parseSiteParam,
  reviewDateState,
  temperatureLimitLabel,
  temperatureText,
  waterControlFields,
  type ControlField,
  type ControlHistoryRow,
  type ControlModule,
  type ControlStatusRow,
  type MonitoringPlan,
  type TemperatureLimit,
} from '@/components/track-controls-logic';

interface Site {
  id: number;
  name: string;
}

interface SiteControls {
  profile: Record<string, unknown> | null;
  temperatureLimits: Record<string, TemperatureLimit>;
}

const MODULE_META: Record<ControlModule, { title: string; icon: React.ComponentProps<typeof Feather>['name']; color: string }> = {
  fire: { title: 'FireTrack controls', icon: 'alert-triangle', color: '#f97316' },
  water: { title: 'LegionellaTrack controls', icon: 'droplet', color: '#0ea5e9' },
};

const BADGE_STATUSES = new Set(['ok', 'due_soon', 'overdue', 'never', 'pass', 'fail', 'action_required']);

function errorMessage(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 403) return 'This site is outside your department.';
  if (status === 400) return 'This site is not available on your account.';
  return 'Could not load the site controls. Pull down to try again.';
}

// Every read goes through the generated client, which sends the mobile bearer
// token. The API checks the site against the signed-in user's client and
// department; nothing here supplies a clientId.
async function loadControls(module: ControlModule, siteId: number): Promise<SiteControls> {
  if (module === 'fire') {
    const config = await getFireSafetyConfig({ siteId });
    return { profile: (config.controlProfile ?? null) as Record<string, unknown> | null, temperatureLimits: {} };
  }
  const config = await getLegionellaConfig({ siteId });
  return {
    profile: (config.controlProfile ?? null) as Record<string, unknown> | null,
    temperatureLimits: config.effectiveTemperatureLimits ?? {},
  };
}

function loadStatus(module: ControlModule, siteId: number): Promise<ControlStatusRow[]> {
  return module === 'fire' ? getFireSafetyStatus({ siteId }) : getLegionellaStatus({ siteId });
}

function loadHistory(module: ControlModule, siteId: number): Promise<ControlHistoryRow[]> {
  return module === 'fire' ? listFireSafetyChecks({ siteId }) : listLegionellaChecks({ siteId });
}

function FieldRow({ field, today }: { field: ControlField; today: string }) {
  const colors = useColors();
  const review = field.kind === 'date' && /review/i.test(field.label)
    ? reviewDateState(field.value, today)
    : null;
  return (
    <View style={[styles.fieldRow, { borderBottomColor: colors.border }]}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{field.label}</Text>
      <View style={styles.fieldValueRow}>
        <Text
          style={[styles.fieldValue, { color: field.value ? colors.foreground : colors.mutedForeground }]}
          testID={`control-field-${field.key}`}
        >
          {field.value ? (field.kind === 'date' ? formatControlDate(field.value) : field.value) : 'Not recorded'}
        </Text>
        {review === 'overdue' && <StatusBadge status="overdue" small />}
        {review === 'due_soon' && <StatusBadge status="due_soon" small />}
      </View>
    </View>
  );
}

export default function SiteControlsScreen() {
  const params = useLocalSearchParams<{ module: string; siteId?: string }>();
  const module = parseControlModule(params.module);
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const clientKey = user?.clientId ?? null;
  const [chosenSiteId, setChosenSiteId] = useState<number | null>(null);
  const today = localIsoDate();

  const sitesQuery = useQuery<Site[]>({
    queryKey: ['sites', clientKey],
    queryFn: () => apiFetch('/api/sites'),
  });
  const sites = sitesQuery.data;
  const siteId = chosenSiteId ?? initialControlsSite(sites, parseSiteParam(params.siteId));
  const enabled = module !== null && siteId !== null;
  const keyBase = ['track-controls', clientKey, module, siteId] as const;

  const controlsQuery = useQuery({
    queryKey: [...keyBase, 'config'],
    queryFn: () => loadControls(module!, siteId!),
    enabled,
  });
  const statusQuery = useQuery({
    queryKey: [...keyBase, 'status'],
    queryFn: () => loadStatus(module!, siteId!),
    enabled,
  });
  const historyQuery = useQuery({
    queryKey: [...keyBase, 'history'],
    queryFn: () => loadHistory(module!, siteId!),
    enabled,
  });
  const planQuery = useQuery<MonitoringPlan>({
    queryKey: [...keyBase, 'plan'],
    queryFn: () => getLegionellaMonitoringPlan({ siteId: siteId! }),
    enabled: enabled && module === 'water',
  });

  const history = useMemo(() => historyByCheckType(historyQuery.data), [historyQuery.data]);
  const [refreshing, setRefreshing] = useState(false);

  if (module === null) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: 'Site controls' }} />
        <Text style={{ color: colors.mutedForeground }}>Unknown module.</Text>
      </View>
    );
  }

  const meta = MODULE_META[module];
  const planState = module === 'water' ? monitoringPlanState(planQuery.data) : undefined;
  const fields = module === 'fire'
    ? fireControlFields(controlsQuery.data?.profile)
    : waterControlFields(controlsQuery.data?.profile, planQuery.data);
  const readiness = controlsReadiness(fields, today, planState);
  const loading = controlsQuery.isLoading || statusQuery.isLoading || historyQuery.isLoading;
  const loadError = controlsQuery.error ?? statusQuery.error ?? historyQuery.error ?? planQuery.error;
  const statuses = statusQuery.data ?? [];

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([
      sitesQuery.refetch(),
      ...(enabled ? [controlsQuery.refetch(), statusQuery.refetch(), historyQuery.refetch()] : []),
      ...(enabled && module === 'water' ? [planQuery.refetch()] : []),
    ]);
    setRefreshing(false);
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      testID={`site-controls-${module}`}
    >
      <Stack.Screen
        options={{
          title: meta.title,
          headerStyle: { backgroundColor: '#162d42' },
          headerTintColor: '#ffffff',
          headerTitleStyle: { fontFamily: 'Inter_600SemiBold' },
        }}
      />

      {(sites?.length ?? 0) > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.siteRow}>
          {sites!.map((site) => {
            const active = site.id === siteId;
            return (
              <TouchableOpacity
                key={site.id}
                style={[styles.chip, {
                  borderColor: active ? colors.primary : colors.border,
                  backgroundColor: active ? colors.primary + '1a' : colors.card,
                }]}
                onPress={() => setChosenSiteId(site.id)}
                testID={`site-controls-site-${site.id}`}
              >
                <Text style={[styles.chipText, { color: active ? colors.primary : colors.mutedForeground }]}>{site.name}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {sitesQuery.isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 32 }} />
      ) : siteId === null ? (
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={{ color: colors.mutedForeground }}>
            Controls are set per site. Ask an admin to add a site you can access.
          </Text>
        </View>
      ) : loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 32 }} />
      ) : loadError ? (
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID="site-controls-error">
          <Feather name="lock" size={18} color={colors.mutedForeground} />
          <Text style={{ color: colors.foreground, marginTop: 6 }}>{errorMessage(loadError)}</Text>
        </View>
      ) : (
        <>
          {/* Evidence readiness */}
          <View
            style={[styles.card, {
              backgroundColor: readiness.ready ? '#f0fdf4' : '#fffbeb',
              borderColor: readiness.ready ? colors.success + '66' : colors.warning + '66',
            }]}
            testID="site-controls-readiness"
          >
            <View style={styles.cardHeader}>
              <Feather name={readiness.ready ? 'check-circle' : 'alert-circle'} size={18} color={readiness.ready ? colors.success : colors.warning} />
              <Text style={[styles.cardTitle, { color: '#1a1a1a' }]}>
                {readiness.ready ? 'Ready for inspection' : 'Evidence gaps'}
              </Text>
            </View>
            <Text style={styles.readinessText}>
              {readiness.recorded} of {readiness.total} inspection references in place.
            </Text>
            {readiness.missing.map((label) => (
              <Text key={label} style={styles.readinessItem}>• Missing: {label}</Text>
            ))}
            {readiness.overdueReviews.map((label) => (
              <Text key={label} style={styles.readinessItem}>• Overdue: {label}</Text>
            ))}
          </View>

          {/* Control references and review dates */}
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.cardHeader}>
              <Feather name={meta.icon} size={16} color={meta.color} />
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Site control profile</Text>
            </View>
            {module === 'water' && (
              <View style={styles.planRow} testID="site-controls-plan">
                <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Monitoring plan</Text>
                <Text style={[styles.fieldValue, {
                  color: planState === 'approved' ? colors.success : colors.warning,
                }]}>
                  {planState === 'approved'
                    ? `Approved${typeof planQuery.data?.profile?.approvedAt === 'string' ? ` ${formatControlDate(planQuery.data.profile.approvedAt)}` : ''}`
                    : planState === 'review_required'
                      ? 'Review required after a material change'
                      : 'Not approved, so due dates are paused'}
                </Text>
                {planState === 'review_required' && typeof planQuery.data?.profile?.materialChangeNote === 'string' && (
                  <Text style={[styles.historyMeta, { color: colors.mutedForeground }]}>
                    {planQuery.data.profile.materialChangeNote}
                  </Text>
                )}
              </View>
            )}
            {fields.map((field) => <FieldRow key={field.key} field={field} today={today} />)}
            <Text style={[styles.footnote, { color: colors.mutedForeground }]}>
              Read-only. Control profiles are edited by an admin on the web app.
            </Text>
          </View>

          {/* Cadence and status beside each check type's history */}
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Checks, frequency and history</Text>
          {statuses.map((row) => {
            const recent = history.get(row.checkType) ?? [];
            const limit = temperatureLimitLabel(controlsQuery.data?.temperatureLimits[row.checkType]);
            const badge = BADGE_STATUSES.has(row.status) ? row.status as BadgeStatus : null;
            return (
              <View
                key={row.checkType}
                style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
                testID={`site-controls-check-${row.checkType}`}
              >
                <View style={styles.checkHeader}>
                  <Text style={[styles.checkTitle, { color: colors.foreground }]}>{checkLabel(module, row.checkType)}</Text>
                  {badge ? <StatusBadge status={badge} small /> : (
                    <Text style={[styles.planRequired, { color: colors.warning }]}>Plan needed</Text>
                  )}
                </View>
                <Text style={[styles.checkMeta, { color: colors.mutedForeground }]}>
                  {cadenceLabel(row.frequencyDays)}
                  {limit ? ` · Limit: ${limit}` : ''}
                </Text>
                <Text style={[styles.checkMeta, { color: colors.mutedForeground }]}>
                  Last: {formatControlDate(row.lastDate)}
                  {row.dueDate ? ` · Next due: ${formatControlDate(row.dueDate)}` : ''}
                </Text>
                {recent.length === 0 ? (
                  <Text style={[styles.historyMeta, { color: colors.mutedForeground }]}>No checks recorded at this site.</Text>
                ) : recent.map((entry) => {
                  const temperature = temperatureText(entry.temperature);
                  return (
                    <View key={entry.id} style={[styles.historyRow, { borderTopColor: colors.border }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.historyDate, { color: colors.foreground }]}>
                          {formatControlDate(entry.checkDate)}{temperature ? ` · ${temperature}` : ''}
                        </Text>
                        {(entry.performedBy || entry.location) && (
                          <Text style={[styles.historyMeta, { color: colors.mutedForeground }]}>
                            {[entry.performedBy, entry.location].filter(Boolean).join(' · ')}
                          </Text>
                        )}
                      </View>
                      {BADGE_STATUSES.has(entry.result) && <StatusBadge status={entry.result as BadgeStatus} small />}
                    </View>
                  );
                })}
              </View>
            );
          })}

          <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
            <TouchableOpacity
              style={[styles.logBtn, { backgroundColor: colors.navy }]}
              onPress={() => router.push(`/checks/${module}` as any)}
              testID="site-controls-log-check"
            >
              <Feather name="plus" size={18} color="#ffffff" />
              <Text style={styles.logBtnText}>Log a check</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  siteRow: { gap: 8, paddingHorizontal: 16, paddingTop: 16 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  chipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  card: { marginHorizontal: 16, marginTop: 12, borderWidth: 1, borderRadius: 8, padding: 14 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  cardTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  readinessText: { fontSize: 13, fontFamily: 'Inter_500Medium', color: '#1a1a1a', marginBottom: 4 },
  readinessItem: { fontSize: 12, fontFamily: 'Inter_400Regular', color: '#475569', marginTop: 2 },
  planRow: { paddingVertical: 8 },
  fieldRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  fieldLabel: { fontSize: 11, fontFamily: 'Inter_500Medium', textTransform: 'uppercase', letterSpacing: 0.3 },
  fieldValueRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  fieldValue: { fontSize: 14, fontFamily: 'Inter_400Regular', flexShrink: 1 },
  footnote: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 10 },
  sectionTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', marginHorizontal: 16, marginTop: 20 },
  checkHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  checkTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', flexShrink: 1 },
  planRequired: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  checkMeta: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 4 },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  historyDate: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  historyMeta: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  logBtn: { height: 50, borderRadius: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  logBtnText: { color: '#ffffff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
});
