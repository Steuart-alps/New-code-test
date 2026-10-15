/**
 * Hand the phone to staff to sign: the website's staff sign-off page on a
 * manager's phone, for staff without their own login. The manager starts it,
 * then a staff member picks their department and name, reads each document
 * that needs their acknowledgement and signs it by typing their name. Back
 * gestures stay inside the sign-off steps; only "Return to manager" (with a
 * confirmation) leaves it. Uses the account's DocTrack sign-off link and the
 * same /api/sign-off routes as the website; internet-only, nothing queued.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import * as WebBrowser from 'expo-web-browser';
import { useNavigation, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { NEEDS_CONNECTION, isConnectionError, onlineActionMessage } from '@/components/outbox-status-logic';
import {
  ALL_STAFF,
  buildAcknowledgeBody,
  canHandPhoneToStaff,
  canSignWithTypedName,
  categoryLabel,
  hasSignOffService,
  isMissingSignOffLink,
  kioskStep,
  signOffPaths,
  signOffProgress,
  signedDateLabel,
  toSignOffDoc,
  toSignOffStaff,
  type SignOffDoc,
  type SignOffStaff,
} from '@/components/staff-sign-off-logic';

const MODULE_COLOR = '#0f766e';
const KIOSK_KEY = 'sign-off-kiosk';

interface SignOffInfo { token: string; expiresAt: string | null }

function formatDay(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function StaffSignOffScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useNavigation();
  const qc = useQueryClient();
  const { user, hasService } = useAuth();
  const allowed = canHandPhoneToStaff(user?.role) && hasSignOffService(hasService);
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  // Manager setup
  const info = useQuery<SignOffInfo>({
    queryKey: ['doc-track-sign-off-info', user?.clientId],
    queryFn: () => apiFetch<SignOffInfo>('/api/doc-track/sign-off-info'),
    enabled: allowed,
    retry: false,
  });

  // Kiosk state. The link token is kept in memory only.
  const [kioskToken, setKioskToken] = useState<string | null>(null);
  const [department, setDepartment] = useState<string | null>(null);
  const [staff, setStaff] = useState<SignOffStaff | null>(null);
  const [signDoc, setSignDoc] = useState<SignOffDoc | null>(null);
  const [typedName, setTypedName] = useState('');
  const [signError, setSignError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const paths = kioskToken ? signOffPaths(kioskToken) : null;
  const step = kioskStep({ department, staffId: staff?.id ?? null, signing: !!signDoc });

  const clientInfo = useQuery({
    queryKey: [KIOSK_KEY, kioskToken, 'info'],
    queryFn: () => apiFetch<{ clientName?: string; client_name?: string }>(paths!.info),
    enabled: !!paths,
  });
  const departments = useQuery({
    queryKey: [KIOSK_KEY, kioskToken, 'departments'],
    queryFn: () => apiFetch<unknown[]>(paths!.departments).then((rows) => rows.map(String)),
    enabled: !!paths,
  });
  const staffList = useQuery({
    queryKey: [KIOSK_KEY, kioskToken, 'staff', department],
    queryFn: () => apiFetch<unknown[]>(paths!.staff(department!)).then((rows) => rows.map(toSignOffStaff)),
    enabled: !!paths && department !== null,
  });
  const docs = useQuery({
    queryKey: [KIOSK_KEY, kioskToken, 'documents', staff?.id],
    queryFn: () => apiFetch<unknown[]>(paths!.documents(staff!.id)).then((rows) => rows.map(toSignOffDoc)),
    enabled: !!paths && !!staff,
  });

  const sign = useMutation({
    mutationFn: async () => {
      if (!paths || !staff || !signDoc) throw new Error('Choose a document to sign.');
      const built = buildAcknowledgeBody(signDoc, staff.id, typedName);
      if (!built.ok) throw new Error(built.error);
      await apiFetch(paths.acknowledge, { method: 'POST', body: JSON.stringify(built.body) });
      return signDoc;
    },
    onSuccess: async (doc) => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setSignDoc(null);
      setTypedName('');
      setSignError(null);
      setNotice(`Document signed — ${doc.title} recorded.`);
      await docs.refetch();
    },
    onError: (error: Error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      setSignError(onlineActionMessage(error, 'Sign failed. Please try again.'));
    },
  });

  function resetToStart() {
    setDepartment(null);
    setStaff(null);
    setSignDoc(null);
    setTypedName('');
    setSignError(null);
    setNotice(null);
  }

  function leaveKiosk() {
    resetToStart();
    setKioskToken(null);
    // Nothing a staff member saw stays cached on the manager's phone.
    qc.removeQueries({ queryKey: [KIOSK_KEY] });
  }

  function stepBack() {
    if (step === 'sign') { setSignDoc(null); setTypedName(''); setSignError(null); }
    else if (step === 'documents') { setStaff(null); setNotice(null); }
    else if (step === 'staff') setDepartment(null);
  }

  function confirmReturn() {
    Alert.alert(
      'Return to the manager?',
      'Hand the phone back to the manager. Staff sign-off closes and the next person starts again when the manager reopens it.',
      [
        { text: 'Keep signing', style: 'cancel' },
        { text: 'Return to manager', style: 'destructive', onPress: leaveKiosk },
      ],
    );
  }

  // Kiosk: back gestures and the Android back button step back inside the
  // sign-off flow instead of leaving it for the manager's app.
  const kioskRef = useRef({ active: false, stepBack });
  kioskRef.current = { active: !!kioskToken, stepBack };
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !kioskToken });
  }, [navigation, kioskToken]);
  useEffect(() => navigation.addListener('beforeRemove', (event: { preventDefault: () => void }) => {
    if (!kioskRef.current.active) return;
    event.preventDefault();
    kioskRef.current.stepBack();
  }), [navigation]);

  async function openDocument(doc: SignOffDoc) {
    if (!paths || !staff) return;
    setOpening(true);
    try {
      const { downloadUrl } = await apiFetch<{ downloadUrl: string }>(paths.download(doc, staff.id));
      await WebBrowser.openBrowserAsync(downloadUrl);
    } catch (error) {
      Alert.alert('Could not open document', onlineActionMessage(error));
    } finally {
      setOpening(false);
    }
  }

  const clientName = clientInfo.data?.clientName ?? clientInfo.data?.client_name ?? '';

  // ── Manager setup screen ────────────────────────────────────────────────
  if (!kioskToken) {
    const infoError = info.error;
    const noLink = isMissingSignOffLink(infoError);
    return (
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingBottom: 32 }}>
        <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
          <TouchableOpacity testID="staff-sign-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
            <Feather name="arrow-left" size={22} color="#ffffff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Staff sign-off</Text>
          <Text style={styles.headerSub}>Hand the phone to staff to read and sign documents</Text>
        </View>
        <View style={styles.content}>
          {!allowed ? (
            <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="lock" size={24} color={colors.mutedForeground} />
              <Text style={[styles.panelTitle, { color: colors.foreground }]}>Not available for this account</Text>
              <Text style={[styles.panelText, { color: colors.mutedForeground }]}>
                Staff sign-off needs DocTrack or SafeTrack, and only administrators can hand the phone to staff.
              </Text>
            </View>
          ) : (
            <>
              <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Feather name="edit-3" size={24} color={MODULE_COLOR} />
                <Text style={[styles.panelTitle, { color: colors.foreground }]}>For staff without their own login</Text>
                <Text style={[styles.panelText, { color: colors.mutedForeground }]}>
                  Each staff member picks their department and name, opens the documents that need their acknowledgement and signs by typing their name. It works like your staff sign-off link, and each signature is recorded in DocTrack and TrainTrack. Staff with their own login can sign in the Documents tab instead.
                </Text>
                <Text style={[styles.panelText, { color: colors.mutedForeground }]}>
                  Signing needs an internet connection. Tap “Return to manager” when they hand the phone back.
                </Text>
              </View>
              {info.isLoading ? (
                <ActivityIndicator color={MODULE_COLOR} style={{ marginTop: 24 }} />
              ) : noLink ? (
                <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.warning }]}>
                  <Feather name="link-2" size={22} color={colors.warning} />
                  <Text style={[styles.panelTitle, { color: colors.foreground }]}>No active sign-off link</Text>
                  <Text style={[styles.panelText, { color: colors.mutedForeground }]}>
                    Create a staff sign-off link in DocTrack on the website, then come back here.
                  </Text>
                </View>
              ) : infoError ? (
                <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.destructive }]}>
                  <Feather name="alert-circle" size={22} color={colors.destructive} />
                  <Text style={[styles.panelTitle, { color: colors.foreground }]}>Could not check the sign-off link</Text>
                  <Text style={[styles.panelText, { color: colors.mutedForeground }]}>
                    {isConnectionError(infoError) ? NEEDS_CONNECTION : onlineActionMessage(infoError)}
                  </Text>
                  <TouchableOpacity testID="staff-sign-retry" accessibilityRole="button" style={[styles.secondaryBtn, { borderColor: colors.border }]} onPress={() => info.refetch()}>
                    <Text style={[styles.secondaryBtnText, { color: colors.foreground }]}>Try again</Text>
                  </TouchableOpacity>
                </View>
              ) : info.data?.token ? (
                <>
                  {!!info.data.expiresAt && (
                    <Text style={[styles.note, { color: colors.mutedForeground }]}>
                      Your sign-off link is active until {formatDay(info.data.expiresAt)}.
                    </Text>
                  )}
                  <TouchableOpacity
                    testID="staff-sign-start"
                    accessibilityRole="button"
                    style={[styles.primaryBtn, { backgroundColor: MODULE_COLOR }]}
                    onPress={() => { resetToStart(); setKioskToken(info.data!.token); }}
                  >
                    <Feather name="smartphone" size={18} color="#ffffff" />
                    <Text style={styles.primaryBtnText}>Hand the phone to staff</Text>
                  </TouchableOpacity>
                </>
              ) : null}
            </>
          )}
        </View>
      </ScrollView>
    );
  }

  // ── Kiosk (staff-facing) ────────────────────────────────────────────────
  const progress = signOffProgress(docs.data ?? []);
  const refreshing = departments.isRefetching || staffList.isRefetching || docs.isRefetching;
  const kioskError = clientInfo.error ?? departments.error ?? (step === 'staff' ? staffList.error : null) ?? (step === 'documents' ? docs.error : null);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.kioskHeader, { backgroundColor: colors.navy, paddingTop: topPad + 10 }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.kioskTitle}>Staff sign-off</Text>
          {!!clientName && <Text style={styles.headerSub} numberOfLines={1}>{clientName}</Text>}
        </View>
        <TouchableOpacity testID="staff-sign-return" accessibilityRole="button" onPress={confirmReturn} style={styles.returnBtn}>
          <Feather name="log-out" size={14} color="#ffffff" />
          <Text style={styles.returnText}>Return to manager</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { departments.refetch(); if (department !== null) staffList.refetch(); if (staff) docs.refetch(); }} tintColor={MODULE_COLOR} />}
      >
        {step !== 'department' && (
          <View style={styles.crumbs}>
            <TouchableOpacity testID="staff-sign-step-back" accessibilityRole="button" onPress={stepBack} style={styles.crumbBack}>
              <Feather name="arrow-left" size={14} color={colors.mutedForeground} />
              <Text style={[styles.crumbText, { color: colors.mutedForeground }]}>Back</Text>
            </TouchableOpacity>
            <Text style={[styles.crumbText, { color: colors.foreground }]} numberOfLines={1}>
              {[department === ALL_STAFF ? 'All staff' : department, staff?.name].filter(Boolean).join(' / ')}
            </Text>
          </View>
        )}

        {kioskError ? (
          <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.destructive }]}>
            <Feather name="alert-circle" size={22} color={colors.destructive} />
            <Text style={[styles.panelTitle, { color: colors.foreground }]}>
              {isMissingSignOffLink(kioskError) ? 'Invalid sign-off link' : 'Could not load'}
            </Text>
            <Text style={[styles.panelText, { color: colors.mutedForeground }]}>
              {isMissingSignOffLink(kioskError)
                ? 'This link is no longer valid. Please ask your manager for the correct link.'
                : onlineActionMessage(kioskError)}
            </Text>
          </View>
        ) : step === 'department' ? (
          <>
            <View style={styles.stepHead}>
              <Feather name="briefcase" size={28} color={colors.mutedForeground} />
              <Text style={[styles.stepTitle, { color: colors.foreground }]}>Select your department</Text>
              <Text style={[styles.stepSub, { color: colors.mutedForeground }]}>Tap your team to see your documents</Text>
            </View>
            {departments.isLoading ? <ActivityIndicator color={MODULE_COLOR} /> : (
              <>
                {(departments.data ?? []).length === 0 && (
                  <Text style={[styles.note, { color: colors.mutedForeground, textAlign: 'center' }]}>
                    No departments have been set up yet. Choose All staff below.
                  </Text>
                )}
                <View style={styles.grid}>
                  {[...(departments.data ?? []), ALL_STAFF].map((name) => (
                    <TouchableOpacity
                      key={name}
                      testID={`staff-sign-department-${name}`}
                      accessibilityRole="button"
                      onPress={() => setDepartment(name)}
                      style={[styles.tile, { backgroundColor: colors.card, borderColor: colors.border }]}
                    >
                      <Feather name={name === ALL_STAFF ? 'users' : 'briefcase'} size={18} color={colors.mutedForeground} />
                      <Text style={[styles.tileText, { color: colors.foreground }]}>{name === ALL_STAFF ? 'All staff' : name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </>
        ) : step === 'staff' ? (
          <>
            <View style={styles.stepHead}>
              <Feather name="user" size={28} color={colors.mutedForeground} />
              <Text style={[styles.stepTitle, { color: colors.foreground }]}>Who are you?</Text>
              <Text style={[styles.stepSub, { color: colors.mutedForeground }]}>Select your name from the list</Text>
            </View>
            {staffList.isLoading ? <ActivityIndicator color={MODULE_COLOR} /> : (staffList.data ?? []).length === 0 ? (
              <Text style={[styles.note, { color: colors.mutedForeground, textAlign: 'center' }]}>
                No staff found{department === ALL_STAFF ? '' : ` in ${department}`}.
              </Text>
            ) : (staffList.data ?? []).map((member) => (
              <TouchableOpacity
                key={member.id}
                testID={`staff-sign-staff-${member.id}`}
                accessibilityRole="button"
                onPress={() => { setStaff(member); setNotice(null); }}
                style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowTitle, { color: colors.foreground }]}>{member.name}</Text>
                  {!!member.jobTitle && <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>{member.jobTitle}</Text>}
                </View>
                <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            ))}
            <Text style={[styles.note, { color: colors.mutedForeground, textAlign: 'center' }]}>
              Not in the list? Ask your manager to add you to the staff roster.
            </Text>
          </>
        ) : step === 'sign' && signDoc && staff ? (
          <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border, alignItems: 'stretch' }]}>
            <Text style={[styles.signTitle, { color: colors.foreground }]}>{signDoc.title}</Text>
            <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
              {[categoryLabel(signDoc.category), signDoc.department].filter(Boolean).join(' · ')}
            </Text>
            {!!signDoc.description && (
              <Text style={[styles.description, { color: colors.foreground, backgroundColor: colors.muted }]}>{signDoc.description}</Text>
            )}
            {signDoc.hasFile && (
              <TouchableOpacity
                testID="staff-sign-open"
                accessibilityRole="button"
                disabled={opening}
                onPress={() => openDocument(signDoc)}
                style={[styles.secondaryBtn, { borderColor: colors.border }]}
              >
                {opening ? <ActivityIndicator color={MODULE_COLOR} /> : (
                  <>
                    <Feather name="download" size={16} color={colors.foreground} />
                    <Text style={[styles.secondaryBtnText, { color: colors.foreground }]}>Open & read document before signing</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
            <Text style={[styles.panelText, { color: colors.mutedForeground, textAlign: 'left' }]}>
              Signing as: <Text style={{ fontFamily: 'Inter_700Bold', color: colors.foreground }}>{staff.name}</Text>
              {staff.jobTitle ? ` — ${staff.jobTitle}` : ''}
            </Text>
            <TextInput
              testID="staff-sign-typed-name"
              value={typedName}
              onChangeText={(value) => { setTypedName(value); setSignError(null); }}
              placeholder="Type your full name to confirm"
              placeholderTextColor={colors.mutedForeground}
              accessibilityLabel="Type your full name to confirm"
              autoCapitalize="words"
              autoCorrect={false}
              style={[styles.nameInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
            />
            <Text style={[styles.note, { color: colors.mutedForeground }]}>
              Typing your name serves as your electronic signature confirming you have read this document.
            </Text>
            {!!signError && <Text style={[styles.errorText, { color: colors.destructive }]}>{signError}</Text>}
            <TouchableOpacity
              testID="staff-sign-confirm"
              accessibilityRole="button"
              disabled={!canSignWithTypedName(typedName) || sign.isPending}
              onPress={() => sign.mutate()}
              style={[styles.primaryBtn, { backgroundColor: canSignWithTypedName(typedName) && !sign.isPending ? MODULE_COLOR : colors.mutedForeground }]}
            >
              {sign.isPending ? <ActivityIndicator color="#ffffff" /> : (
                <>
                  <Feather name="check-square" size={18} color="#ffffff" />
                  <Text style={styles.primaryBtnText}>Confirm & Sign</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {!!notice && (
              <View style={[styles.banner, { backgroundColor: colors.success + '18', borderColor: colors.success + '55' }]}>
                <Feather name="check-circle" size={16} color={colors.success} />
                <Text style={[styles.bannerText, { color: colors.foreground }]}>{notice}</Text>
              </View>
            )}
            {docs.isLoading ? <ActivityIndicator color={MODULE_COLOR} style={{ marginTop: 24 }} /> : progress.total === 0 ? (
              <View style={styles.stepHead}>
                <Feather name="check-circle" size={40} color={colors.success} />
                <Text style={[styles.stepTitle, { color: colors.foreground }]}>No documents to sign</Text>
                <Text style={[styles.stepSub, { color: colors.mutedForeground }]}>There are no documents requiring your acknowledgement right now.</Text>
                <TouchableOpacity testID="staff-sign-done-empty" accessibilityRole="button" style={[styles.secondaryBtn, { borderColor: colors.border }]} onPress={resetToStart}>
                  <Text style={[styles.secondaryBtnText, { color: colors.foreground }]}>Done — return to start</Text>
                </TouchableOpacity>
              </View>
            ) : progress.allSigned ? (
              <View style={styles.stepHead}>
                <Feather name="check-circle" size={44} color={colors.success} />
                <Text style={[styles.stepTitle, { color: colors.foreground }]}>All signed!</Text>
                <Text style={[styles.stepSub, { color: colors.mutedForeground }]}>You have acknowledged all required documents. Thank you.</Text>
                <TouchableOpacity testID="staff-sign-done" accessibilityRole="button" style={[styles.secondaryBtn, { borderColor: colors.border }]} onPress={resetToStart}>
                  <Text style={[styles.secondaryBtnText, { color: colors.foreground }]}>Done — return to start</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <View style={styles.docsHead}>
                  <Text style={[styles.stepTitle, { color: colors.foreground }]}>Your documents</Text>
                  <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>{progress.signed}/{progress.total} signed</Text>
                </View>
                {!!progress.message && (
                  <View style={[styles.banner, { backgroundColor: colors.warning + '18', borderColor: colors.warning + '55' }]}>
                    <Feather name="check-square" size={16} color={colors.warning} />
                    <Text style={[styles.bannerText, { color: colors.foreground }]}>{progress.message}</Text>
                  </View>
                )}
                {(docs.data ?? []).map((doc) => (
                  <View
                    key={`${doc.documentType}:${doc.id}`}
                    style={[styles.docCard, { backgroundColor: colors.card, borderColor: doc.signed ? colors.success + '66' : colors.border }]}
                  >
                    <View style={styles.docTop}>
                      <Feather name={doc.signed ? 'check-circle' : 'file-text'} size={20} color={doc.signed ? colors.success : colors.mutedForeground} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.rowTitle, { color: colors.foreground }]}>{doc.title}</Text>
                        <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
                          {[categoryLabel(doc.category), doc.department].filter(Boolean).join(' · ')}
                        </Text>
                        {!!doc.description && (
                          <Text style={[styles.rowSub, { color: colors.mutedForeground }]} numberOfLines={2}>{doc.description}</Text>
                        )}
                        {doc.signed && !!signedDateLabel(doc.acknowledgedAt) && (
                          <Text style={[styles.signedText, { color: colors.success }]}>{signedDateLabel(doc.acknowledgedAt)}</Text>
                        )}
                      </View>
                    </View>
                    {!doc.signed && (
                      <TouchableOpacity
                        testID={`staff-sign-doc-${doc.documentType}-${doc.id}`}
                        accessibilityRole="button"
                        onPress={() => { setSignDoc(doc); setTypedName(''); setSignError(null); setNotice(null); }}
                        style={[styles.primaryBtn, { backgroundColor: MODULE_COLOR, marginTop: 10 }]}
                      >
                        <Feather name="edit-3" size={16} color="#ffffff" />
                        <Text style={styles.primaryBtnText}>Read & Sign</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  back: { marginBottom: 10, alignSelf: 'flex-start', padding: 2 },
  headerTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: '#ffffff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter_400Regular' },
  kioskHeader: { paddingHorizontal: 16, paddingBottom: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  kioskTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: '#ffffff' },
  returnBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 },
  returnText: { color: '#ffffff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  panel: { borderWidth: 1, borderRadius: 8, padding: 16, gap: 8, alignItems: 'center' },
  panelTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'center' },
  panelText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 20 },
  note: { fontSize: 12, fontFamily: 'Inter_400Regular', lineHeight: 17 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 8, minHeight: 48, paddingHorizontal: 16 },
  primaryBtnText: { color: '#ffffff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  secondaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 8, borderWidth: 1, minHeight: 44, paddingHorizontal: 14, marginTop: 4 },
  secondaryBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  crumbs: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  crumbBack: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingRight: 6 },
  crumbText: { fontSize: 13, fontFamily: 'Inter_500Medium', flexShrink: 1 },
  stepHead: { alignItems: 'center', gap: 6, paddingVertical: 12 },
  stepTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', textAlign: 'center' },
  stepSub: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { flexBasis: '47%', flexGrow: 1, borderWidth: 1, borderRadius: 10, padding: 16, gap: 8, minHeight: 84 },
  tileText: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  row: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8, padding: 14, gap: 12, minHeight: 56 },
  rowTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  rowSub: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  docsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 8, padding: 12 },
  bannerText: { flex: 1, fontSize: 14, fontFamily: 'Inter_500Medium' },
  docCard: { borderWidth: 1, borderRadius: 10, padding: 14 },
  docTop: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  signedText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', marginTop: 4 },
  signTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  description: { fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20, borderRadius: 8, padding: 12 },
  nameInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, fontFamily: 'Inter_500Medium', minHeight: 48 },
  errorText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
});
