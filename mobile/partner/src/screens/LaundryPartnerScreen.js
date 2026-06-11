// ============================================================
// CRABOR Partner — Laundry Screen
// Quản lý đơn giặt + countdown + cài gói dịch vụ
// ============================================================
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, RefreshControl, Modal, TextInput,
  Switch, FlatList, Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { api } from '../../shared/api';
import { getSocket } from '../../shared/socket';

const TURNAROUND_OPTIONS = ['5h', '10h', '24h'];

const STATUS_LABEL = {
  pending:              '⏳ Chờ xác nhận',
  partner_accepted:     '✅ Đã nhận',
  shipper_picking:      '🛵 Shipper đang lấy đồ',
  picked_up_by_shipper: '📦 Shipper đã lấy',
  at_partner:           '🏠 Đồ đến cửa hàng',
  washing:              '🫧 Đang giặt',
  countdown:            '⏳ Đang giặt (countdown)',
  ready_return:         '✅ Sẵn sàng trả',
  shipper_returning:    '🛵 Đang trả đồ',
  delivered:            '🎉 Hoàn thành',
  cancelled:            '❌ Đã huỷ',
};

const STATUS_COLOR = {
  pending: Colors.warning, partner_accepted: Colors.info,
  at_partner: Colors.info, washing: Colors.primary, countdown: Colors.primary,
  ready_return: Colors.success, delivered: Colors.success, cancelled: Colors.danger,
};

const NEXT_ACTION = {
  pending:              { label: '✅ Nhận đơn', next: 'partner_accepted' },
  at_partner:           { label: '🫧 Bắt đầu giặt', next: 'countdown' },
  countdown:            { label: '✅ Đã giặt xong', next: 'ready_return' },
  washing:              { label: '✅ Đã giặt xong', next: 'ready_return' },
};

