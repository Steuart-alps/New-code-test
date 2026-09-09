import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { KitchenTemperatureForm } from '@/components/KitchenTemperatureForm';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';

export default function KitchenCheckScreen() {
  const colors = useColors();
  const { hasService } = useAuth();

  if (!hasService('kitchentrack')) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.title, { color: colors.foreground }]}>KitchenTrack</Text>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>
          KitchenTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  return <KitchenTemperatureForm />;
}

const styles = StyleSheet.create({
  gated: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  title: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
});