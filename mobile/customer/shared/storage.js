// ============================================================
// CRABOR Shared Storage Utility
// ============================================================
import AsyncStorage from '@react-native-async-storage/async-storage';

export const Storage = {
  set: async (key, value) => {
    try { await AsyncStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
  get: async (key, fallback = null) => {
    try {
      const v = await AsyncStorage.getItem(key);
      return v !== null ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  remove: async (key) => { try { await AsyncStorage.removeItem(key); } catch {} },
  clear: async () => { try { await AsyncStorage.clear(); } catch {} },
};

// Keys
export const KEYS = {
  SESSION: 'crabor_session',
  USER: 'crabor_user',
  PHONE: 'crabor_phone',
  FCM_TOKEN: 'crabor_fcm',
  APP_VERSION: 'crabor_version',
  LAST_UPDATE_CHECK: 'crabor_update_check',
};
