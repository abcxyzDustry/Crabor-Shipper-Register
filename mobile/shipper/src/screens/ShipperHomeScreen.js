// ============================================================
// CRABOR Shipper — Home Screen
// Nhận đơn đồ ăn + cuốc xe realtime qua socket
// ============================================================
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, RefreshControl, Vibration,
  Switch, Modal, Linking, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { ShipperAPI, api, BASE_URL } from '../../shared/api';
import { Storage, KEYS } from '../../shared/storage';
import { socket } from '../../App'; // ✅ SỬA: từ '../../../App' thành '../../App'

const STATUS_STEPS = {
  shipper_accepted: { label: 'Đến lấy hàng', next: 'picking_up', nextLabel: '🛵 Xác nhận đang đến lấy' },
  picking_up:       { label: 'Đang đến quán', next: 'picked_up', nextLabel: '📦 Xác nhận đã lấy hàng' },
  picked_up:        { label: 'Đã lấy hàng',   next: 'delivering', nextLabel: '🚀 Bắt đầu giao' },
  delivering:       { label: 'Đang giao',      next: 'delivered',  nextLabel: '✅ Xác nhận đã giao' },
};

export default function ShipperHomeScreen({ navigation }) {
  const [shipper, setShipper]         = useState(null);
  const [online, setOnline]           = useState(false);
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);
  const [activeOrders, setActiveOrders] = useState([]);

  // Incoming request popup
  const [incomingRequest, setIncomingRequest] = useState(null); // food order hoặc ride
  const [requestTimer, setRequestTimer]       = useState(30);
  const timerRef = useRef(null);
  const requestRef = useRef(null);

  useEffect(() => {
    init();
    return () => clearTimer();
  }, []);

  // Setup socket khi component mount
  useEffect(() => {
    if (!socket) return;
    setupSocket();
    return () => {
      socket.off('order_request');
      socket.off('ride_request');
      socket.off('wallet_credited');
    };
  }, [socket]);

  const init = async () => {
    try {
      const [me, orders] = await Promise.allSettled([
        ShipperAPI.getMe(),
        api.get('/api/shipper/active-orders'),
      ]);
      if (me.status === 'fulfilled') {
        const s = me.value?.shipper || me.value;
        setShipper(s);
        setOnline(s?.online || false);
      }
      if (orders.status === 'fulfilled') {
        setActiveOrders(orders.value?.orders || []);
      }
    } catch (e) {}
    finally { setLoading(false); }
  };

  const setupSocket = () => {
    // Join room shipper riêng
    if (shipper?._id) {
      socket.emit('join_shipper', shipper._id);
      socket.emit('join_shipper_broadcast');
    }

    // Nhận yêu cầu đơn đồ ăn
    socket.on('order_request', (data) => {
      if (!online) return;
      showIncomingRequest({ ...data, type: 'food' });
    });

    // Nhận yêu cầu cuốc xe
    socket.on('ride_request', (data) => {
      if (!online) return;
      showIncomingRequest({ ...data, type: 'ride' });
    });

    // Ví được duyệt
    socket.on('wallet_credited', (data) => {
      Alert.alert('💰 Ví được cộng tiền!', data.message);
    });

    // Cuốc đã có người nhận (khi đang hiện popup)
    socket.on('ride_taken', ({ orderId }) => {
      if (requestRef.current?.orderId === orderId) {
        clearTimer();
        setIncomingRequest(null);
      }
    });
  };

  const showIncomingRequest = (data) => {
    Vibration.vibrate([0, 500, 200, 500, 200, 500]);
    requestRef.current = data;
    setIncomingRequest(data);
    setRequestTimer(data.timeout || 30);
    startTimer(data);
  };

  const startTimer = (data) => {
    clearTimer();
    let t = data.timeout || 30;
    timerRef.current = setInterval(() => {
      t--;
      setRequestTimer(t);
      if (t <= 0) {
        clearTimer();
        setIncomingRequest(null);
        // Auto decline
        if (data.type === 'ride') {
          api.post(`/api/ride/${data.orderId}/decline`).catch(() => {});
        }
      }
    }, 1000);
  };

  const clearTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  const acceptOrder = async (request) => {
    clearTimer();
    setIncomingRequest(null);
    try {
      if (request.type === 'ride') {
        await api.post(`/api/ride/${request.orderId}/accept`);
        Alert.alert('🛵 Đã nhận cuốc!', `Đến đón khách tại:\n${request.fromAddress}`, [
          { text: 'Mở bản đồ', onPress: () => openMaps(request.fromLat, request.fromLng) },
          { text: 'OK' },
        ]);
      } else {
        // Food order
        await api.patch(`/api/orders/${request.orderId}/status`, { status: 'shipper_accepted' });
        Alert.alert('📦 Đã nhận đơn!', `Đến lấy đồ tại:\n${request.order?.pickupAddress}`, [
          { text: 'Mở bản đồ', onPress: () => openMaps(request.order?.pickupLat, request.order?.pickupLng) },
          { text: 'OK' },
        ]);
      }
      // Reload active orders
      const res = await api.get('/api/shipper/active-orders');
      setActiveOrders(res?.orders || []);
    } catch (e) {
      Alert.alert('Lỗi', e.message || 'Không nhận được đơn');
    }
  };

  const declineOrder = async (request) => {
    clearTimer();
    setIncomingRequest(null);
    if (request.type === 'ride') {
      api.post(`/api/ride/${request.orderId}/decline`).catch(() => {});
    }
  };

  const updateOrderStatus = async (order, nextStatus) => {
    try {
      if (nextStatus === 'delivered' && order.module === 'ride') {
        await api.post(`/api/ride/${order.orderId}/complete`);
      } else {
        await api.patch(`/api/orders/${order.orderId}/status`, { status: nextStatus });
      }
      setActiveOrders(prev => prev.map(o =>
        o.orderId === order.orderId ? { ...o, status: nextStatus } : o
      ));
      if (nextStatus === 'delivered') {
        setActiveOrders(prev => prev.filter(o => o.orderId !== order.orderId));
        Alert.alert('✅ Hoàn thành!', 'Thu nhập đang chờ admin duyệt và sẽ sớm vào ví bạn!');
      }
      // Broadcast vị trí khi đang giao
      if (nextStatus === 'delivering' && socket) {
        socket.emit('join_order', order.orderId);
      }
    } catch (e) {
      Alert.alert('Lỗi', e.message);
    }
  };

  const toggleOnline = async (val) => {
    try {
      await api.post(val ? '/api/shipper/online' : '/api/shipper/offline');
      setOnline(val);
      if (val && socket && shipper?._id) {
        socket.emit('join_shipper', shipper._id);
        socket.emit('join_shipper_broadcast');
      }
    } catch (e) {
      Alert.alert('Lỗi', e.message);
    }
  };

  const openMaps = (lat, lng) => {
    if (!lat || !lng) return;
    const url = Platform.OS === 'ios'
      ? `maps://maps.apple.com/?q=${lat},${lng}`
      : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    Linking.openURL(url);
  };

  const getStatusStep = (status) => STATUS_STEPS[status];

  if (loading) return (
    <SafeAreaView style={s.safe}>
      <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} />
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={s.safe}>
      {/* Header */}
      <View style={s.header}>
        <View>
          <Text style={s.headerHi}>Xin chào, {shipper?.fullName || 'Shipper'} 👋</Text>
          <Text style={s.headerSub}>{shipper?.vehiclePlate || 'CRABOR Shipper'}</Text>
        </View>
        <View style={s.onlineRow}>
          <Text style={[s.onlineLabel, { color: online ? Colors.success : Colors.gray4 }]}>
            {online ? '🟢 Online' : '⚫ Offline'}
          </Text>
          <Switch
            value={online}
            onValueChange={toggleOnline}
            trackColor={{ false: Colors.gray3, true: Colors.success }}
            thumbColor="#fff"
          />
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); init().finally(() => setRefreshing(false)); }} tintColor={Colors.primary} />}
      >
        {/* Status banner */}
        {!online && (
          <View style={s.offlineBanner}>
            <Text style={s.offlineBannerText}>⚫ Bạn đang offline — Bật Online để nhận đơn</Text>
          </View>
        )}

        {/* Stats nhanh */}
        <View style={s.statsRow}>
          {[
            { icon: '📦', label: 'Đơn hôm nay', value: shipper?.totalOrders || 0 },
            { icon: '💰', label: 'Ví khả dụng', value: formatCurrency(shipper?.walletBalance || 0) },
            { icon: '⭐', label: 'Đánh giá', value: `${(shipper?.rating || 5).toFixed(1)}/5` },
          ].map((stat, i) => (
            <View key={i} style={s.statCard}>
              <Text style={s.statIcon}>{stat.icon}</Text>
              <Text style={s.statValue}>{stat.value}</Text>
              <Text style={s.statLabel}>{stat.label}</Text>
            </View>
          ))}
        </View>

        {/* Đơn đang xử lý */}
        {activeOrders.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>🔄 Đơn đang xử lý ({activeOrders.length})</Text>
            {activeOrders.map(order => {
              const step = getStatusStep(order.status);
              const isRide = order.module === 'ride';
              return (
                <View key={order.orderId} style={s.orderCard}>
                  <View style={s.orderCardTop}>
                    <View style={[s.moduleBadge, { backgroundColor: isRide ? Colors.info : Colors.primary }]}>
                      <Text style={s.moduleBadgeText}>{isRide ? '🚗 Xe công nghệ' : '🍜 Đồ ăn'}</Text>
                    </View>
                    <Text style={s.orderCardId}>#{order.orderId?.slice(-6)}</Text>
                  </View>

                  {/* Items */}
                  {(order.items || []).map((item, i) => (
                    <Text key={i} style={s.orderItem}>{item.qty}× {item.name}</Text>
                  ))}

                  <View style={s.orderCardMeta}>
                    <Text style={s.orderCardAddr}>📍 {order.address}</Text>
                    {order.partnerAddress && (
                      <Text style={s.orderCardAddr}>🏪 {order.partnerAddress}</Text>
                    )}
                    <Text style={s.orderCardTotal}>💰 {formatCurrency(order.finalTotal || order.total)}</Text>
                  </View>

                  {/* Navigation buttons */}
                  <View style={s.orderActionRow}>
                    <TouchableOpacity
                      style={s.mapBtn}
                      onPress={() => openMaps(
                        isRide ? order.items[0]?.fromLat : order.partnerLat,
                        isRide ? order.items[0]?.fromLng : order.partnerLng,
                      )}
                    >
                      <Text style={s.mapBtnText}>🗺️ Bản đồ</Text>
                    </TouchableOpacity>

                    {/* Nút QR thu tiền — chỉ hiện khi bank_transfer và đang delivering */}
                    {order.paymentMethod === 'bank_transfer' && order.status === 'delivering' && (
                      <TouchableOpacity
                        style={[s.mapBtn, { borderColor: Colors.success }]}
                        onPress={() => navigation.navigate('DeliveryPayment', { order })}
                      >
                        <Text style={[s.mapBtnText, { color: Colors.success }]}>📲 QR thu tiền</Text>
                      </TouchableOpacity>
                    )}

                    {step && (
                      <TouchableOpacity
                        style={s.nextStatusBtn}
                        onPress={() => updateOrderStatus(order, step.next)}
                      >
                        <Text style={s.nextStatusBtnText}>{step.nextLabel}</Text>
                      </TouchableOpacity>
                    )}

                    {order.status === 'delivering' && order.paymentMethod !== 'bank_transfer' && (
                      <TouchableOpacity
                        style={[s.nextStatusBtn, { backgroundColor: Colors.success }]}
                        onPress={() => updateOrderStatus(order, 'delivered')}
                      >
                        <Text style={s.nextStatusBtnText}>✅ Đã giao thành công</Text>
                      </TouchableOpacity>
                    )}

                    {/* bank_transfer: chỉ hoàn thành sau khi đã mở QR screen */}
                    {order.status === 'delivering' && order.paymentMethod === 'bank_transfer' && (
                      <TouchableOpacity
                        style={[s.nextStatusBtn, { backgroundColor: Colors.gray3 }]}
                        onPress={() => Alert.alert('Chưa thu tiền', 'Nhấn "QR thu tiền" để hiện mã QR cho khách thanh toán trước.')}
                      >
                        <Text style={[s.nextStatusBtnText, { color: Colors.gray5 }]}>✅ Đã giao</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {online && activeOrders.length === 0 && (
          <View style={s.waitingWrap}>
            <Text style={{ fontSize: 64 }}>🛵</Text>
            <Text style={s.waitingTitle}>Đang chờ đơn...</Text>
            <Text style={s.waitingSub}>Giữ app mở để nhận đơn nhanh nhất{'\n'}CRABOR sẽ rung khi có đơn mới!</Text>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ══ INCOMING REQUEST POPUP ══ */}
      <Modal visible={!!incomingRequest} transparent animationType="slide">
        {incomingRequest && (
          <View style={s.requestOverlay}>
            <View style={s.requestCard}>
              {/* Timer ring */}
              <View style={[s.timerRing, { borderColor: requestTimer > 10 ? Colors.primary : Colors.danger }]}>
                <Text style={[s.timerText, { color: requestTimer > 10 ? Colors.primary : Colors.danger }]}>
                  {requestTimer}
                </Text>
                <Text style={s.timerSub}>giây</Text>
              </View>

              <Text style={s.requestTitle}>
                {incomingRequest.type === 'ride' ? '🚗 Yêu cầu đặt xe!' : '🍜 Đơn hàng mới!'}
              </Text>

              {incomingRequest.type === 'ride' ? (
                <>
                  <View style={s.requestInfoRow}>
                    <Text style={s.requestInfoIcon}>👤</Text>
                    <Text style={s.requestInfoText}>{incomingRequest.customerName}</Text>
                  </View>
                  <View style={s.requestInfoRow}>
                    <Text style={s.requestInfoIcon}>📍</Text>
                    <Text style={s.requestInfoText} numberOfLines={2}>{incomingRequest.fromAddress}</Text>
                  </View>
                  <View style={s.requestInfoRow}>
                    <Text style={s.requestInfoIcon}>🏁</Text>
                    <Text style={s.requestInfoText} numberOfLines={2}>{incomingRequest.toAddress}</Text>
                  </View>
                  <View style={s.requestEarnRow}>
                    <Text style={s.requestEarnLabel}>Thu nhập dự kiến</Text>
                    <Text style={s.requestEarnValue}>{formatCurrency(Math.round(incomingRequest.fee * 0.9))}</Text>
                  </View>
                </>
              ) : (
                <>
                  <View style={s.requestInfoRow}>
                    <Text style={s.requestInfoIcon}>🏪</Text>
                    <Text style={s.requestInfoText}>{incomingRequest.order?.pickupAddress}</Text>
                  </View>
                  <View style={s.requestInfoRow}>
                    <Text style={s.requestInfoIcon}>📍</Text>
                    <Text style={s.requestInfoText} numberOfLines={2}>{incomingRequest.order?.deliveryAddress}</Text>
                  </View>
                  {(incomingRequest.order?.items || []).slice(0, 3).map((item, i) => (
                    <Text key={i} style={s.requestItem}>{item.qty}× {item.name}</Text>
                  ))}
                  <View style={s.requestEarnRow}>
                    <Text style={s.requestEarnLabel}>Phí ship nhận được</Text>
                    <Text style={s.requestEarnValue}>{formatCurrency(incomingRequest.order?.shipFee || 20000)}</Text>
                  </View>
                </>
              )}

              {incomingRequest.note ? (
                <Text style={s.requestNote}>📝 {incomingRequest.note}</Text>
              ) : null}

              <View style={s.requestBtns}>
                <TouchableOpacity
                  style={s.declineBtn}
                  onPress={() => declineOrder(incomingRequest)}
                >
                  <Text style={s.declineBtnText}>✗ Từ chối</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.acceptBtn}
                  onPress={() => acceptOrder(incomingRequest)}
                >
                  <Text style={s.acceptBtnText}>✓ Nhận ngay</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: {
    backgroundColor: Colors.primary, padding: Spacing.lg,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  headerHi: { color: '#fff', fontWeight: '800', fontSize: 16 },
  headerSub: { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 2 },
  onlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  onlineLabel: { fontSize: 12, fontWeight: '700' },
  offlineBanner: { backgroundColor: Colors.gray5, padding: 10, alignItems: 'center' },
  offlineBannerText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  statsRow: { flexDirection: 'row', padding: Spacing.md, gap: 8 },
  statCard: { flex: 1, backgroundColor: '#fff', borderRadius: Radius.md, padding: 12, alignItems: 'center', ...Shadow.sm },
  statIcon: { fontSize: 22, marginBottom: 4 },
  statValue: { fontSize: 13, fontWeight: '800', color: Colors.primary, textAlign: 'center' },
  statLabel: { fontSize: 10, color: Colors.textSub, textAlign: 'center', marginTop: 2 },
  section: { paddingHorizontal: Spacing.md, paddingTop: 8 },
  sectionTitle: { fontWeight: '800', fontSize: 15, marginBottom: 10, color: Colors.text },
  orderCard: { backgroundColor: '#fff', borderRadius: Radius.lg, padding: 14, marginBottom: 12, ...Shadow.md, borderLeftWidth: 4, borderLeftColor: Colors.primary },
  orderCardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  moduleBadge: { borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  moduleBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  orderCardId: { fontSize: 12, color: Colors.textSub, fontWeight: '600' },
  orderItem: { fontSize: 13, color: Colors.text, marginBottom: 2 },
  orderCardMeta: { backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 10, marginTop: 8, gap: 4 },
  orderCardAddr: { fontSize: 12, color: Colors.text },
  orderCardTotal: { fontSize: 14, fontWeight: '800', color: Colors.primary, marginTop: 4 },
  orderActionRow: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  mapBtn: { borderWidth: 1.5, borderColor: Colors.info, borderRadius: Radius.md, paddingVertical: 10, paddingHorizontal: 16 },
  mapBtnText: { color: Colors.info, fontWeight: '700', fontSize: 13 },
  nextStatusBtn: { flex: 1, backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 10, alignItems: 'center' },
  nextStatusBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  waitingWrap: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 32 },
  waitingTitle: { fontSize: 20, fontWeight: '900', color: Colors.text, marginTop: 16 },
  waitingSub: { fontSize: 13, color: Colors.textSub, textAlign: 'center', marginTop: 8, lineHeight: 22 },
  // Incoming request modal
  requestOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
  requestCard: { backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 36, alignItems: 'center' },
  timerRing: { width: 72, height: 72, borderRadius: 36, borderWidth: 4, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  timerText: { fontSize: 26, fontWeight: '900' },
  timerSub: { fontSize: 10, color: Colors.textSub, marginTop: -4 },
  requestTitle: { fontSize: 22, fontWeight: '900', color: Colors.text, marginBottom: 16 },
  requestInfoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, width: '100%', marginBottom: 8 },
  requestInfoIcon: { fontSize: 16, width: 24 },
  requestInfoText: { flex: 1, fontSize: 14, color: Colors.text, lineHeight: 20 },
  requestItem: { fontSize: 13, color: Colors.textSub, alignSelf: 'flex-start', marginBottom: 2 },
  requestEarnRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', backgroundColor: '#FFF5F4', borderRadius: Radius.md, padding: 12, marginTop: 8, marginBottom: 8 },
  requestEarnLabel: { fontSize: 13, color: Colors.textSub, fontWeight: '600' },
  requestEarnValue: { fontSize: 18, fontWeight: '900', color: Colors.primary },
  requestNote: { fontSize: 12, color: Colors.gray5, alignSelf: 'flex-start', marginBottom: 8 },
  requestBtns: { flexDirection: 'row', gap: 12, width: '100%', marginTop: 8 },
  declineBtn: { flex: 1, borderWidth: 2, borderColor: Colors.danger, borderRadius: Radius.lg, paddingVertical: 16, alignItems: 'center' },
  declineBtnText: { color: Colors.danger, fontWeight: '800', fontSize: 16 },
  acceptBtn: { flex: 2, backgroundColor: Colors.primary, borderRadius: Radius.lg, paddingVertical: 16, alignItems: 'center', ...Shadow.md },
  acceptBtnText: { color: '#fff', fontWeight: '900', fontSize: 16 },
});