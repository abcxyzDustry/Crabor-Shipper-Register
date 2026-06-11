// ============================================================
// CRABOR Customer App — Root Entry
// ============================================================
import React, { useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity,
  Linking, Platform, ActivityIndicator,
} from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import Constants from 'expo-constants';
import { io } from 'socket.io-client';
import { useState } from 'react';

import AppNavigator from './src/navigation/AppNavigator';
import { AuthProvider, useAuth } from './shared/auth';
import { Colors } from './shared/theme';
import { api, BASE_URL, VersionAPI, PushAPI } from './shared/api';
import { Storage, KEYS } from './shared/storage';

SplashScreen.preventAutoHideAsync();

const APP_VERSION = '1.0.0';
const APK_DOWNLOAD_URL = 'https://crabor-shipper-register.onrender.com/download/customer-app.apk';

export let socket = null;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// ── Inner App (có access AuthContext) ───────────────────────
function InnerApp() {
  const { isLoggedIn, loading: authLoading } = useAuth();
  const [appReady, setAppReady]   = useState(false);
  const [updateModal, setUpdateModal] = useState(false);
  const [updateVersion, setUpdateVersion] = useState('');
  const notifRef = useRef(null);

  useEffect(() => {
    init();
    return () => {
      notifRef.current?.remove();
      socket?.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Kết nối socket khi user đăng nhập
    if (isLoggedIn) connectSocket();
    else socket?.disconnect();
  }, [isLoggedIn]);

  const init = async () => {
    try {
      await setupNotifications();
      await checkUpdate();
    } catch (e) {
      // Silent
    } finally {
      setAppReady(true);
      await SplashScreen.hideAsync();
    }
  };

  const connectSocket = async () => {
    const session = await Storage.get(KEYS.SESSION);
    if (!session) return;
    socket = io(BASE_URL, {
      withCredentials: true,
      extraHeaders: { Cookie: session },
      reconnection: true,
      reconnectionDelay: 2000,
      transports: ['websocket'],
    });
    socket.on('connect', () => console.log('Customer socket connected'));
  };

  const setupNotifications = async () => {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') return;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('orders', {
        name: 'Đơn hàng',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 200, 500],
        lightColor: Colors.primary,
        sound: 'default',
      });
    }
    try {
      const token = (await Notifications.getExpoPushTokenAsync({
        projectId: Constants.expoConfig?.extra?.eas?.projectId,
      })).data;
      await PushAPI.registerToken(token, Platform.OS);
    } catch (e) { /* silent */ }
    notifRef.current = Notifications.addNotificationReceivedListener(n => {
      console.log('Notification received:', n);
    });
  };

  const checkUpdate = async () => {
    try {
      const last = await Storage.get(KEYS.LAST_UPDATE_CHECK, 0);
      if (Date.now() - last < 30 * 60 * 1000) return;
      await Storage.set(KEYS.LAST_UPDATE_CHECK, Date.now());
      const data = await VersionAPI.check();
      const sv = data?.customerVersion || data?.version;
      if (sv && isNewer(sv, APP_VERSION)) {
        setUpdateVersion(sv);
        setUpdateModal(true);
      }
    } catch (e) { /* silent */ }
  };

  const isNewer = (sv, cv) => {
    const s = sv.split('.').map(Number);
    const c = cv.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((s[i] || 0) > (c[i] || 0)) return true;
      if ((s[i] || 0) < (c[i] || 0)) return false;
    }
    return false;
  };

  // Chờ auth state restore xong mới render
  if (!appReady || authLoading) {
    return (
      <View style={st.splash}>
        <Text style={{ fontSize: 64 }}>🦀</Text>
        <Text style={st.splashTitle}>CRABOR</Text>
        <ActivityIndicator color="#fff" style={{ marginTop: 20 }} />
      </View>
    );
  }

  return (
    <>
      <NavigationContainer>
        <AppNavigator />
      </NavigationContainer>

      {/* Update modal */}
      <Modal visible={updateModal} transparent animationType="fade">
        <View style={st.overlay}>
          <View style={st.updateCard}>
            <Text style={{ fontSize: 48 }}>🆕</Text>
            <Text style={st.updateTitle}>Bản cập nhật mới!</Text>
            <Text style={st.updateVer}>v{updateVersion}</Text>
            <Text style={st.updateSub}>Cập nhật để trải nghiệm tốt hơn.</Text>
            <TouchableOpacity style={st.updateBtn} onPress={() => Linking.openURL(APK_DOWNLOAD_URL)}>
              <Text style={st.updateBtnText}>⬇️ Cập nhật ngay</Text>
            </TouchableOpacity>
            <TouchableOpacity style={st.skipBtn} onPress={() => setUpdateModal(false)}>
              <Text style={st.skipText}>Để sau</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

// ── Root export ──────────────────────────────────────────────
export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <InnerApp />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const st = StyleSheet.create({
  splash: { flex: 1, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  splashTitle: { fontSize: 36, fontWeight: '900', color: '#fff', letterSpacing: 4, marginTop: 8 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  updateCard: { backgroundColor: '#fff', borderRadius: 20, padding: 28, width: '100%', alignItems: 'center' },
  updateTitle: { fontSize: 20, fontWeight: '800', color: Colors.black, marginTop: 8 },
  updateVer: { fontSize: 14, color: Colors.primary, fontWeight: '700', marginTop: 4 },
  updateSub: { fontSize: 13, color: Colors.gray4, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  updateBtn: { backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, marginTop: 20, width: '100%', alignItems: 'center' },
  updateBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  skipBtn: { marginTop: 12, padding: 8 },
  skipText: { color: Colors.gray4, fontSize: 13 },
});
