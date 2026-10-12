import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { setBaseUrl } from '@workspace/api-client-react';
import { AuthProvider, useAuth } from '@/lib/auth';
import { apiBaseUrl } from '@/lib/api';
import { resolveNotificationRoute } from '@/lib/notificationRoutes';
import { ConfigurationError } from '@/components/ConfigurationError';

// Set API base URL at module load time (Expo bundles need absolute URLs).
// A build without EXPO_PUBLIC_DOMAIN has no API to talk to: release builds
// show a configuration error instead of a login screen that cannot work.
const API_BASE_URL = apiBaseUrl();
setBaseUrl(API_BASE_URL);
if (!API_BASE_URL) {
  console.warn('[config] EXPO_PUBLIC_DOMAIN is not set; API requests have no server to reach.');
}

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

function RootLayoutNav() {
  const { isAuthenticated, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    const inAuthGroup = segments[0] === '(auth)';
    if (!isAuthenticated && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (isAuthenticated && inAuthGroup) {
      router.replace('/(tabs)' as any);
    }
  }, [isAuthenticated, isLoading, segments]);

  // Notification taps: navigate to the screen for the payload's route hint.
  // Hints for web-only pages map to the nearest mobile screen, else home.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as
        | { route?: unknown }
        | undefined;
      if (!isAuthenticated) return;
      try {
        router.push(resolveNotificationRoute(data?.route) as any);
      } catch {
        // Ignore navigation failures; the app stays on the current screen.
      }
    });
    return () => sub.remove();
  }, [isAuthenticated]);

  return (
    <Stack screenOptions={{ headerBackTitle: '' }}>
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="checks/[type]"
        options={{
          title: 'Log Check',
          headerStyle: { backgroundColor: '#162d42' },
          headerTintColor: '#ffffff',
          headerTitleStyle: { fontFamily: 'Inter_600SemiBold' },
        }}
      />
      <Stack.Screen
        name="checks/daily"
        options={{
          title: 'DailyTrack',
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="checks/cleaning"
        options={{
          title: 'Cleaning',
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="checks/kitchen"
        options={{
          title: 'KitchenTrack',
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="checks/aqua"
        options={{
          title: 'AquaTrack',
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="checks/incident"
        options={{
          title: 'IncidentTrack',
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="checks/pat"
        options={{
          title: 'PATtrack',
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="checks/safe-track"
        options={{
          title: 'SafeTrack',
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="issues/new"
        options={{
          title: 'Report Issue',
          headerStyle: { backgroundColor: '#162d42' },
          headerTintColor: '#ffffff',
          headerTitleStyle: { fontFamily: 'Inter_600SemiBold' },
        }}
      />
      <Stack.Screen
        name="issues/[id]"
        options={{
          title: 'Issue Details',
          headerStyle: { backgroundColor: '#162d42' },
          headerTintColor: '#ffffff',
          headerTitleStyle: { fontFamily: 'Inter_600SemiBold' },
        }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  if (!API_BASE_URL && !__DEV__) {
    return (
      <SafeAreaProvider>
        <ConfigurationError />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <KeyboardProvider>
                <RootLayoutNav />
              </KeyboardProvider>
            </GestureHandlerRootView>
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
