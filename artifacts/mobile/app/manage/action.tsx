import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { MANAGE_ACTIONS_KEY, useActionSites, useHubActions, useModuleActions } from '@/hooks/useManageActions';
import { AquaChoiceRow, AquaEmptyState, AquaField, AquaInput, aquaUiStyles } from '@/components/aqua-track-ui';
import { ActionBadge, SeverityBadge } from '@/components/ActionBadges';
import { SignaturePad } from '@/components/SignaturePad';
import { isConnectionError, onlineActionMessage } from '@/components/outbox-status-logic';
import { localIsoDate } from '@/components/date-stepper-logic';
import {
  EMPTY_RESOLUTION, MODULE_SEVERITIES, buildDetailsPatch, buildHubPatch, buildResolutionPatch, canEditHubAction,
  canMutateModuleAction, detailsFromAction, fixTrackChoice, fixTrackQuestion, formatDay, hubStatusLabel,
  hubStatusOptions, hubUpdateFrom, humanise, isOverdue, lockedDetails, moduleLabel, provenanceLabel,
  resolutionBlocker, resolutionReady, type HubAction, type HubUpdate, type ModuleAction, type ModuleDetails,
  type ResolutionValues, type SiteOption,
} from '@/components/compliance-actions-logic';

type Colors = ReturnType<typeof useColors>;

// One action: details, updates, final sign-off and the FixTrack choice. Every
// change edits a live server record, so it needs a connection; when offline
// the form keeps what was typed and says so.
export default function ManageActionScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { kind, id } = useLocalSearchParams<{ kind?: string; id?: string }>();
  const actionId = Number(id);
  const isHub = kind === 'hub';
  const moduleQuery = useModuleActions();
  const hubQuery = useHubActions();
  const sitesQuery = useActionSites();
  const query = isHub ? hubQuery : moduleQuery;
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [scrollEnabled, setScrollEnabled] = useState(true);

  const moduleAction = !isHub ? moduleQuery.data?.find((a) => a.id === actionId) : undefined;
  const hubAction = isHub ? hubQuery.data?.find((a) => a.id === actionId) : undefined;
  const found = isHub ? hubAction : moduleAction;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: 40 }}
      keyboardShouldPersistTaps="handled"
      scrollEnabled={scrollEnabled}
    >
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
        <TouchableOpacity testID="action-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
          <Feather name="arrow-left" size={22} color="#ffffff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={3}>{found?.title ?? (isHub ? 'Corrective action' : 'Module action')}</Text>
        <Text style={styles.headerSub}>
          {moduleAction ? moduleLabel(moduleAction.module) : hubAction ? hubAction.sourceTrack : isHub ? 'Compliance Hub' : 'Module actions'}
        </Text>
      </View>
      <View style={styles.content}>
        {query.isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
        ) : !found ? (
          <AquaEmptyState
            colors={colors}
            error={!!query.error}
            message={query.error && isConnectionError(query.error)
              ? 'Opening this action needs a connection.'
              : isHub
                ? 'This action is no longer open. Verified actions are on the website.'
                : 'This action is no longer open. Resolved actions are on the website.'}
          >
            <TouchableOpacity accessibilityRole="button" onPress={() => router.back()}>
              <Text style={[styles.link, { color: colors.primary }]}>Go back</Text>
            </TouchableOpacity>
          </AquaEmptyState>
        ) : moduleAction ? (
          <ModuleActionDetail action={moduleAction} sites={sitesQuery.data ?? []} colors={colors} onDrawing={(d) => setScrollEnabled(!d)} />
        ) : hubAction ? (
          <HubActionDetail action={hubAction} colors={colors} />
        ) : null}
      </View>
    </ScrollView>
  );
}

function Section({ title, children, colors }: { title: string; children: React.ReactNode; colors: Colors }) {
  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{title}</Text>
      {children}
    </View>
  );
}

function Line({ label, value, colors }: { label: string; value?: string | null; colors: Colors }) {
  if (!value) return null;
  return (
    <Text style={[styles.line, { color: colors.foreground }]}>
      <Text style={styles.lineLabel}>{label}: </Text>{value}
    </Text>
  );
}

