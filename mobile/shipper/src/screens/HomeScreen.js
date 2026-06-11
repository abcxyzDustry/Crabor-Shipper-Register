// ============================================================
// Shipper Home Screen — Online Toggle, Orders, Map
// ============================================================
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert,
  Switch, ScrollView, RefreshControl, ActivityIndicator,
  Vibration, Modal, Image, Linking, Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import MapView, { Marker, Polyline } from 'react-native-maps';
import * as Notifications from 'expo-notifications';

import { Colors, Spacing, Radius, Shadow, formatCurrency, formatDateTime, ORDER_STATUS } from '../../shared/theme';
import { ShipperAPI } from '../../shared/api';
import { socket } from '../../App';

const GOONG_KEY = 'YOUR_GOONG_API_KEY';

const STATUS_STEPS = ['confirmed', 'preparing', 'ready', 'picking_up', 'delivering', 'delivered'];
const STATUS_LABELS = {
  confirmed: 'Xác nhận', preparing: 'Chuẩn bị', ready: 'Sẵn sàng',
  picking_up: 'Lấy hàng', delivering: 'Đang giao', delivered: 'Đã giao',
};

export default function HomeScreen({ navigation }) {
  const [shipper, setShipper] = useState(null);
  const [online, setOnline] = useState(false);
  const [pendingOrders, setPendingOrders] = useState([]);
  const [activeOrder, setActiveOrder] = useState(null);
  const [location, setLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [requestModal, setRequestModal] = useState(false);
  const [incomingOrder, setIncomingOrder] = useState(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const locationWatcher = useRef(null);
  const requestTimer = useRef(null);

  useEffect(() => {
    loadShipper();
    requestLocationPermission();
    setupSocket();
    return () => {
      locationWatcher.current?.remove();
      clearTimeout(requestTimer.current);
    };
  }, []);

  // Pulse animation for online indicator
  useEffect(() => {
    if (online) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.4, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [online]);

  const setupSocket = () => {
    if (!socket) return;
    socket.on('new_order_request', (order) => {
      setIncomingOrder(order);
      setRequestModal(true);
      Vibration.vibrate([0, 500, 200, 500, 200, 500]);
      // Auto-dismiss after 30s
      requestTimer.current = setTimeout(() => {
        setRequestModal(false);
        setIncomingOrder(null);
      }, 30000);
    });
    socket.on('order_cancelled', () => {
      setActiveOrder(null);
      Alert.alert('Đơn bị huỷ', 'Khách hàng đã huỷ đơn hàng.');
    });
  };

  const requestLocationPermission = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Cần quyền vị trí', 'App cần quyền vị trí để điều phối đơn hàng.');
      return;
    }
    const loc = await Location.getCurrentPositionAsync({});
    setLocation(loc.coords);
    // Watch location continuously
    locationWatcher.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 10000, distanceInterval: 30 },
      (loc) => {
        setLocation(loc.coords);
        if (online) {
          ShipperAPI.updateLocation({
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
          }).catch(() => {});
        }
      }
    );
  };

  const loadShipper = async () => {
    try {
      const res = await ShipperAPI.getMe();
      setShipper(res.shipper || res);
    } catch (e) {}
    finally { setLoading(false); setRefreshing(false); }
  };

  const handleToggleOnline = async (val) => {
    setOnline(val);
    try {
      await ShipperAPI.updateLocation({
        online: val,
        lat: location?.latitude,
        lng: location?.longitude,
      });
    } catch (e) {}
    if (val) {
      Alert.alert('✅ Bạn đang online', 'Hệ thống sẽ phân công đơn hàng cho bạn.');
    }
  };

  const handleAcceptOrder = async () => {
    if (!incomingOrder) return;
    clearTimeout(requestTimer.current);
    setRequestModal(false);
    try {
      await ShipperAPI.acceptOrder(incomingOrder._id);
      setActiveOrder({ ...incomingOrder, status: 'picking_up' });
      setIncomingOrder(null);
    } catch (e) {
      Alert.alert('Lỗi', e.message);
    }
  };

  const handleRejectOrder = () => {
    clearTimeout(requestTimer.current);
    setRequestModal(false);
    setIncomingOrder(null);
  };

  const handleAdvanceStatus = async () => {
    if (!activeOrder) return;
    const curIdx = STATUS_STEPS.indexOf(activeOrder.status);
    if (curIdx < 0 || curIdx >= STATUS_STEPS.length - 1) return;
    const nextStatus = STATUS_STEPS[curIdx + 1];

    Alert.alert(
      'Xác nhận',
      `Chuyển trạng thái sang: ${STATUS_LABELS[nextStatus]}?`,
      [
        { text: 'Huỷ', style: 'cancel' },
        {
          text: 'Xác nhận', onPress: async () => {
            try {
              await ShipperAPI.updateOrderStatus(activeOrder._id, nextStatus);
              if (nextStatus === 'delivered') {
                Alert.alert('🎉 Giao hàng thành công!', 'Đơn hàng đã hoàn thành.');
                setActiveOrder(null);
              } else {
                setActiveOrder(prev => ({ ...prev, status: nextStatus }));
              }
            } catch (e) { Alert.alert('Lỗi', e.message); }
          }
        }
      ]
    );
  };

  const handleCallCustomer = () => {
    if (activeOrder?.customerPhone) {
      Linking.openURL(`tel:${activeOrder.customerPhone}`);
    }
  };

  const handleOpenMap = () => {
    if (!activeOrder) return;
    const dest = activeOrder.status === 'picking_up'
      ? activeOrder.pickupLocation
      : activeOrder.deliveryAddress;
    if (dest?.lat && dest?.lng) {
      const url = `https://maps.google.com/?q=${dest.lat},${dest.lng}`;
      Linking.openURL(url);
    }
  };

  const getStatusColor = (s) => ORDER_STATUS[s]?.color || Colors.primary;
  const getStatusLabel = (s) => ORDER_STATUS[s]?.label || s;

  if (loading) return (
    <SafeAreaView style={styles.safe}>
      <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} />
    </SafeAreaView>
  );

  // If shipper not approved yet
  if (shipper?.status === 'pending') {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.pendingScreen}>
          <Text style={{ fontSize: 64 }}>⏳</Text>
          <Text style={styles.pendingTitle}>Đang chờ phê duyệt</Text>
          <Text style={styles.pendingSub}>Hồ sơ của bạn đang được xem xét. Thường mất 1-2 ngày làm việc.</Text>
          <TouchableOpacity style={styles.refreshBtn} onPress={loadShipper}>
            <Text style={styles.refreshBtnText}>🔄 Kiểm tra lại</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (shipper?.status === 'rejected') {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.pendingScreen}>
          <Text style={{ fontSize: 64 }}>❌</Text>
          <Text style={styles.pendingTitle}>Hồ sơ bị từ chối</Text>
          <Text style={styles.pendingSub}>{shipper.rejectReason || 'Hồ sơ không đạt yêu cầu. Vui lòng liên hệ hỗ trợ.'}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerGreet}>Xin chào! 🦀</Text>
          <Text style={styles.headerName}>{shipper?.name || 'Shipper'}</Text>
        </View>
        <View style={styles.onlineToggle}>
          <Animated.View style={[styles.onlineDot, online && styles.onlineDotActive, { transform: [{ scale: pulseAnim }] }]} />
          <Text style={styles.onlineLabel}>{online ? 'Online' : 'Offline'}</Text>
          <Switch
            value={online}
            onValueChange={handleToggleOnline}
            trackColor={{ false: Colors.gray3, true: Colors.success }}
            thumbColor={Colors.white}
          />
        </View>
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadShipper(); }} tintColor={Colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Stats row */}
        <View style={styles.statsRow}>
          {[
            { icon: '📦', label: 'Hôm nay', value: `${shipper?.todayOrders || 0} đơn` },
            { icon: '💰', label: 'Thu nhập', value: formatCurrency(shipper?.todayEarnings || 0) },
            { icon: '⭐', label: 'Đánh giá', value: `${shipper?.rating || '5.0'}/5` },
          ].map((s, i) => (
            <View key={i} style={styles.statCard}>
              <Text style={styles.statIcon}>{s.icon}</Text>
              <Text style={styles.statValue}>{s.value}</Text>
              <Text style={styles.statLabel}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* Active order */}
        {activeOrder ? (
          <View style={styles.activeOrderCard}>
            <View style={styles.activeOrderHeader}>
              <Text style={styles.activeOrderTitle}>🛵 Đơn đang thực hiện</Text>
              <View style={[styles.statusBadge, { backgroundColor: getStatusColor(activeOrder.status) }]}>
                <Text style={styles.statusBadgeText}>{getStatusLabel(activeOrder.status)}</Text>
              </View>
            </View>

            {/* Progress steps */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 12 }}>
              <View style={styles.stepsRow}>
                {STATUS_STEPS.map((s, i) => {
                  const curIdx = STATUS_STEPS.indexOf(activeOrder.status);
                  const done = i <= curIdx;
                  return (
                    <View key={s} style={styles.stepItem}>
                      <View style={[styles.stepCircle, done && styles.stepCircleDone]}>
                        <Text style={styles.stepCircleText}>{done ? '✓' : i + 1}</Text>
                      </View>
                      {i < STATUS_STEPS.length - 1 && <View style={[styles.stepLine, done && styles.stepLineDone]} />}
                      <Text style={styles.stepLabel}>{STATUS_LABELS[s]}</Text>
                    </View>
                  );
                })}
              </View>
            </ScrollView>

            {/* Order info */}
            <View style={styles.orderInfo}>
              <Text style={styles.orderInfoRow}>🏪 {activeOrder.partnerName}</Text>
              <Text style={styles.orderInfoRow}>📍 {activeOrder.deliveryAddress?.address}</Text>
              <Text style={styles.orderInfoRow}>💰 {formatCurrency(activeOrder.total)}</Text>
              {activeOrder.note && <Text style={styles.orderInfoRow}>📝 {activeOrder.note}</Text>}
            </View>

            {/* Action buttons */}
            <View style={styles.orderActions}>
              <TouchableOpacity style={styles.mapBtn} onPress={handleOpenMap}>
                <Text style={styles.mapBtnText}>🗺️ Xem bản đồ</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.callBtn} onPress={handleCallCustomer}>
                <Text style={styles.callBtnText}>📞 Gọi KH</Text>
              </TouchableOpacity>
            </View>
            {STATUS_STEPS.indexOf(activeOrder.status) < STATUS_STEPS.length - 1 && (
              <TouchableOpacity style={styles.advanceBtn} onPress={handleAdvanceStatus}>
                <Text style={styles.advanceBtnText}>Bước tiếp theo →</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : online ? (
          <View style={styles.waitingCard}>
            <Text style={styles.waitingEmoji}>🟢</Text>
            <Text style={styles.waitingTitle}>Đang chờ đơn hàng...</Text>
            <Text style={styles.waitingSub}>Hệ thống sẽ tự động phân công đơn gần bạn nhất</Text>
            <ActivityIndicator color={Colors.primary} style={{ marginTop: 12 }} />
          </View>
        ) : (
          <View style={styles.offlineCard}>
            <Text style={{ fontSize: 48 }}>😴</Text>
            <Text style={styles.offlineTitle}>Bạn đang offline</Text>
            <Text style={styles.offlineSub}>Bật Online để nhận đơn hàng</Text>
          </View>
        )}

        <View style={{ height: 20 }} />
      </ScrollView>

      {/* Incoming order modal */}
      <Modal visible={requestModal} transparent animationType="slide">
        <View style={styles.requestOverlay}>
          <View style={styles.requestCard}>
            <View style={styles.requestHeader}>
              <Text style={styles.requestEmoji}>📦</Text>
              <Text style={styles.requestTitle}>Đơn hàng mới!</Text>
            </View>

            {incomingOrder && (
              <View style={styles.requestInfo}>
                <Text style={styles.requestRow}>🏪 {incomingOrder.partnerName}</Text>
                <Text style={styles.requestRow}>📍 {incomingOrder.deliveryAddress?.address}</Text>
                <Text style={styles.requestRow}>📏 {incomingOrder.distance || '?'} km</Text>
                <Text style={styles.requestRow}>💰 Ship: {formatCurrency(incomingOrder.shipFee || 0)}</Text>
                <Text style={styles.requestRow}>🕐 ~{incomingOrder.estimatedTime || 20} phút</Text>
                {incomingOrder.items && (
                  <Text style={styles.requestRow} numberOfLines={2}>
                    🍽️ {incomingOrder.items.map(i => i.name).join(', ')}
                  </Text>
                )}
              </View>
            )}

            <View style={styles.requestActions}>
              <TouchableOpacity style={styles.rejectBtn} onPress={handleRejectOrder}>
                <Text style={styles.rejectBtnText}>✗ Từ chối</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.acceptBtn} onPress={handleAcceptOrder}>
                <Text style={styles.acceptBtnText}>✓ Nhận đơn</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.timerHint}>Tự động đóng sau 30 giây</Text>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: {
    backgroundColor: Colors.primary, flexDirection: 'row',
    justifyContent: 'space-between', alignItems: 'center',
    padding: Spacing.lg,
  },
  headerGreet: { color: 'rgba(255,255,255,0.8)', fontSize: 12 },
  headerName: { color: Colors.white, fontSize: 18, fontWeight: '800' },
  onlineToggle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  onlineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.gray3 },
  onlineDotActive: { backgroundColor: '#2ECC71' },
  onlineLabel: { color: Colors.white, fontSize: 12, fontWeight: '600' },
  statsRow: { flexDirection: 'row', margin: Spacing.lg, gap: 8 },
  statCard: {
    flex: 1, backgroundColor: Colors.white, borderRadius: Radius.md,
    padding: 12, alignItems: 'center', ...Shadow.sm,
  },
  statIcon: { fontSize: 24 },
  statValue: { fontSize: 13, fontWeight: '800', color: Colors.primary, marginTop: 4 },
  statLabel: { fontSize: 10, color: Colors.textSub, marginTop: 2 },
  activeOrderCard: {
    margin: Spacing.lg, backgroundColor: Colors.white, borderRadius: Radius.lg,
    padding: Spacing.lg, ...Shadow.md, borderTopWidth: 4, borderTopColor: Colors.primary,
  },
  activeOrderHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  activeOrderTitle: { fontWeight: '800', fontSize: 15 },
  statusBadge: { borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  statusBadgeText: { color: Colors.white, fontWeight: '700', fontSize: 12 },
  stepsRow: { flexDirection: 'row', alignItems: 'flex-start' },
  stepItem: { alignItems: 'center', width: 70 },
  stepCircle: {
    width: 32, height: 32, borderRadius: 16, borderWidth: 2,
    borderColor: Colors.gray3, backgroundColor: Colors.white,
    alignItems: 'center', justifyContent: 'center',
  },
  stepCircleDone: { borderColor: Colors.primary, backgroundColor: Colors.primary },
  stepCircleText: { fontSize: 12, fontWeight: '700', color: Colors.gray4 },
  stepLine: { position: 'absolute', top: 15, left: 51, width: 38, height: 2, backgroundColor: Colors.gray3 },
  stepLineDone: { backgroundColor: Colors.primary },
  stepLabel: { fontSize: 9, color: Colors.textSub, textAlign: 'center', marginTop: 4 },
  orderInfo: { backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 12, marginVertical: 8 },
  orderInfoRow: { fontSize: 13, color: Colors.text, marginBottom: 4 },
  orderActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  mapBtn: { flex: 1, backgroundColor: Colors.info, borderRadius: Radius.md, paddingVertical: 12, alignItems: 'center' },
  mapBtnText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  callBtn: { flex: 1, backgroundColor: Colors.success, borderRadius: Radius.md, paddingVertical: 12, alignItems: 'center' },
  callBtnText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  advanceBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.md,
    paddingVertical: 14, alignItems: 'center', marginTop: 10,
  },
  advanceBtnText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  waitingCard: {
    margin: Spacing.lg, backgroundColor: Colors.white, borderRadius: Radius.lg,
    padding: 32, alignItems: 'center', ...Shadow.sm,
  },
  waitingEmoji: { fontSize: 48, marginBottom: 8 },
  waitingTitle: { fontSize: 16, fontWeight: '800', color: Colors.text },
  waitingSub: { fontSize: 13, color: Colors.textSub, textAlign: 'center', marginTop: 6 },
  offlineCard: {
    margin: Spacing.lg, backgroundColor: Colors.white, borderRadius: Radius.lg,
    padding: 32, alignItems: 'center', ...Shadow.sm,
  },
  offlineTitle: { fontSize: 16, fontWeight: '800', color: Colors.gray5, marginTop: 8 },
  offlineSub: { fontSize: 13, color: Colors.gray4, marginTop: 4 },
  pendingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  pendingTitle: { fontSize: 20, fontWeight: '800', color: Colors.text, marginTop: 12 },
  pendingSub: { fontSize: 14, color: Colors.textSub, textAlign: 'center', marginTop: 8, lineHeight: 22 },
  refreshBtn: { marginTop: 24, backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 12, paddingHorizontal: 32 },
  refreshBtnText: { color: Colors.white, fontWeight: '700', fontSize: 14 },
  requestOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  requestCard: { backgroundColor: Colors.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  requestHeader: { alignItems: 'center', marginBottom: 16 },
  requestEmoji: { fontSize: 48 },
  requestTitle: { fontSize: 22, fontWeight: '900', color: Colors.primary, marginTop: 8 },
  requestInfo: { backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 14, marginBottom: 16 },
  requestRow: { fontSize: 14, color: Colors.text, marginBottom: 6 },
  requestActions: { flexDirection: 'row', gap: 12 },
  rejectBtn: {
    flex: 1, backgroundColor: Colors.gray1, borderRadius: Radius.md,
    paddingVertical: 16, alignItems: 'center',
  },
  rejectBtnText: { color: Colors.danger, fontWeight: '800', fontSize: 16 },
  acceptBtn: {
    flex: 2, backgroundColor: Colors.primary, borderRadius: Radius.md,
    paddingVertical: 16, alignItems: 'center',
  },
  acceptBtnText: { color: Colors.white, fontWeight: '900', fontSize: 16 },
  timerHint: { textAlign: 'center', color: Colors.gray4, fontSize: 11, marginTop: 10 },
});
