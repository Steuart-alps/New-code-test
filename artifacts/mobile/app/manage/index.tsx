import React from 'react';
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { MANAGE_ITEMS, visibleManageItems } from '@/components/manage-items';

// Manage hub: manager tools and look-ups, opened from the Checks tab. Setup,
// users, billing and settings stay on the website.
export default function ManageScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, hasService } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const items = visibleManageItems(MANAGE_ITEMS, user?.role, hasService);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingBottom: 32 }}>
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
        <TouchableOpacity testID="manage-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
          <Feather name="arrow-left" size={22} color="#ffffff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Manage and look up</Text>
        <Text style={styles.headerSub}>Actions, certificates, tasks, registers and training</Text>
      </View>
      <View style={styles.content}>
        {items.length === 0 ? (
          <Text testID="manage-empty" style={[styles.empty, { color: colors.mutedForeground }]}>
            Nothing to manage on the phone for this account. Setup and settings are on the website.
          </Text>
        ) : items.map((item) => (
          <TouchableOpacity
            key={item.id}
            testID={`manage-item-${item.id}`}
            accessibilityRole="button"
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => router.push(item.route as any)}
            activeOpacity={0.75}
          >
            <View style={[styles.iconWrap, { backgroundColor: item.iconColor + '1a' }]}>
              <Feather name={item.icon as React.ComponentProps<typeof Feather>['name']} size={22} color={item.iconColor} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>{item.label}</Text>
              <Text style={[styles.cardSub, { color: colors.mutedForeground }]}>{item.subtitle}</Text>
            </View>
            <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        ))}
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
  empty: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 24 },
  card: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8, padding: 14, gap: 14 },
  iconWrap: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
  cardSub: { fontSize: 13, fontFamily: 'Inter_400Regular' },
});