export default function LaundryPartnerScreen({ navigation }) {
  const [orders, setOrders]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab]               = useState('orders'); // 'orders' | 'packages' | 'stats'
  const [isAccepting, setIsAccepting] = useState(true);
  const [processing, setProcessing] = useState({});

  // Countdown state — mỗi đơn có countdown riêng
  const [countdowns, setCountdowns] = useState({}); // { orderId: secondsLeft }
  const countdownRef = useRef({});

  // Packages state
  const [packages, setPackages]     = useState([]);
  const [pkgModal, setPkgModal]     = useState(false);
  const [editPkg, setEditPkg]       = useState(null);
  const [pkgForm, setPkgForm]       = useState({ id:'', name:'', description:'', pricePerKg:'', minKg:'2', turnaround:'10h', available:true });
  const [savingPkg, setSavingPkg]   = useState(false);

  // Stats
  const [stats, setStats]           = useState(null);

  useEffect(() => {
    init();
    setupSocket();
    return () => clearAllCountdowns();
  }, []);

  const init = async () => {
    await Promise.all([loadOrders(), loadPartnerInfo()]);
    setLoading(false);
  };

  const setupSocket = () => {
    const socket = getSocket();
    if (!socket) return;
    socket.on('new_laundry_order', (data) => {
      Vibration.vibrate([0, 400, 200, 400]);
      Alert.alert('🧺 Đơn giặt mới!',
        `${data.order?.customerName} — ${data.order?.packageName}\n${data.order?.estimatedKg}kg · ${data.order?.turnaround}`,
        [{ text: 'Xem ngay', onPress: loadOrders }, { text: 'OK' }]
      );
      setOrders(prev => [{ ...data.order, _incoming: true }, ...prev]);
    });
    socket.on('laundry_order_arrived', (data) => {
      Vibration.vibrate([0, 300, 100, 300]);
      Alert.alert('📦 Đồ đã đến!', `Đơn ${data.orderId?.slice(-6)} — ${data.packageName}\nDeadline: ${new Date(data.deadline).toLocaleString('vi-VN')}`);
      loadOrders();
    });
  };

  const clearAllCountdowns = () => {
    Object.values(countdownRef.current).forEach(clearInterval);
    countdownRef.current = {};
  };

  const loadOrders = async () => {
    try {
      const res = await api.get('/api/laundry/partner/orders');
      const list = res.orders || [];
      setOrders(list);
      // Khởi động countdown cho đơn đang ở trạng thái countdown/washing
      list.forEach(o => {
        if ((o.status === 'countdown' || o.status === 'washing') && o.deadline) {
          startCountdown(o.orderId, new Date(o.deadline));
        }
      });
    } catch (e) {}
    finally { setRefreshing(false); }
  };

  const loadPartnerInfo = async () => {
    try {
      const res = await api.get('/api/laundry/partner/me');
      const p = res.partner;
      if (p) {
        setIsAccepting(p.isAccepting !== false);
        setPackages(p.packages || []);
        setStats({
          totalOrders: p.totalOrders || 0,
          walletBalance: p.walletBalance || 0,
          totalSales: p.totalSales || 0,
        });
      }
    } catch (_) {}
  };

  const startCountdown = (orderId, deadline) => {
    if (countdownRef.current[orderId]) clearInterval(countdownRef.current[orderId]);
    const tick = () => {
      const secs = Math.max(0, Math.floor((new Date(deadline) - new Date()) / 1000));
      setCountdowns(prev => ({ ...prev, [orderId]: secs }));
      if (secs <= 0) clearInterval(countdownRef.current[orderId]);
    };
    tick();
    countdownRef.current[orderId] = setInterval(tick, 1000);
  };

  const formatCountdown = (secs) => {
    if (secs === undefined || secs === null) return null;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const overdue = secs <= 0;
    if (overdue) return { text: 'QUÁ HẠN!', overdue: true };
    return { text: `${h > 0 ? h + 'h ' : ''}${m}m ${String(s).padStart(2,'0')}s`, overdue: false };
  };

  const handleAction = async (order, nextStatus) => {
    // Nếu là ready_return → cân đồ thực tế
    if (nextStatus === 'ready_return') {
      Alert.prompt('Cân đồ thực tế', 'Nhập số kg thực tế:', async (kgStr) => {
        const finalKg = parseFloat(kgStr);
        if (!finalKg || isNaN(finalKg)) return Alert.alert('Lỗi', 'Nhập số kg hợp lệ');
        await updateStatus(order, nextStatus, finalKg);
      }, 'plain-text', String(order.estimatedKg || 2), 'numeric');
    } else {
      await updateStatus(order, nextStatus);
    }
  };

  const updateStatus = async (order, status, finalKg) => {
    setProcessing(p => ({ ...p, [order.orderId]: true }));
    try {
      await api.patch(`/api/laundry/orders/${order.orderId}/status`, { status, finalKg });
      setOrders(prev => prev.map(o => o.orderId === order.orderId ? { ...o, status } : o));
      if (status === 'countdown' || status === 'washing') {
        startCountdown(order.orderId, new Date(order.deadline));
      }
      if (status === 'ready_return') {
        Alert.alert('✅ Sắp xong!', 'Đang tìm shipper đến lấy đồ về cho khách...');
      }
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setProcessing(p => ({ ...p, [order.orderId]: false })); }
  };

  const rejectOrder = (order) => {
    Alert.alert('Từ chối đơn?', 'Đơn sẽ bị huỷ và khách được thông báo.', [
      { text: 'Huỷ', style: 'cancel' },
      { text: 'Từ chối', style: 'destructive', onPress: async () => {
        try {
          await api.patch(`/api/laundry/orders/${order.orderId}/status`, { status: 'cancelled' });
          setOrders(prev => prev.map(o => o.orderId === order.orderId ? { ...o, status: 'cancelled' } : o));
        } catch (e) { Alert.alert('Lỗi', e.message); }
      }}
    ]);
  };

  const toggleAccepting = async (val) => {
    try {
      await api.patch('/api/laundry/partner/accepting', { accepting: val });
      setIsAccepting(val);
    } catch (e) { Alert.alert('Lỗi', e.message); }
  };

  // ── Packages ───────────────────────────────────────────────
  const openAddPackage = () => {
    setEditPkg(null);
    setPkgForm({ id: `pkg_${Date.now()}`, name:'', description:'', pricePerKg:'', minKg:'2', turnaround:'10h', available:true });
    setPkgModal(true);
  };

  const openEditPackage = (pkg) => {
    setEditPkg(pkg);
    setPkgForm({ ...pkg, pricePerKg: String(pkg.pricePerKg), minKg: String(pkg.minKg) });
    setPkgModal(true);
  };

  const savePackage = async () => {
    if (!pkgForm.name.trim() || !pkgForm.pricePerKg || isNaN(pkgForm.pricePerKg))
      return Alert.alert('Lỗi', 'Nhập tên và giá/kg hợp lệ');
    setSavingPkg(true);
    try {
      const payload = { ...pkgForm, pricePerKg: Number(pkgForm.pricePerKg), minKg: Number(pkgForm.minKg) };
      let newPkgs;
      if (editPkg) {
        newPkgs = packages.map(p => p.id === editPkg.id ? payload : p);
      } else {
        newPkgs = [...packages, payload];
      }
      await api.patch('/api/laundry/partner/packages', { packages: newPkgs });
      setPackages(newPkgs);
      setPkgModal(false);
      Alert.alert('✅ Đã lưu gói dịch vụ');
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setSavingPkg(false); }
  };

  const deletePackage = (pkg) => {
    Alert.alert('Xoá gói?', `Xoá gói "${pkg.name}"?`, [
      { text: 'Huỷ', style: 'cancel' },
      { text: 'Xoá', style: 'destructive', onPress: async () => {
        const newPkgs = packages.filter(p => p.id !== pkg.id);
        try {
          await api.patch('/api/laundry/partner/packages', { packages: newPkgs });
          setPackages(newPkgs);
        } catch (e) { Alert.alert('Lỗi', e.message); }
      }}
    ]);
  };

  const activeOrders   = orders.filter(o => !['delivered','cancelled'].includes(o.status));
  const finishedOrders = orders.filter(o => ['delivered','cancelled'].includes(o.status));

  if (loading) return (
    <SafeAreaView style={s.safe}>
      <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} />
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={s.safe}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={s.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>🧺 Quản lý Giặt là</Text>
        <View style={s.onlineRow}>
          <Text style={{ fontSize: 10, color: isAccepting ? Colors.success : Colors.gray4, fontWeight: '700' }}>
            {isAccepting ? '🟢' : '⚫'}
          </Text>
          <Switch value={isAccepting} onValueChange={toggleAccepting}
            trackColor={{ false: Colors.gray3, true: Colors.success }} thumbColor="#fff"
            style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }} />
        </View>
      </View>

      {/* Tabs */}
      <View style={s.tabRow}>
        {[['orders','📦 Đơn hàng'], ['packages','📋 Gói dịch vụ'], ['stats','📊 Thống kê']].map(([t, label]) => (
          <TouchableOpacity key={t} style={[s.tabBtn, tab === t && s.tabBtnActive]}
            onPress={() => setTab(t)}>
            <Text style={[s.tabBtnText, tab === t && s.tabBtnTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── TAB: ORDERS ── */}
      {tab === 'orders' && (
        <FlatList
          data={[...activeOrders, ...finishedOrders]}
          keyExtractor={o => o._id || o.orderId}
          contentContainerStyle={{ padding: Spacing.md }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadOrders(); }} tintColor={Colors.primary} />}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <Text style={{ fontSize: 48 }}>🧺</Text>
              <Text style={{ color: Colors.gray4, marginTop: 12 }}>Chưa có đơn nào</Text>
            </View>
          }
          renderItem={({ item: order }) => {
            const action    = NEXT_ACTION[order.status];
            const isActive  = !['delivered','cancelled'].includes(order.status);
            const cdSecs    = countdowns[order.orderId];
            const cd        = (order.status === 'countdown' || order.status === 'washing') ? formatCountdown(cdSecs) : null;

            return (
              <View style={[s.orderCard, order._incoming && s.orderCardNew, !isActive && { opacity: 0.7 }]}>
                {order._incoming && <View style={s.newBanner}><Text style={s.newBannerText}>🆕 ĐƠN MỚI!</Text></View>}

                {/* Header row */}
                <View style={s.orderTop}>
                  <View>
                    <Text style={s.orderId}>#{order.orderId?.slice(-6)}</Text>
                    <Text style={s.orderTime}>{new Date(order.createdAt).toLocaleString('vi-VN')}</Text>
                  </View>
                  <View style={[s.statusPill, { backgroundColor: STATUS_COLOR[order.status] || Colors.gray3 }]}>
                    <Text style={s.statusPillText}>{STATUS_LABEL[order.status] || order.status}</Text>
                  </View>
                </View>

                {/* Info */}
                <View style={s.infoSection}>
                  <Text style={s.infoRow}>👤 {order.customerName}</Text>
                  <Text style={s.infoRow}>📍 {order.pickupAddress}</Text>
                  <Text style={s.infoRow}>👕 {order.packageName}</Text>
                  <Text style={s.infoRow}>⚖️ ~{order.estimatedKg}kg · ⏱ {order.turnaround}</Text>
                  <Text style={s.infoRow}>💰 ~{formatCurrency(order.estimatedTotal)}</Text>
                  {order.deadline && (
                    <Text style={[s.infoRow, { color: Colors.warning }]}>
                      ⏰ Deadline: {new Date(order.deadline).toLocaleString('vi-VN')}
                    </Text>
                  )}
                </View>

                {/* Countdown */}
                {cd && (
                  <View style={[s.countdownBox, cd.overdue && s.countdownOverdue]}>
                    <Text style={s.countdownLabel}>⏳ Còn lại</Text>
                    <Text style={[s.countdownText, cd.overdue && { color: Colors.danger }]}>{cd.text}</Text>
                  </View>
                )}

                {/* Actions */}
                {isActive && (
                  <View style={s.actionRow}>
                    {order.status === 'pending' && (
                      <TouchableOpacity style={s.rejectBtn} onPress={() => rejectOrder(order)}>
                        <Text style={s.rejectBtnText}>✗ Từ chối</Text>
                      </TouchableOpacity>
                    )}
                    {action && (
                      <TouchableOpacity
                        style={[s.acceptBtn, processing[order.orderId] && { opacity: 0.6 }]}
                        onPress={() => handleAction(order, action.next)}
                        disabled={processing[order.orderId]}
                      >
                        {processing[order.orderId]
                          ? <ActivityIndicator color="#fff" size="small" />
                          : <Text style={s.acceptBtnText}>{action.label}</Text>
                        }
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            );
          }}
        />
      )}

      {/* ── TAB: PACKAGES ── */}
      {tab === 'packages' && (
        <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 40 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={{ fontWeight: '800', fontSize: 15 }}>Gói dịch vụ của bạn</Text>
            <TouchableOpacity style={s.addPkgBtn} onPress={openAddPackage}>
              <Text style={s.addPkgBtnText}>+ Thêm gói</Text>
            </TouchableOpacity>
          </View>

          <View style={s.infoCard}>
            <Text style={s.infoCardText}>💡 Đặt giá cạnh tranh để thu hút khách hàng. CRABOR giữ lại <Text style={{ fontWeight: '900', color: Colors.primary }}>18%</Text>/đơn. Bạn nhận <Text style={{ fontWeight: '900', color: Colors.success }}>82%</Text> tiền giặt.</Text>
          </View>

          {packages.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <Text style={{ fontSize: 40 }}>📋</Text>
              <Text style={{ color: Colors.gray4, marginTop: 12, textAlign: 'center' }}>
                Chưa có gói dịch vụ{'\n'}Thêm gói để khách hàng đặt lịch
              </Text>
            </View>
          ) : (
            packages.map(pkg => (
              <View key={pkg.id} style={[s.pkgCard, !pkg.available && { opacity: 0.5 }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.pkgName}>{pkg.name}</Text>
                    {pkg.description ? <Text style={s.pkgDesc}>{pkg.description}</Text> : null}
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                      <Text style={s.pkgTag}>{formatCurrency(pkg.pricePerKg)}/kg</Text>
                      <Text style={s.pkgTag}>Tối thiểu {pkg.minKg}kg</Text>
                      <Text style={s.pkgTag}>⏱ {pkg.turnaround}</Text>
                      <Text style={[s.pkgTag, { color: pkg.available ? Colors.success : Colors.danger }]}>
                        {pkg.available ? '● Đang bán' : '● Tạm nghỉ'}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 11, color: Colors.textSub, marginTop: 4 }}>
                      Bạn nhận: {formatCurrency(Math.round(pkg.pricePerKg * 0.82))}/kg sau phí CRABOR
                    </Text>
                  </View>
                  <View style={{ gap: 6 }}>
                    <TouchableOpacity style={s.editBtn} onPress={() => openEditPackage(pkg)}>
                      <Text>✏️</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.delBtn} onPress={() => deletePackage(pkg)}>
                      <Text>🗑️</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}

      {/* ── TAB: STATS ── */}
      {tab === 'stats' && (
        <ScrollView contentContainerStyle={{ padding: Spacing.md }}>
          {[
            { icon: '📦', label: 'Tổng đơn', value: stats?.totalOrders || 0 },
            { icon: '✅', label: 'Đơn hoàn thành', value: orders.filter(o => o.status === 'delivered').length },
            { icon: '💰', label: 'Ví khả dụng', value: formatCurrency(stats?.walletBalance || 0) },
            { icon: '📈', label: 'Tổng doanh thu', value: formatCurrency(stats?.totalSales || 0) },
          ].map((stat, i) => (
            <View key={i} style={s.statRow}>
              <Text style={{ fontSize: 24 }}>{stat.icon}</Text>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={{ fontSize: 13, color: Colors.textSub }}>{stat.label}</Text>
                <Text style={{ fontSize: 18, fontWeight: '900', color: Colors.primary }}>{stat.value}</Text>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Package Modal */}
      <Modal visible={pkgModal} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>{editPkg ? '✏️ Sửa gói' : '➕ Thêm gói dịch vụ'}</Text>
            <ScrollView>
              {[
                { key: 'name',        label: 'Tên gói *',       ph: 'VD: Giặt + Sấy nhanh 5h' },
                { key: 'description', label: 'Mô tả',           ph: 'Mô tả ngắn về gói...' },
                { key: 'pricePerKg',  label: 'Giá/kg (đ) *',    ph: 'VD: 30000', keyType: 'numeric' },
                { key: 'minKg',       label: 'Kg tối thiểu',    ph: '2', keyType: 'numeric' },
              ].map(f => (
                <View key={f.key} style={{ marginBottom: 10 }}>
                  <Text style={s.fieldLabel}>{f.label}</Text>
                  <TextInput
                    style={s.fieldInput}
                    placeholder={f.ph}
                    keyboardType={f.keyType || 'default'}
                    value={pkgForm[f.key]}
                    onChangeText={v => setPkgForm(p => ({ ...p, [f.key]: v }))}
                  />
                </View>
              ))}
              <Text style={s.fieldLabel}>Thời gian hoàn thành *</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                {TURNAROUND_OPTIONS.map(t => (
                  <TouchableOpacity key={t}
                    style={[s.timeChip, pkgForm.turnaround === t && s.timeChipActive]}
                    onPress={() => setPkgForm(p => ({ ...p, turnaround: t }))}
                  >
                    <Text style={[{ fontSize: 13, fontWeight: '700', color: Colors.gray5 }, pkgForm.turnaround === t && { color: '#fff' }]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <Text style={s.fieldLabel}>Đang bán</Text>
                <Switch value={pkgForm.available} onValueChange={v => setPkgForm(p => ({ ...p, available: v }))}
                  trackColor={{ false: Colors.gray3, true: Colors.success }} thumbColor="#fff" />
              </View>
              {pkgForm.pricePerKg && !isNaN(pkgForm.pricePerKg) && (
                <View style={s.earningPreview}>
                  <Text style={{ fontSize: 13, color: Colors.textSub }}>💡 Bạn nhận sau phí 18%:</Text>
                  <Text style={{ fontWeight: '900', color: Colors.success, fontSize: 15 }}>
                    {formatCurrency(Math.round(Number(pkgForm.pricePerKg) * 0.82))}/kg
                  </Text>
                </View>
              )}
              <TouchableOpacity style={[s.saveBtn, savingPkg && { opacity: 0.6 }]} onPress={savePackage} disabled={savingPkg}>
                {savingPkg ? <ActivityIndicator color="#fff" /> : <Text style={s.saveBtnText}>{editPkg ? 'Lưu thay đổi' : 'Thêm gói'}</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={s.cancelBtn} onPress={() => setPkgModal(false)}>
                <Text style={s.cancelBtnText}>Huỷ</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.md },
  backBtn: { color: '#fff', fontSize: 24, fontWeight: '700' },
  headerTitle: { color: '#fff', fontWeight: '800', fontSize: 16 },
  onlineRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tabRow: { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: Colors.border },
  tabBtn: { flex: 1, paddingVertical: 11, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabBtnActive: { borderBottomColor: Colors.primary },
  tabBtnText: { fontSize: 11, fontWeight: '700', color: Colors.gray4 },
  tabBtnTextActive: { color: Colors.primary },
  orderCard: { backgroundColor: '#fff', borderRadius: Radius.lg, padding: 14, marginBottom: 12, ...Shadow.md },
  orderCardNew: { borderWidth: 2, borderColor: Colors.primary },
  newBanner: { backgroundColor: Colors.primary, borderRadius: Radius.sm, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start', marginBottom: 8 },
  newBannerText: { color: '#fff', fontWeight: '800', fontSize: 11 },
  orderTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  orderId: { fontWeight: '800', fontSize: 15 },
  orderTime: { fontSize: 11, color: Colors.textSub, marginTop: 2 },
  statusPill: { borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  statusPillText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  infoSection: { backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 10, gap: 4, marginBottom: 10 },
  infoRow: { fontSize: 12, color: Colors.text },
  countdownBox: { backgroundColor: Colors.cream, borderRadius: Radius.md, padding: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, borderWidth: 1.5, borderColor: Colors.primary },
  countdownOverdue: { backgroundColor: '#FFF0F0', borderColor: Colors.danger },
  countdownLabel: { fontSize: 12, fontWeight: '700', color: Colors.gray5 },
  countdownText: { fontSize: 20, fontWeight: '900', color: Colors.primary, fontVariant: ['tabular-nums'] },
  actionRow: { flexDirection: 'row', gap: 8 },
  rejectBtn: { flex: 1, borderWidth: 1.5, borderColor: Colors.danger, borderRadius: Radius.md, paddingVertical: 11, alignItems: 'center' },
  rejectBtnText: { color: Colors.danger, fontWeight: '800' },
  acceptBtn: { flex: 2, backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 11, alignItems: 'center' },
  acceptBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  addPkgBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 8, paddingHorizontal: 14 },
  addPkgBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  infoCard: { backgroundColor: Colors.cream, borderRadius: Radius.md, padding: 12, marginBottom: 16, borderLeftWidth: 3, borderLeftColor: Colors.primary },
  infoCardText: { fontSize: 13, color: Colors.text, lineHeight: 20 },
  pkgCard: { backgroundColor: '#fff', borderRadius: Radius.md, padding: 14, marginBottom: 10, ...Shadow.sm },
  pkgName: { fontWeight: '800', fontSize: 14 },
  pkgDesc: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
  pkgTag: { fontSize: 11, backgroundColor: Colors.gray1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, color: Colors.gray5 },
  editBtn: { width: 34, height: 34, borderRadius: 8, backgroundColor: Colors.gray1, alignItems: 'center', justifyContent: 'center' },
  delBtn: { width: 34, height: 34, borderRadius: 8, backgroundColor: '#FFF0F0', alignItems: 'center', justifyContent: 'center' },
  statRow: { backgroundColor: '#fff', borderRadius: Radius.md, padding: 16, marginBottom: 10, flexDirection: 'row', alignItems: 'center', ...Shadow.sm },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '85%' },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: 16 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: Colors.gray5, marginBottom: 4 },
  fieldInput: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  timeChip: { flex: 1, paddingVertical: 10, borderRadius: Radius.md, borderWidth: 1.5, borderColor: Colors.border, alignItems: 'center' },
  timeChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  earningPreview: { backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 12, marginBottom: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  saveBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12 },
  cancelBtnText: { color: Colors.gray4 },
});
