import AsyncStorage from '@react-native-async-storage/async-storage';
import { REGISTER_CACHE_PREFIX } from '../components/registers-logic';

/** Remove every saved register list (allergens, COSHH, asbestos) on sign-out. */
export async function clearRegisterCache(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const cacheKeys = keys.filter((key) => key.startsWith(REGISTER_CACHE_PREFIX));
  if (cacheKeys.length > 0) await AsyncStorage.multiRemove(cacheKeys);
}
