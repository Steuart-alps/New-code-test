import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useColors } from '@/hooks/useColors';
import { hasSignatureInk, signatureDataUrl, type SignatureStroke } from './drawn-signature-logic';

/**
 * Draw a signature with a finger. Calls onChange with the PNG data URL the
 * API accepts (or null when cleared or empty), the same as the website's
 * drawn-signature dialog.
 */
export function SignaturePad({
  onChange,
  onDrawingChange,
  disabled = false,
  testID = 'signature-pad',
}: {
  onChange: (signature: string | null) => void;
  /** Lets a parent ScrollView stop scrolling while the finger is down. */
  onDrawingChange?: (drawing: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const [strokes, setStrokes] = useState<SignatureStroke[]>([]);
  const strokesRef = useRef<SignatureStroke[]>([]);
  const size = useRef({ width: 0, height: 0 });
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const publish = (next: SignatureStroke[]) => {
    strokesRef.current = next;
    setStrokes(next);
  };

  const finish = () => {
    onDrawingChange?.(false);
    const { width, height } = size.current;
    onChange(signatureDataUrl(strokesRef.current, width, height));
  };

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !disabledRef.current,
    onMoveShouldSetPanResponder: () => !disabledRef.current,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (event) => {
      onDrawingChange?.(true);
      const { locationX: x, locationY: y } = event.nativeEvent;
      publish([...strokesRef.current, [{ x, y }]]);
    },
    onPanResponderMove: (event) => {
      const { locationX: x, locationY: y } = event.nativeEvent;
      const current = strokesRef.current;
      if (!current.length) return;
      const last = current[current.length - 1];
      publish([...current.slice(0, -1), [...last, { x, y }]]);
    },
    onPanResponderRelease: () => finish(),
    onPanResponderTerminate: () => finish(),
  }), [onChange, onDrawingChange]);

  const clear = () => {
    publish([]);
    onChange(null);
  };

  const paths = strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => stroke.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '));

  return (
    <View>
      <View
        testID={testID}
        accessible
        accessibilityLabel="Draw your signature"
        onLayout={(event) => { size.current = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height }; }}
        style={[styles.pad, { borderColor: colors.border, opacity: disabled ? 0.55 : 1 }]}
        {...responder.panHandlers}
      >
        <Svg width="100%" height="100%" pointerEvents="none">
          {paths.map((d, index) => (
            <Path key={index} d={d} stroke="#162D42" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          ))}
        </Svg>
        {!hasSignatureInk(strokes) && (
          <Text pointerEvents="none" style={[styles.hint, { color: '#94a3b8' }]}>Sign here</Text>
        )}
      </View>
      <TouchableOpacity
        testID={`${testID}-clear`}
        accessibilityRole="button"
        disabled={disabled || !strokes.length}
        onPress={clear}
        style={[styles.clearButton, (disabled || !strokes.length) && { opacity: 0.4 }]}
      >
        <Text style={[styles.clearText, { color: colors.primary }]}>Clear</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  // 3:1, the same shape as the website's 720×240 canvas.
  pad: { width: '100%', aspectRatio: 3, borderWidth: 1, borderRadius: 8, backgroundColor: '#ffffff', overflow: 'hidden' },
  hint: { position: 'absolute', left: 14, bottom: 10, fontSize: 13, fontFamily: 'Inter_400Regular' },
  clearButton: { alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 4, minHeight: 36 },
  clearText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
});