function PrimaryButton({ label, icon, onPress, busy, disabled, colors, testID, tone }: {
  label: string; icon: React.ComponentProps<typeof Feather>['name']; onPress: () => void; busy?: boolean;
  disabled?: boolean; colors: Colors; testID: string; tone?: string;
}) {
  const off = disabled || busy;
  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={[aquaUiStyles.primaryButton, { backgroundColor: tone ?? colors.navy, marginTop: 4 }, off && { opacity: 0.5 }]}
    >
      {busy ? <ActivityIndicator color="#ffffff" /> : <Feather name={icon} size={16} color="#ffffff" />}
      <Text style={aquaUiStyles.primaryButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

function OutlineButton({ label, onPress, disabled, colors, testID, expanded }: {
  label: string; onPress: () => void; disabled?: boolean; colors: Colors; testID: string; expanded?: boolean;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, expanded }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.outlineButton, { borderColor: colors.border, backgroundColor: colors.background }, disabled && { opacity: 0.5 }]}
    >
      <Text style={[styles.outlineButtonText, { color: colors.foreground }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Notice({ text, colors, tone, testID }: { text: string; colors: Colors; tone?: string; testID?: string }) {
  return (
    <View testID={testID} style={[styles.notice, { borderColor: (tone ?? colors.mutedForeground) + '55', backgroundColor: (tone ?? colors.mutedForeground) + '12' }]}>
      <Text style={[styles.noticeText, { color: colors.foreground }]}>{text}</Text>
    </View>
  );
}

function useActionChange() {
  const qc = useQueryClient();
  return useCallback(async () => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    await qc.invalidateQueries({ queryKey: MANAGE_ACTIONS_KEY });
  }, [qc]);
}

function failed(title: string) {
  return (error: Error) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    Alert.alert(title, onlineActionMessage(error));
  };
}

// ---------------------------------------------------------------------------

function ModuleActionDetail({ action, sites, colors, onDrawing }: { action: ModuleAction; sites: SiteOption[]; colors: Colors; onDrawing: (drawing: boolean) => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useAuth();
  const changed = useActionChange();
  const today = localIsoDate();
  const canMutate = canMutateModuleAction(user?.role, action);
  const fix = fixTrackChoice(action, canMutate);
  const blocker = resolutionBlocker(action);
  const locks = lockedDetails(action);
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState<ModuleDetails>(() => detailsFromAction(action));
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState<ResolutionValues>(EMPTY_RESOLUTION);
  const [signature, setSignature] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const siteName = sites.find((s) => s.id === action.siteId)?.name;
  const instruction = action.instructionSnapshot ?? action.instruction;
  const overdue = isOverdue(action.dueDate, today);

  useEffect(() => { if (!editing) setDetails(detailsFromAction(action)); }, [action, editing]);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiFetch(`/api/track-actions/${action.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  });
  const fixTrack = useMutation({
    mutationFn: (create: boolean) => apiFetch(`/api/track-actions/${action.id}/fix-track`, { method: 'POST', body: JSON.stringify({ create }) }),
    onSuccess: async (_data, create) => {
      setMessage(create ? 'Added to FixTrack' : 'Action kept in this track');
      if (create) {
        void qc.invalidateQueries({ queryKey: ['fix-track-issues-all'] });
        void qc.invalidateQueries({ queryKey: ['fix-track-issues'] });
      }
      await changed();
    },
    onError: failed('Couldn’t update FixTrack'),
  });
  const busy = patch.isPending || fixTrack.isPending;

  const start = () => patch.mutate({ status: 'in_progress' }, {
    onSuccess: async () => { setMessage('Action updated'); await changed(); },
    onError: failed('Couldn’t update action'),
  });

  const saveDetails = () => {
    const built = buildDetailsPatch(action, details);
    if (!built.ok) { Alert.alert('Details not saved', built.message); return; }
    patch.mutate(built.patch, {
      onSuccess: async () => { setEditing(false); setMessage('Action updated'); await changed(); },
      onError: failed('Couldn’t update action'),
    });
  };

  const resolve = () => {
    const built = buildResolutionPatch(resolution, signature);
    if (!built.ok) { Alert.alert('Not resolved yet', built.message); return; }
    patch.mutate(built.patch, {
      onSuccess: async () => {
        await changed();
        Alert.alert('Action resolved', 'Signed off as complete.');
        router.back();
      },
      onError: failed('Couldn’t resolve action'),
    });
  };

  const readOnlyReason = !user || user.role === 'client_viewer'
    ? 'View only: your account can’t change actions.'
    : action.module === 'kitchen' && !canMutate
      ? 'KitchenTrack actions are assigned, resolved and verified by a client admin or consultant.'
      : null;

  return (
    <>
      <Section title="Action" colors={colors}>
        <View style={styles.badges}>
          <SeverityBadge severity={action.severity} />
          <ActionBadge label={humanise(action.status)} />
          <ActionBadge label={provenanceLabel(action)} />
        </View>
        <Text style={[styles.meta, { color: colors.mutedForeground }]}>
          {[moduleLabel(action.module), siteName, action.ownerName && `Owner: ${action.ownerName}`].filter(Boolean).join(' · ') || 'No site, owner or due date recorded'}
        </Text>
        {!!action.dueDate && (
          <Text testID="action-due" style={[styles.meta, { color: overdue ? colors.destructive : colors.mutedForeground }]}>
            {overdue ? 'Overdue · ' : ''}Due {formatDay(action.dueDate)}
          </Text>
        )}
        {!!instruction && (
          <Text style={[styles.instruction, { color: colors.foreground, backgroundColor: colors.background }]}>
            <Text style={styles.lineLabel}>Instruction snapshot: </Text>{instruction}
          </Text>
        )}
      </Section>

      {!!message && <Notice testID="action-message" text={message} colors={colors} tone={colors.success} />}
      {!!readOnlyReason && <Notice testID="action-read-only" text={readOnlyReason} colors={colors} />}

      {fix.kind !== 'none' && (
        <Section title="FixTrack" colors={colors}>
          <Text style={[styles.body, { color: colors.foreground }]}>{fixTrackQuestion(fix)}</Text>
          {fix.kind === 'linked' ? (
            <OutlineButton testID="action-open-fixtrack" label={`Open FixTrack issue #${fix.issueId}`} colors={colors} onPress={() => router.push(`/issues/${fix.issueId}` as any)} />
          ) : (
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <PrimaryButton testID="action-fixtrack-yes" label="Yes, add to FixTrack" icon="tool" colors={colors} busy={fixTrack.isPending && fixTrack.variables === true} disabled={busy} onPress={() => fixTrack.mutate(true)} />
              </View>
              {fix.canDecline && (
                <View style={{ flex: 1 }}>
                  <OutlineButton testID="action-fixtrack-no" label="No" colors={colors} disabled={busy} onPress={() => fixTrack.mutate(false)} />
                </View>
              )}
            </View>
          )}
        </Section>
      )}

      {canMutate && (
        <Section title="Update" colors={colors}>
          {action.status === 'open' && (
            <PrimaryButton testID="action-start" label="Start action" icon="play-circle" colors={colors} busy={patch.isPending && !editing && !resolving} disabled={busy} onPress={start} />
          )}
          <OutlineButton testID="action-edit-toggle" label={editing ? 'Close details' : 'Edit details'} colors={colors} expanded={editing} onPress={() => setEditing((v) => !v)} />
          {editing && (
            <View style={{ marginTop: 10 }}>
              <AquaField label="Action title">
                <AquaInput value={details.title} onChangeText={(title) => setDetails({ ...details, title })} colors={colors} disabled={locks.titleAndSeverity || busy} testID="action-title" />
              </AquaField>
              <AquaChoiceRow
                label="Severity"
                options={MODULE_SEVERITIES.map((s) => ({ value: s.value, label: s.label }))}
                value={details.severity}
                onChange={(severity) => setDetails({ ...details, severity })}
                colors={colors}
                testIDPrefix="action-severity"
                disabled={locks.titleAndSeverity || busy}
              />
              {locks.titleAndSeverity && (
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>The failed temperature and original control rule are immutable.</Text>
              )}
              <AquaChoiceRow
                label="Site (optional)"
                options={[{ value: '', label: 'No site' }, ...sites.map((s) => ({ value: String(s.id), label: s.name }))]}
                value={details.siteId}
                onChange={(siteId) => setDetails({ ...details, siteId })}
                colors={colors}
                testIDPrefix="action-site"
                disabled={locks.site || busy}
              />
              {locks.site && (
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>The source record controls this action’s site.</Text>
              )}
              <AquaField label="Owner (optional)">
                <AquaInput value={details.ownerName} onChangeText={(ownerName) => setDetails({ ...details, ownerName })} colors={colors} disabled={busy} testID="action-owner" placeholder="Named person or contractor" />
              </AquaField>
              <AquaField label="Due date (optional, YYYY-MM-DD)">
                <AquaInput value={details.dueDate} onChangeText={(dueDate) => setDetails({ ...details, dueDate })} colors={colors} disabled={busy} testID="action-due-date" keyboardType="numbers-and-punctuation" placeholder="2026-12-31" />
              </AquaField>
              <PrimaryButton testID="action-save-details" label="Save details" icon="save" colors={colors} busy={patch.isPending && editing} disabled={busy || !details.title.trim()} onPress={saveDetails} />
            </View>
          )}
        </Section>
      )}

      {canMutate && (
        <Section title="Resolve" colors={colors}>
          {blocker ? (
            <Text testID="action-resolve-blocked" style={[styles.body, { color: colors.foreground }]}>{blocker}</Text>
          ) : (
            <>
              <OutlineButton testID="action-resolve-toggle" label={resolving ? 'Close resolution' : 'Resolve action'} colors={colors} expanded={resolving} onPress={() => setResolving((v) => !v)} />
              {resolving && (
                <View style={{ marginTop: 10 }}>
                  <AquaField label="Remedial action">
                    <AquaInput multiline value={resolution.remedialAction} onChangeText={(remedialAction) => setResolution({ ...resolution, remedialAction })} colors={colors} disabled={busy} testID="action-remedial" />
                  </AquaField>
                  <AquaField label="Evidence reference">
                    <AquaInput value={resolution.evidenceReference} onChangeText={(evidenceReference) => setResolution({ ...resolution, evidenceReference })} colors={colors} disabled={busy} testID="action-evidence" placeholder="Photo, record or document reference" />
                  </AquaField>
                  <AquaField label="Resolution notes">
                    <AquaInput multiline value={resolution.resolutionNotes} onChangeText={(resolutionNotes) => setResolution({ ...resolution, resolutionNotes })} colors={colors} disabled={busy} testID="action-resolution-notes" />
                  </AquaField>
                  <AquaField label="Resolver signature">
                    <Text style={[styles.hint, { color: colors.mutedForeground, marginBottom: 8 }]}>
                      Draw your signature to confirm that you completed and signed off this action.
                    </Text>
                    <SignaturePad onChange={setSignature} onDrawingChange={onDrawing} disabled={busy} testID="action-signature" />
                  </AquaField>
                  <PrimaryButton
                    testID="action-confirm-resolution"
                    label="Sign and complete"
                    icon="check-circle"
                    tone={colors.success}
                    colors={colors}
                    busy={patch.isPending && resolving}
                    disabled={busy || !resolutionReady(resolution) || !signature}
                    onPress={resolve}
                  />
                </View>
              )}
            </>
          )}
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function HubActionDetail({ action, colors }: { action: HubAction; colors: Colors }) {
  const router = useRouter();
  const { user } = useAuth();
  const changed = useActionChange();
  const today = localIsoDate();
  const canEdit = canEditHubAction(user?.role, action);
  const [update, setUpdate] = useState<HubUpdate>(() => hubUpdateFrom(action));
  const [message, setMessage] = useState<string | null>(null);
  const overdue = isOverdue(action.dueDate, today);
  const options = hubStatusOptions(user?.role, action.status);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiFetch(`/api/compliance-hub/actions/${action.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  });

  const submit = () => {
    const built = buildHubPatch(update);
    if (!built.ok) { Alert.alert('Action not updated', built.message); return; }
    save.mutate(built.patch, {
      onSuccess: async () => {
        await changed();
        if (update.status === 'verified') {
          Alert.alert('Action verified closed', 'It cannot be edited afterwards.');
          router.back();
        } else {
          setMessage('Corrective action updated');
        }
      },
      onError: failed('Couldn’t update action'),
    });
  };

  return (
    <>
      <Section title="Corrective action" colors={colors}>
        <View style={styles.badges}>
          <SeverityBadge severity={action.severity} />
          <ActionBadge label={hubStatusLabel(action.status)} />
        </View>
        <Text style={[styles.meta, { color: colors.mutedForeground }]}>
          {[action.sourceTrack, action.sourceRecordId, action.ownerName && `Owner: ${action.ownerName}`].filter(Boolean).join(' · ')}
        </Text>
        {!!action.dueDate && (
          <Text style={[styles.meta, { color: overdue ? colors.destructive : colors.mutedForeground }]}>
            {overdue ? 'Overdue · ' : ''}Due {formatDay(action.dueDate)}
          </Text>
        )}
        <View style={{ marginTop: 8, gap: 6 }}>
          <Line label="Corrective action" value={action.correctiveAction} colors={colors} />
          <Line label="Interim control" value={action.interimControl} colors={colors} />
          <Line label="Evidence" value={action.evidenceReference} colors={colors} />
          <Line label="Verification" value={action.verificationNotes} colors={colors} />
        </View>
      </Section>

      {!!message && <Notice testID="action-message" text={message} colors={colors} tone={colors.success} />}
      {!canEdit && <Notice testID="action-read-only" text="View only: your account can’t change corrective actions." colors={colors} />}

      {canEdit && (
        <Section title="Update / verify" colors={colors}>
          <AquaChoiceRow
            label="Action status"
            options={options}
            value={update.status}
            onChange={(status) => setUpdate({ ...update, status })}
            colors={colors}
            testIDPrefix="hub-status"
            disabled={save.isPending}
          />
          <AquaField label="Evidence reference">
            <AquaInput value={update.evidenceReference} onChangeText={(evidenceReference) => setUpdate({ ...update, evidenceReference })} colors={colors} disabled={save.isPending} testID="hub-evidence" placeholder="Document title, certificate, photo record or storage link" />
          </AquaField>
          <AquaField label={`Verification notes${update.status === 'verified' ? ' (required)' : ''}`}>
            <AquaInput multiline value={update.verificationNotes} onChangeText={(verificationNotes) => setUpdate({ ...update, verificationNotes })} colors={colors} disabled={save.isPending} testID="hub-verification" placeholder="Who verified the action, what they checked and when" />
          </AquaField>
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            Verified closure is available only from “Awaiting verification”, by a different client admin or consultant. It cannot be edited afterwards.
          </Text>
          <PrimaryButton testID="hub-save" label="Save action update" icon="save" colors={colors} busy={save.isPending} disabled={save.isPending} onPress={submit} />
        </Section>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  back: { marginBottom: 10, alignSelf: 'flex-start', padding: 2 },
  headerTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', color: '#ffffff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter_400Regular' },
  content: { padding: 16, gap: 12 },
  section: { borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  sectionTitle: { fontSize: 11, fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', letterSpacing: 1 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  meta: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  instruction: { fontSize: 13, fontFamily: 'Inter_400Regular', borderRadius: 6, padding: 10, marginTop: 4 },
  line: { fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  lineLabel: { fontFamily: 'Inter_600SemiBold' },
  body: { fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  hint: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: -6, marginBottom: 10 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  link: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  outlineButton: { minHeight: 46, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, marginTop: 4 },
  outlineButtonText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  notice: { borderWidth: 1, borderRadius: 8, padding: 12 },
  noticeText: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 18 },
});
