/**
 * Full-screen asset tag scanner for PATtrack. Reads a barcode or QR label with
 * the device camera (or a typed tag) and resolves it against the appliance
 * register. A unique active match is handed to onSelect; retired, unknown and
 * shared tags are explained in place with a way back to the list.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { matchAssetTag, type TagMatch, type TaggedAppliance } from '@/components/pat-tag-logic';

const BARCODE_TYPES: BarcodeType[] = [
  'qr', 'datamatrix', 'code128', 'code39', 'code93', 'ean13', 'ean8', 'upc_a', 'upc_e', 'itf14', 'codabar',
];

type Problem<T extends TaggedAppliance> = Exclude<TagMatch<T>, { kind: 'empty' } | { kind: 'match' }>;

interface Props<T extends TaggedAppliance> {
  visible: boolean;
  appliances: T[];
  onClose: () => void;
  /** Called once the scanner has closed, with the appliance to log. */
  onSelect: (appliance: T) => void;
}

export function PatTagScanner<T extends TaggedAppliance>({ visible, appliances, onClose, onSelect }: Props<T>) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [problem, setProblem] = useState<Problem<T> | null>(null);
  const [typedTag, setTypedTag] = useState('');
  const [torch, setTorch] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const scanLocked = useRef(false);
  const pendingSelection = useRef<T | null>(null);

  // Reset on close so the next open starts on a live camera, not the last problem.
  useEffect(() => {
    if (visible) return;
    scanLocked.current = false;
    setProblem(null);
    setTypedTag('');
    setTorch(false);
    setCameraError(false);
  }, [visible]);

  // Returning from the Settings app does not update the permission hook on its own.
  useEffect(() => {
    if (!visible) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') getPermission().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [visible, getPermission]);

  function select(appliance: T) {
    scanLocked.current = true;
    // iOS cannot present the log form while this modal is still dismissing,
    // so the hand-off waits for onDismiss there.
    if (Platform.OS === 'ios') {
      pendingSelection.current = appliance;
      onClose();
    } else {
      onClose();
      onSelect(appliance);
    }
  }

  function resolve(raw: string) {
    const outcome = matchAssetTag(appliances, raw);
    if (outcome.kind === 'empty') {
      scanLocked.current = false;
      return;
    }
    if (outcome.kind === 'match') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      select(outcome.appliance);
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    setProblem(outcome);
  }

  function onBarcodeScanned({ data }: { data: string }) {
    if (scanLocked.current) return;
    scanLocked.current = true;
    resolve(data);
  }

  function scanAgain() {
    setProblem(null);
    setTypedTag('');
    scanLocked.current = false;
  }

  function submitTyped() {
    if (!typedTag.trim()) return;
    scanLocked.current = true;
    resolve(typedTag);
  }

  const canOpenSettings = Platform.OS !== 'web';
  const granted = permission?.granted === true;
  const cameraActive = granted && !cameraError && problem === null;

  let cameraArea: React.ReactNode;
  if (!permission) {
    cameraArea = <ActivityIndicator color="#ffffff" />;
  } else if (!granted) {
    cameraArea = (
      <View style={styles.notice} testID="pat-scan-permission">
        <Feather name="camera-off" size={32} color="#ffffff" />
        <Text style={styles.noticeTitle}>Camera access needed</Text>
        <Text style={styles.noticeText}>
          {permission.canAskAgain
            ? 'ComplyTrack uses the camera only to read appliance asset tags.'
            : canOpenSettings
              ? 'Camera access is turned off for ComplyTrack. Turn it on in Settings, or type the tag below.'
              : 'Camera access is blocked in this browser. Allow it in the site settings, or type the tag below.'}
        </Text>
        {permission.canAskAgain ? (
          <TouchableOpacity
            testID="pat-scan-allow-camera"
            style={[styles.noticeBtn, { backgroundColor: colors.primary }]}
            onPress={() => { requestPermission().catch(() => undefined); }}
          >
            <Text style={styles.noticeBtnText}>Allow camera</Text>
          </TouchableOpacity>
        ) : canOpenSettings ? (
          <TouchableOpacity
            testID="pat-scan-open-settings"
            style={[styles.noticeBtn, { backgroundColor: colors.primary }]}
            onPress={() => { Linking.openSettings().catch(() => undefined); }}
          >
            <Text style={styles.noticeBtnText}>Open settings</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  } else if (cameraError) {
    cameraArea = (
      <View style={styles.notice} testID="pat-scan-camera-error">
        <Feather name="camera-off" size={32} color="#ffffff" />
        <Text style={styles.noticeTitle}>Camera unavailable</Text>
        <Text style={styles.noticeText}>The camera could not start. Type the tag below or choose from the list.</Text>
      </View>
    );
  } else {
    cameraArea = (
      <>
        <CameraView
          testID="pat-scan-camera"
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
          onBarcodeScanned={cameraActive ? onBarcodeScanned : undefined}
          onMountError={() => setCameraError(true)}
        />
        {cameraActive ? (
          <View pointerEvents="none" style={styles.frameWrap}>
            <View style={styles.frame} />
            <Text style={styles.frameHint}>Point the camera at the appliance's asset tag</Text>
          </View>
        ) : null}
        {Platform.OS !== 'web' ? (
          <TouchableOpacity
            testID="pat-scan-torch"
            style={styles.torchBtn}
            onPress={() => setTorch((on) => !on)}
            accessibilityLabel={torch ? 'Turn torch off' : 'Turn torch on'}
          >
            <Feather name={torch ? 'zap-off' : 'zap'} size={20} color="#ffffff" />
          </TouchableOpacity>
        ) : null}
      </>
    );
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={() => {
        const appliance = pendingSelection.current;
        pendingSelection.current = null;
        if (appliance) onSelect(appliance);
      }}
    >
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: Platform.OS === 'web' ? 24 : insets.top }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.foreground }]}>Scan asset tag</Text>
          <TouchableOpacity testID="pat-scan-close" onPress={onClose} accessibilityLabel="Close scanner">
            <Feather name="x" size={24} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        <View style={styles.camera}>{cameraArea}</View>

        <View style={[styles.panel, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          {problem ? (
            <View
              testID={`pat-scan-${problem.kind}`}
              style={[styles.problem, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={styles.problemHeading}>
                <Feather
                  name={problem.kind === 'unknown' ? 'help-circle' : problem.kind === 'retired' ? 'archive' : 'copy'}
                  size={18}
                  color={colors.warning}
                />
                <Text style={[styles.problemTitle, { color: colors.foreground }]}>
                  {problem.kind === 'unknown'
                    ? 'Tag not recognised'
                    : problem.kind === 'retired'
                      ? 'Appliance retired'
                      : 'Several appliances share this tag'}
                </Text>
              </View>
              <Text style={[styles.problemText, { color: colors.mutedForeground }]}>
                {problem.kind === 'unknown'
                  ? `No appliance on your PAT register has the tag "${problem.tag}". Check the label and scan again, or choose the appliance from the list. New appliances are added on the web app.`
                  : problem.kind === 'retired'
                    ? `"${problem.tag}" belongs to ${problem.appliance.name}, which is retired and cannot receive new tests. Reactivate it on the web app first.`
                    : `${problem.appliances.length} active appliances have the tag "${problem.tag}". Choose the one you are testing.`}
              </Text>
              {problem.kind === 'multiple'
                ? problem.appliances.map((appliance) => (
                    <TouchableOpacity
                      key={appliance.id}
                      testID={`pat-scan-choose-${appliance.id}`}
                      style={[styles.choice, { borderColor: colors.border }]}
                      onPress={() => select(appliance)}
                    >
                      <Text style={[styles.choiceText, { color: colors.foreground }]}>{appliance.name}</Text>
                      <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
                    </TouchableOpacity>
                  ))
                : null}
              <View style={styles.problemActions}>
                <TouchableOpacity
                  testID="pat-scan-again"
                  style={[styles.secondaryBtn, { borderColor: colors.border }]}
                  onPress={scanAgain}
                >
                  <Text style={[styles.secondaryBtnText, { color: colors.foreground }]}>
                    {granted && !cameraError ? 'Scan again' : 'Try another tag'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="pat-scan-use-list"
                  style={[styles.secondaryBtn, { borderColor: colors.border }]}
                  onPress={onClose}
                >
                  <Text style={[styles.secondaryBtnText, { color: colors.foreground }]}>Choose from list</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <>
              <Text style={[styles.label, { color: colors.foreground }]}>Or type the tag</Text>
              <View style={styles.typedRow}>
                <TextInput
                  testID="pat-scan-typed-tag"
                  style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
                  value={typedTag}
                  onChangeText={setTypedTag}
                  placeholder="e.g. PAT-0042"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="search"
                  onSubmitEditing={submitTyped}
                />
                <TouchableOpacity
                  testID="pat-scan-find"
                  style={[styles.findBtn, { backgroundColor: colors.navy }, !typedTag.trim() && { opacity: 0.5 }]}
                  onPress={submitTyped}
                  disabled={!typedTag.trim()}
                >
                  <Text style={styles.findBtnText}>Find</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity testID="pat-scan-use-list" style={styles.listLink} onPress={onClose}>
                <Text style={[styles.listLinkText, { color: colors.primary }]}>Choose from the list instead</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  camera: {
    flex: 1,
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  frameWrap: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 16 },
  frame: {
    width: '70%',
    aspectRatio: 1.6,
    borderWidth: 2,
    borderColor: '#ffffff',
    borderRadius: 12,
  },
  frameHint: {
    color: '#ffffff',
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  torchBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: { alignItems: 'center', gap: 10, paddingHorizontal: 28 },
  noticeTitle: { color: '#ffffff', fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'center' },
  noticeText: { color: '#d4d4d8', fontSize: 13, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 19 },
  noticeBtn: { marginTop: 6, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 6 },
  noticeBtnText: { color: '#ffffff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  panel: { paddingHorizontal: 16, paddingTop: 16 },
  label: { fontSize: 13, fontFamily: 'Inter_600SemiBold', marginBottom: 8 },
  typedRow: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1,
    height: 46,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  findBtn: { height: 46, paddingHorizontal: 18, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  findBtnText: { color: '#ffffff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  listLink: { alignItems: 'center', paddingVertical: 14 },
  listLinkText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  problem: { borderWidth: 1, borderRadius: 8, padding: 14, gap: 10 },
  problemHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  problemTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  problemText: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 19 },
  problemActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  choiceText: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  secondaryBtn: { flex: 1, borderWidth: 1, borderRadius: 6, paddingVertical: 12, alignItems: 'center' },
  secondaryBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
});
