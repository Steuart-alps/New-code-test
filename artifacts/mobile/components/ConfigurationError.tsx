import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

/**
 * Shown by release builds made without EXPO_PUBLIC_DOMAIN. Such a build has
 * no API server to talk to, so a login screen would only fail confusingly.
 */
export function ConfigurationError() {
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.card}>
        <Feather name="alert-triangle" size={36} color="#f59e0b" />
        <Text style={styles.title}>ComplyTrack is not configured</Text>
        <Text style={styles.body}>
          This copy of the app was built without the address of the ComplyTrack
          server, so it cannot sign you in.
        </Text>
        <Text style={styles.body}>
          Please install the latest version of the app, or contact your
          ComplyTrack administrator.
        </Text>
        <Text style={styles.detail}>Build setting missing: EXPO_PUBLIC_DOMAIN</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#162d42', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#ffffff', borderRadius: 10, padding: 24, gap: 12, alignItems: 'center' },
  title: { fontSize: 18, fontWeight: '700', color: '#162d42', textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 21, color: '#334155', textAlign: 'center' },
  detail: { fontSize: 12, color: '#64748b', textAlign: 'center', marginTop: 4 },
});
