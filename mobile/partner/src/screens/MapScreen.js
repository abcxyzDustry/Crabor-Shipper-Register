// ============================================================
// Partner Map Screen — Vị trí cửa hàng (không dùng WebView)
// ============================================================
import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert,
  Linking, Platform, ActivityIndicator, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { Colors, Spacing, Radius, Shadow, formatDateTime } from '../../shared/theme';
import { api } from '../../shared/api';

const getMsg = (e) => e?.message || e?.data?.message || e?.error || 'Đã có lỗi';

export default function MapScreen({ navigation, route }) {
  const order = route.params?.order;
  const [location, setLocation]   = useState(null);
  const [address, setAddress]     = useState('');
  const [loading, setLoading]     = useState(true);
  const [sharing, setSharing]     = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const watchRef = useRef(null);

  useEffect(() => {
    startTracking();
    return () => stopTracking();
  }, []);

  const startTracking = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Cần quyền truy cập', 'Cho phép ứng dụng truy cập vị trí để shipper tìm đến bạn.');
        setLoading(false);
        return;
      }

      // Lấy vị trí lần đầu
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setLocation(coords);
      setLoading(false);
      sendLocation(coords);
      reverseGeocode(coords);

      // Watch position
      watchRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 10 },
        (pos) => {
          const c = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setLocation(c);
          setLastUpdate(new Date());
          sendLocation(c);
        }
      );
    } catch (e) {
      Alert.alert('Lỗi', getMsg(e));
      setLoading(false);
    }
  };

  const stopTracking = () => {
    if (watchRef.current) watchRef.current.remove?.();
    setSharing(false);
  };

  const sendLocation = async (coords) => {
    try {
      await api.post('/api/partner/location', coords);
    } catch (e) {}
  };

  const reverseGeocode = async (coords) => {
    try {
      const res = await Location.reverseGeocodeAsync({
        latitude: coords.lat, longitude: coords.lng,
      });
      if (res[0]) {
        const r = res[0];
        setAddress([r.street, r.district, r.city].filter(Boolean).join(', '));
      }
    } catch (e) {}
  };

  const openGoogleMaps = () => {
    if (!location) return;
    const url = `https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`;
    Linking.openURL(url);
  };

  const openAppleMaps = () => {
    if (!location) return;
    const url = `maps://maps.apple.com/?q=${location.lat},${location.lng}`;
    Linking.openURL(url);
  };

  const shareLocation = () => {
    if (!location) return;
    Alert.alert('Chia sẻ vị trí', 'Mở bằng ứng dụng nào?', [
      { text: 'Google Maps', onPress: openGoogleMaps },
      Platform.OS === 'ios' && { text: 'Apple Maps', onPress: openAppleMaps },
      { text: 'Copy link', onPress: () => {
        const url = `https://maps.google.com/?q=${location.lat},${location.lng}`;
        Alert.alert('Link vị trí', url);
      }},
      { text: 'Huỷ', style: 'cancel' },
    ].filter(Boolean));
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
          <Text style={s.backTxt}>←</Text>
        </TouchableOpacity>
        <Text style={s.title}>📍 Vị trí cửa hàng</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={s.content}>
        {loading ? (
          <View style={s.center}>
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={s.loadTxt}>Đang xác định vị trí...</Text>
          </View>
        ) : location ? (
          <>
            {/* Status card */}
            <View style={[s.statusCard, sharing && s.statusCardOn]}>
              <View style={s.statusDot} />
              <View style={{ flex: 1 }}>
                <Text style={s.statusTitle}>
                  {sharing ? '🟢 Đang chia sẻ vị trí' : '🔴 Đã dừng chia sẻ'}
                </Text>
                <Text style={s.statusSub}>
                  {sharing ? 'Shipper có thể xem vị trí của bạn realtime' : 'Bật lại để shipper tìm đến'}
                </Text>
              </View>
            </View>

            {/* Location info */}
            <View style={s.locCard}>
              <Text style={s.locTitle}>📍 Vị trí hiện tại</Text>

              {address ? (
                <Text style={s.locAddress}>{address}</Text>
              ) : null}

              <View style={s.coordRow}>
                <View style={s.coordItem}>
                  <Text style={s.coordLabel}>Vĩ độ</Text>
                  <Text style={s.coordVal}>{location.lat.toFixed(6)}</Text>
                </View>
                <View style={s.coordItem}>
                  <Text style={s.coordLabel}>Kinh độ</Text>
                  <Text style={s.coordVal}>{location.lng.toFixed(6)}</Text>
                </View>
              </View>

              {lastUpdate && (
                <Text style={s.updateTime}>
                  Cập nhật lúc {new Date(lastUpdate).toLocaleTimeString('vi-VN')}
                </Text>
              )}
            </View>

            {/* Map buttons */}
            <View style={s.mapBtns}>
              <TouchableOpacity style={[s.mapBtn, { backgroundColor: '#4285F4' }]}
                onPress={openGoogleMaps}>
                <Text style={s.mapBtnIco}>🗺️</Text>
                <Text style={s.mapBtnTxt}>Google Maps</Text>
              </TouchableOpacity>
              {Platform.OS === 'ios' && (
                <TouchableOpacity style={[s.mapBtn, { backgroundColor: '#34AADC' }]}
                  onPress={openAppleMaps}>
                  <Text style={s.mapBtnIco}>🍎</Text>
                  <Text style={s.mapBtnTxt}>Apple Maps</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Share link */}
            <TouchableOpacity style={s.shareBtn} onPress={shareLocation}>
              <Text style={s.shareBtnTxt}>📤 Chia sẻ vị trí với shipper</Text>
            </TouchableOpacity>

            {/* Instructions */}
            <View style={s.infoCard}>
              <Text style={s.infoTitle}>ℹ️ Hướng dẫn</Text>
              {[
                'Giữ màn hình này mở để shipper nhận vị trí realtime',
                'Nhấn "Chia sẻ vị trí" để gửi link cho shipper qua Zalo/Messenger',
                'Mở Google Maps để xem đường shipper đang đến',
                order ? 'Sau khi đưa đồ → nhấn "Đã đưa đồ" bên dưới' : '',
              ].filter(Boolean).map((tip, i) => (
                <View key={i} style={s.tipRow}>
                  <Text style={s.tipDot}>▸</Text>
                  <Text style={s.tipTxt}>{tip}</Text>
                </View>
              ))}
            </View>

            {/* Toggle sharing */}
            <TouchableOpacity
              style={[s.toggleBtn, sharing ? s.toggleBtnOff : s.toggleBtnOn]}
              onPress={() => {
                if (sharing) { stopTracking(); }
                else { startTracking(); setSharing(true); }
              }}>
              <Text style={s.toggleBtnTxt}>
                {sharing ? '⏸ Dừng chia sẻ vị trí' : '▶ Bật lại chia sẻ vị trí'}
              </Text>
            </TouchableOpacity>

            {/* Confirm handover button */}
            {order && (
              <TouchableOpacity
                style={s.handoverBtn}
                onPress={() => navigation.navigate('ConfirmHandover', { order })}>
                <Text style={s.handoverBtnTxt}>✅ Đã đưa đồ cho shipper</Text>
              </TouchableOpacity>
            )}
          </>
        ) : (
          <View style={s.center}>
            <Text style={{ fontSize: 48 }}>📍</Text>
            <Text style={s.loadTxt}>Không lấy được vị trí{'\n'}Kiểm tra quyền GPS trong Cài đặt</Text>
            <TouchableOpacity style={s.retryBtn} onPress={startTracking}>
              <Text style={s.retryTxt}>🔄 Thử lại</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.settingsBtn}
              onPress={() => Linking.openSettings()}>
              <Text style={s.settingsTxt}>⚙️ Mở Cài đặt</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: {
    backgroundColor: Colors.primary, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', padding: Spacing.lg,
  },
  backBtn: { padding: 4 },
  backTxt: { color: '#fff', fontSize: 24, fontWeight: '700' },
  title: { fontSize: 16, fontWeight: '800', color: '#fff' },
  content: { padding: Spacing.md, paddingBottom: 40 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  loadTxt: { fontSize: 14, color: Colors.textSub, textAlign: 'center', lineHeight: 22 },
  retryBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.md,
    paddingVertical: 12, paddingHorizontal: 28, marginTop: 8,
  },
  retryTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
  settingsBtn: { paddingVertical: 10 },
  settingsTxt: { color: Colors.primary, fontWeight: '700', fontSize: 14 },
  // Status
  statusCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: Radius.lg, padding: 14,
    marginBottom: 12, borderLeftWidth: 4, borderLeftColor: Colors.gray3, ...Shadow.sm,
  },
  statusCardOn: { borderLeftColor: Colors.success },
  statusDot: {
    width: 12, height: 12, borderRadius: 6, backgroundColor: Colors.success,
  },
  statusTitle: { fontSize: 14, fontWeight: '800', color: Colors.text },
  statusSub: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
  // Location
  locCard: {
    backgroundColor: '#fff', borderRadius: Radius.lg,
    padding: Spacing.lg, marginBottom: 12, ...Shadow.sm,
  },
  locTitle: { fontWeight: '800', fontSize: 15, marginBottom: 10 },
  locAddress: {
    fontSize: 14, color: Colors.text, fontWeight: '600',
    marginBottom: 12, lineHeight: 20,
  },
  coordRow: { flexDirection: 'row', gap: 12 },
  coordItem: {
    flex: 1, backgroundColor: Colors.gray1,
    borderRadius: Radius.md, padding: 10,
  },
  coordLabel: { fontSize: 11, color: Colors.textSub, fontWeight: '700' },
  coordVal: { fontSize: 13, fontWeight: '800', color: Colors.text, marginTop: 4 },
  updateTime: { fontSize: 11, color: Colors.textSub, marginTop: 10, textAlign: 'center' },
  // Map buttons
  mapBtns: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  mapBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, borderRadius: Radius.md, paddingVertical: 13, ...Shadow.sm,
  },
  mapBtnIco: { fontSize: 18 },
  mapBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
  // Share
  shareBtn: {
    backgroundColor: '#fff', borderRadius: Radius.md, borderWidth: 2,
    borderColor: Colors.primary, paddingVertical: 13, alignItems: 'center',
    marginBottom: 12, ...Shadow.sm,
  },
  shareBtnTxt: { color: Colors.primary, fontWeight: '800', fontSize: 14 },
  // Info
  infoCard: {
    backgroundColor: '#fff', borderRadius: Radius.lg,
    padding: Spacing.lg, marginBottom: 12, ...Shadow.sm,
  },
  infoTitle: { fontWeight: '800', fontSize: 14, marginBottom: 10 },
  tipRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
  tipDot: { color: Colors.primary, fontWeight: '800', fontSize: 14, marginTop: 1 },
  tipTxt: { fontSize: 13, color: Colors.text, flex: 1, lineHeight: 20 },
  // Toggle
  toggleBtn: {
    borderRadius: Radius.md, paddingVertical: 13,
    alignItems: 'center', marginBottom: 10,
  },
  toggleBtnOff: { backgroundColor: Colors.gray2, borderWidth: 1.5, borderColor: Colors.gray3 },
  toggleBtnOn: { backgroundColor: Colors.success },
  toggleBtnTxt: { fontWeight: '800', fontSize: 14, color: Colors.text },
  // Handover
  handoverBtn: {
    backgroundColor: Colors.success, borderRadius: Radius.lg,
    paddingVertical: 16, alignItems: 'center', ...Shadow.md,
  },
  handoverBtnTxt: { color: '#fff', fontWeight: '900', fontSize: 15 },
});
