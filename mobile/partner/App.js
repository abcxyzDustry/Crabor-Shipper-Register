// ============================================================
// CRABOR Partner App — Root Entry
// ============================================================
import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity,
  Linking, Platform, ActivityIndicator, Vibration,
} from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import Constants from 'expo-constants';
import { io } from 'socket.io-client';

import PartnerNavigator from './src/navigation/PartnerNavigator';
import { Colors } from './shared/theme';
import { api, BASE_URL, VersionAPI } from './shared/api';
import { Storage, KEYS } from './shared/storage';
import { AuthContext } from './shared/auth';
import { setSocket } from './shared/socket';

SplashScreen.preventAutoHideAsync();

const APP_VERSION = '1.0.0';
const APK_DOWNLOAD_URL = 'https://crabor-shipper-register.onrender.com/download/partner-app.apk';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true,
  }),
});

export default function App() {
  const [appReady, setAppReady]     = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [updateModal, setUpdateModal] = useState(false);
  const [updateVersion, setUpdateVersion] = useState('');
  const notifRef = useRef(null);

  useEffect(() => {
    init();
    return () => {
      if (notifRef.current) Notifications.removeNotificationSubscription(notifRef.current);
      const s = getSocket?.();
      if (s) s.disconnect();
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
        setIsLoggedIn(true);
      }
    } catch (e) {}
    finally { setAppReady(true); await SplashScreen.hideAsync(); }
  };

  const connectSocket = (session) => {
    const s = io(BASE_URL, {
      withCredentials: true,
      extraHeaders: { Cookie: session },
      reconnection: true, reconnectionDelay: 2000,
      transports: ['websocket'],
    });
    s.on('connect', async () => {
      console.log('Partner socket connected');
      // Lấy partnerId từ storage để join room riêng
      const partner = await Storage.get('crabor_partner');
      if (partner?._id) s.emit('join_partner', partner._id);
    });
    // Đơn hàng mới từ customer
    s.on('new_order', (data) => {
      Vibration.vibrate([0, 500, 200, 500]);
      Alert.alert('🆕 Đơn hàng mới!',
        `${data.order?.customerName || 'Khách hàng'} vừa đặt ${data.order?.items?.length || 0} món.\nTổng: ${(data.order?.total || 0).toLocaleString('vi-VN')}đ`,
        [{ text: 'Xem ngay', onPress: () => {} }, { text: 'OK' }]
      );
    });
    // Shipper đã nhận đơn
    s.on('order_status_update', (data) => {
      if (data.status === 'shipper_accepted') {
        Alert.alert('🛵 Shipper đã nhận đơn!', `Đơn #${data.orderId?.slice(-6)} đang được giao.`);
      }
    });
    // Ví được cộng tiền
    s.on('wallet_credited', (data) => {
      if (data.message) Alert.alert('💰 Ví Partner', data.message);
    });
    setSocket(s);
  };

  const setupNotifications = async () => {
    try {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') return;
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('orders', {
          name: 'Đơn hàng mới',
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
        await api.post('/api/partner/push-token', { token, platform: Platform.OS });
      } catch (e) {}
      notifRef.current = Notifications.addNotificationReceivedListener(n => console.log(n));
    } catch (e) {}
  };

  const checkUpdate = async () => {
    try {
      const last = await Storage.get(KEYS.LAST_UPDATE_CHECK, 0);
      if (Date.now() - last < 30 * 60 * 1000) return;
      await Storage.set(KEYS.LAST_UPDATE_CHECK, Date.now());
      const data = await VersionAPI.check();
      const sv = data?.partnerVersion || data?.version;
      if (sv && isNewer(sv, APP_VERSION)) { setUpdateVersion(sv); setUpdateModal(true); }
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

  if (!appReady) return (
    <View style={st.splash}>
      <Text style={{ fontSize: 64 }}>🦀</Text>
      <Text style={st.splashTitle}>CRABOR</Text>
      <Text style={st.splashSub}>Partner</Text>
      <ActivityIndicator color="#fff" style={{ marginTop: 20 }} />
    </View>
  );

  return (
    <AuthContext.Provider value={{ isLoggedIn, setIsLoggedIn }}>
      <SafeAreaProvider>
        <NavigationContainer>
          <PartnerNavigator />
        </NavigationContainer>
        <Modal visible={updateModal} transparent animationType="fade">
          <View style={st.overlay}>
            <View style={st.updateCard}>
              <Text style={{ fontSize: 48 }}>🆕</Text>
              <Text style={st.updateTitle}>Bản cập nhật mới!</Text>
              <Text style={st.updateVer}>v{updateVersion}</Text>
              <Text style={st.updateSub}>Cập nhật để quản lý đơn hàng hiệu quả hơn.</Text>
              <TouchableOpacity style={st.updateBtn} onPress={() => Linking.openURL(APK_DOWNLOAD_URL)}>
                <Text style={st.updateBtnText}>⬇️ Cập nhật ngay</Text>
              </TouchableOpacity>
              <TouchableOpacity style={st.skipBtn} onPress={() => setUpdateModal(false)}>
                <Text style={st.skipText}>Để sau</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </SafeAreaProvider>
    </AuthContext.Provider>
  );
}

const st = StyleSheet.create({
  splash: { flex: 1, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  splashTitle: { fontSize: 36, fontWeight: '900', color: '#fff', letterSpacing: 4, marginTop: 8 },
  splashSub: { fontSize: 16, color: 'rgba(255,255,255,0.7)', fontWeight: '600', letterSpacing: 3 },
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
