// ============================================================
// CRABOR Shipper App — Root Entry (patched with socket rooms)
// ============================================================
import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity,
  Linking, Alert, Platform, ActivityIndicator, Vibration,
} from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import * as SplashScreen from 'expo-splash-screen';
import Constants from 'expo-constants';
import { io } from 'socket.io-client';

import ShipperNavigator from './src/navigation/ShipperNavigator';
import { Colors } from './shared/theme';
import { api, BASE_URL, VersionAPI } from './shared/api';
import { Storage, KEYS } from './shared/storage';

SplashScreen.preventAutoHideAsync();

const APP_VERSION = '1.0.0';
const APK_DOWNLOAD_URL = 'https://crabor-shipper-register.onrender.com/download/shipper-app.apk';

export let socket = null;
export const setSocket = (s) => { socket = s; };

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true,
  }),
});

export default function App() {
  const [appReady, setAppReady] = useState(false);
  const [updateModal, setUpdateModal] = useState(false);
  const [updateVersion, setUpdateVersion] = useState('');
  const notifListener = useRef(null);
  const responseListener = useRef(null);

  useEffect(() => {
    init();
    return () => {
      Notifications.removeNotificationSubscription(notifListener.current);
      Notifications.removeNotificationSubscription(responseListener.current);
      socket?.disconnect();
    };
  }, []);

  const init = async () => {
    try {
      await setupNotifications();
      await checkUpdate();
      const session = await Storage.get(KEYS.SESSION);
      if (session) {
        api.setSessionCookie(session);
        connectSocket(session);
      }
    } catch (e) { console.warn(e); }
    finally { setAppReady(true); await SplashScreen.hideAsync(); }
  };

  const connectSocket = async (session) => {
    const s = io(BASE_URL, {
      withCredentials: true,
      extraHeaders: { Cookie: session },
      reconnection: true, reconnectionDelay: 2000,
      transports: ['websocket'],
    });
    s.on('connect', async () => {
      console.log('Shipper socket connected');
      // Join room shipper riêng + broadcast room
      const user = await Storage.get(KEYS.USER);
      const shipperId = user?._id || user?.shipper?._id;
      if (shipperId) {
        s.emit('join_shipper', shipperId);
        s.emit('join_shipper_broadcast');
      }
    });
    // Nhận đơn hàng đồ ăn → ShipperHomeScreen xử lý qua socket.on('order_request')
    // Nhận cuốc xe → ShipperHomeScreen xử lý qua socket.on('ride_request')
    // Ví được cộng tiền
    s.on('wallet_credited', (data) => {
      if (data.message) Alert.alert('💰 Thu nhập', data.message);
    });
    setSocket(s);
    socket = s;
  };

  const setupNotifications = async () => {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') return;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('orders', {
        name: 'Đơn hàng mới',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 200, 500],
        lightColor: Colors.primary, sound: 'default',
      });
    }
    try {
      const token = (await Notifications.getExpoPushTokenAsync({
        projectId: Constants.expoConfig?.extra?.eas?.projectId,
      })).data;
      await Storage.set(KEYS.FCM_TOKEN, token);
      await api.post('/api/shipper/push-token', { token, platform: Platform.OS });
    } catch (e) {}
    notifListener.current = Notifications.addNotificationReceivedListener(n => {
      console.log('Notif:', n);
    });
    responseListener.current = Notifications.addNotificationResponseReceivedListener(r => {
      const data = r.notification.request.content.data;
      console.log('Notif response:', data);
    });
  };

  const checkUpdate = async () => {
    try {
      const last = await Storage.get(KEYS.LAST_UPDATE_CHECK, 0);
      if (Date.now() - last < 30 * 60 * 1000) return;
      await Storage.set(KEYS.LAST_UPDATE_CHECK, Date.now());
      const data = await VersionAPI.check();
      const sv = data?.shipperVersion || data?.version;
      if (sv && isNewer(sv, APP_VERSION)) {
        setUpdateVersion(sv);
        setUpdateModal(true);
      }
    } catch (e) {}
  };

  const isNewer = (s, c) => {
    const sv = s.split('.').map(Number), cv = c.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((sv[i] || 0) > (cv[i] || 0)) return true;
      if ((sv[i] || 0) < (cv[i] || 0)) return false;
    }
    return false;
  };

  if (!appReady) {
    return (
      <View style={styles.splash}>
        <Text style={styles.splashLogo}>🦀</Text>
        <Text style={styles.splashTitle}>CRABOR</Text>
        <Text style={styles.splashSub}>Shipper</Text>
        <ActivityIndicator color={Colors.white} style={{ marginTop: 20 }} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <ShipperNavigator />
      </NavigationContainer>
      <Modal visible={updateModal} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.updateCard}>
            <Text style={styles.updateEmoji}>🆕</Text>
            <Text style={styles.updateTitle}>Bản cập nhật mới!</Text>
            <Text style={styles.updateVersion}>v{updateVersion}</Text>
            <Text style={styles.updateSub}>Cập nhật để nhận đơn nhanh hơn và ổn định hơn.</Text>
            <TouchableOpacity style={styles.updateBtn} onPress={() => Linking.openURL(APK_DOWNLOAD_URL)}>
              <Text style={styles.updateBtnText}>⬇️ Cập nhật ngay</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.skipBtn} onPress={() => setUpdateModal(false)}>
              <Text style={styles.skipText}>Để sau</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  splashLogo: { fontSize: 72 },
  splashTitle: { fontSize: 36, fontWeight: '900', color: Colors.white, letterSpacing: 4, marginTop: 8 },
  splashSub: { fontSize: 16, color: 'rgba(255,255,255,0.7)', fontWeight: '600', letterSpacing: 2 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  updateCard: { backgroundColor: Colors.white, borderRadius: 20, padding: 28, width: '100%', alignItems: 'center' },
  updateEmoji: { fontSize: 48, marginBottom: 8 },
  updateTitle: { fontSize: 20, fontWeight: '800', color: Colors.black },
  updateVersion: { fontSize: 14, color: Colors.primary, fontWeight: '700', marginTop: 4 },
  updateSub: { fontSize: 13, color: Colors.gray4, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  updateBtn: { backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, marginTop: 20, width: '100%', alignItems: 'center' },
  updateBtnText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  skipBtn: { marginTop: 12, padding: 8 },
  skipText: { color: Colors.gray4, fontSize: 13 },
});
