// ============================================================
// Partner Orders Screen — Quản lý đơn hàng realtime
// ============================================================
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, Vibration, ActivityIndicator,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Colors, Spacing, Radius, Shadow, formatCurrency, formatDateTime, ORDER_STATUS } from '../../shared/theme';
import { PartnerAPI } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { getSocket } from '../../shared/socket';

const TABS = ['new', 'active', 'done'];
const TAB_LABELS = { new: '🆕 Mới', active: '🔄 Đang xử lý', done: '✅ Hoàn thành' };

function GuestView() {
  const navigation = useNavigation();
  return (
    <View style={s.guestWrap}>
      <Text style={{ fontSize: 64 }}>🔐</Text>
      <Text style={s.guestTitle}>Chưa đăng nhập</Text>
      <Text style={s.guestSub}>Đăng nhập để quản lý đơn hàng của bạn</Text>
      <TouchableOpacity style={s.loginBtn} onPress={() => navigation.navigate('Login')}>
        <Text style={s.loginBtnText}>Đăng nhập ngay</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function OrdersScreen() {
  const { isLoggedIn } = useAuth();
  const [orders, setOrders]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab]           = useState('new');
  const [processing, setProcessing] = useState({});

  useEffect(() => {
    if (!isLoggedIn) { setLoading(false); return; }
    loadOrders();
    setupSocket();
  }, [isLoggedIn]);

  const setupSocket = () => {
    const socket = getSocket(); if (!socket) return;
    const _sock = getSocket(); if(!_sock) return;
    _sock.on('new_order', (order) => {
      Vibration.vibrate([0, 500, 200, 500]);
      setOrders(prev => [{ ...order, _incoming: true }, ...prev]);
    });
    _sock.on('order_status_update', ({ orderId, status }) => {
      setOrders(prev => prev.map(o => o._id === orderId ? { ...o, status } : o));
    });
  };

  const loadOrders = async () => {
    try {
      const res = await PartnerAPI.getOrders();
      setOrders(res.orders || res || []);
    } catch (e) {}
    finally { setLoading(false); setRefreshing(false); }
  };

  const handleAccept = async (order) => {
    setProcessing(p => ({ ...p, [order._id]: true }));
    try {
      await PartnerAPI.acceptOrder(order._id);
      setOrders(prev => prev.map(o => o._id === order._id ? { ...o, status: 'confirmed', _incoming: false } : o));
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setProcessing(p => ({ ...p, [order._id]: false })); }
  };

  const handleReject = (order) => {
    Alert.alert('Từ chối đơn?', 'Đơn sẽ bị huỷ và khách được hoàn tiền.', [
      { text: 'Huỷ', style: 'cancel' },
      {
        text: 'Từ chối', style: 'destructive', onPress: async () => {
          setProcessing(p => ({ ...p, [order._id]: true }));
          try {
            await PartnerAPI.rejectOrder(order._id);
            setOrders(prev => prev.map(o => o._id === order._id ? { ...o, status: 'cancelled' } : o));
          } catch (e) { Alert.alert('Lỗi', e.message); }
          finally { setProcessing(p => ({ ...p, [order._id]: false })); }
        }
      }
    ]);
  };

  const filteredOrders = orders.filter(o => {
    if (tab === 'new')    return o.status === 'pending' || o._incoming;
    if (tab === 'active') return ['confirmed', 'preparing', 'ready', 'picking_up', 'delivering'].includes(o.status);
    if (tab === 'done')   return ['delivered', 'cancelled'].includes(o.status);
    return true;
  });

  const getStatusColor = (s) => ORDER_STATUS[s]?.color || Colors.primary;
  const getStatusLabel = (s) => ORDER_STATUS[s]?.label || s;

  const renderOrder = ({ item: o }) => (
    <View style={[s.orderCard, o._incoming && s.orderCardNew]}>
      {o._incoming && (
        <View style={s.newBanner}><Text style={s.newBannerText}>🆕 ĐƠN MỚI!</Text></View>
      )}
      <View style={s.orderTop}>
        <View style={{ flex: 1 }}>
          <Text style={s.orderId}>#{o._id?.slice(-6)}</Text>
          <Text style={s.orderTime}>{formatDateTime(o.createdAt)}</Text>
        </View>
        <View style={[s.statusPill, { backgroundColor: getStatusColor(o.status) }]}>
          <Text style={s.statusPillText}>{getStatusLabel(o.status)}</Text>
        </View>
      </View>
      <View style={s.itemsSection}>
        {(o.items || []).map((item, i) => (
          <View key={i} style={s.itemRow}>
            <Text style={s.itemQty}>{item.quantity}x</Text>
            <Text style={s.itemName}>{item.name}</Text>
            <Text style={s.itemPrice}>{formatCurrency(item.price)}</Text>
          </View>
        ))}
      </View>
      <View style={s.orderFooter}>
        <View>
          {o.note ? <Text style={s.orderNote}>📝 {o.note}</Text> : null}
          <Text style={s.orderCustomer}>👤 {o.customerName || 'Khách hàng'}</Text>
          <Text style={s.orderTotal}>💰 Tổng: {formatCurrency(o.total)}</Text>
        </View>
        {(o.status === 'pending' || o._incoming) && (
          <View style={s.actionBtns}>
            <TouchableOpacity style={s.rejectBtn} onPress={() => handleReject(o)} disabled={processing[o._id]}>
              <Text style={s.rejectBtnText}>✗</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.acceptBtn} onPress={() => handleAccept(o)} disabled={processing[o._id]}>
              {processing[o._id]
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={s.acceptBtnText}>✓ Nhận</Text>
              }
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );

  if (!isLoggedIn) return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}><Text style={s.headerTitle}>📦 Đơn hàng</Text></View>
      <GuestView />
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Text style={s.headerTitle}>📦 Đơn hàng</Text>
        <TouchableOpacity onPress={() => { setRefreshing(true); loadOrders(); }}>
          <Text style={s.refreshIcon}>🔄</Text>
        </TouchableOpacity>
      </View>
      <View style={s.tabBar}>
        {TABS.map(t => (
          <TouchableOpacity key={t} style={[s.tabBtn, tab === t && s.tabBtnActive]} onPress={() => setTab(t)}>
            <Text style={[s.tabBtnText, tab === t && s.tabBtnTextActive]}>{TAB_LABELS[t]}</Text>
            {t === 'new' && orders.filter(o => o.status === 'pending' || o._incoming).length > 0 && (
              <View style={s.badge}>
                <Text style={s.badgeText}>{orders.filter(o => o.status === 'pending' || o._incoming).length}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>
      {loading ? (
        <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} />
      ) : (
        <FlatList
          data={filteredOrders}
          keyExtractor={item => item._id}
          renderItem={renderOrder}
          contentContainerStyle={{ padding: Spacing.lg }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadOrders(); }} tintColor={Colors.primary} />}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={{ fontSize: 48 }}>📭</Text>
              <Text style={s.emptyText}>Chưa có đơn hàng nào</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.lg },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#fff' },
  refreshIcon: { fontSize: 20 },
  tabBar: { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: Colors.border },
  tabBtn: { flex: 1, paddingVertical: 12, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 4 },
  tabBtnActive: { borderBottomWidth: 2.5, borderBottomColor: Colors.primary },
  tabBtnText: { fontSize: 12, fontWeight: '700', color: Colors.gray4 },
  tabBtnTextActive: { color: Colors.primary },
  badge: { backgroundColor: Colors.danger, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  orderCard: { backgroundColor: '#fff', borderRadius: Radius.lg, padding: 14, marginBottom: 12, ...Shadow.md },
  orderCardNew: { borderWidth: 2, borderColor: Colors.primary },
  newBanner: { backgroundColor: Colors.primary, borderRadius: Radius.sm, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start', marginBottom: 8 },
  newBannerText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  orderTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  orderId: { fontWeight: '800', fontSize: 15, color: Colors.text },
  orderTime: { fontSize: 11, color: Colors.textSub, marginTop: 2 },
  statusPill: { borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  statusPillText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  itemsSection: { backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 10, marginBottom: 10 },
  itemRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  itemQty: { fontWeight: '800', color: Colors.primary, fontSize: 13, width: 28 },
  itemName: { flex: 1, fontSize: 13, color: Colors.text },
  itemPrice: { fontWeight: '700', fontSize: 13, color: Colors.text },
  orderFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  orderNote: { fontSize: 12, color: Colors.textSub, marginBottom: 2 },
  orderCustomer: { fontSize: 12, color: Colors.textSub, marginBottom: 2 },
  orderTotal: { fontSize: 14, fontWeight: '800', color: Colors.primary },
  actionBtns: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  rejectBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.gray1, borderWidth: 1.5, borderColor: Colors.danger, alignItems: 'center', justifyContent: 'center' },
  rejectBtnText: { color: Colors.danger, fontWeight: '800', fontSize: 18 },
  acceptBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 12, paddingHorizontal: 18, alignItems: 'center' },
  acceptBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  empty: { alignItems: 'center', paddingVertical: 60 },
  emptyText: { fontSize: 16, fontWeight: '700', color: Colors.gray4, marginTop: 12 },
  guestWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  guestTitle: { fontSize: 20, fontWeight: '800', color: Colors.text, marginTop: 16 },
  guestSub: { fontSize: 14, color: Colors.textSub, textAlign: 'center', marginTop: 8, lineHeight: 22 },
  loginBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, paddingHorizontal: 40, marginTop: 24 },
  loginBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
