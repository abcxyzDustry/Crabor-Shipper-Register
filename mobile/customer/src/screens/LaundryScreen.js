// ============================================================
// CRABOR — Laundry Customer Screen (Full workflow)
// Chọn gói → Chọn thời gian → Chọn vị trí (map) → Chọn voucher → Đặt
// ============================================================
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, Vibration, ScrollView, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, Modal, FlatList,
  Dimensions, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { LaundryAPI, api } from '../../shared/api';
import { useRequireAuth } from '../../shared/useRequireAuth';
import { socket } from '../../App';

const { width: W } = Dimensions.get('window');
const STEPS = ['package', 'time', 'location', 'voucher', 'confirm'];
const SHIP_RATE = 5000; // 5000đ/km

const TURNAROUND_OPTIONS = [
  { id: '5h',  label: '⚡ Nhanh 5 tiếng',  desc: 'Giao trước 5h kể từ lúc lấy đồ',  surcharge: 1.3 },
  { id: '10h', label: '🕐 Tiêu chuẩn 10h', desc: 'Giao trước 10h kể từ lúc lấy đồ', surcharge: 1.0 },
  { id: '24h', label: '💰 Tiết kiệm 24h',  desc: 'Giao trước 24h kể từ lúc lấy đồ', surcharge: 0.8 },
];

export default function LaundryScreen({ navigation }) {
  const { guardAction } = useRequireAuth(navigation);
  const [step, setStep]           = useState(0);
  // Providers
  const [providers, setProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [packages, setPackages]   = useState([]);
  const [loadingPkg, setLoadingPkg] = useState(false);
  // Package & time
  const [selectedPkg, setSelectedPkg]       = useState(null);
  const [selectedTime, setSelectedTime]     = useState(null);
  const [estimatedKg, setEstimatedKg]       = useState('3');
  // Location
  const [address, setAddress]       = useState('');
  const [coords, setCoords]         = useState(null);
  const [gettingLoc, setGettingLoc] = useState(false);
  // Voucher
  const [vouchers, setVouchers]     = useState([]);
  const [selectedVoucher, setSelectedVoucher] = useState(null);
  const [voucherCode, setVoucherCode] = useState('');
  const [checkingVoucher, setCheckingVoucher] = useState(false);
  // Payment
  const [paymentMethod, setPaymentMethod] = useState('cash');
  // Booking
  const [booking, setBooking]       = useState(false);
  // My orders
  const [myOrders, setMyOrders]     = useState([]);
  const [tab, setTab]               = useState('book');
  const [ordersLoading, setOrdersLoading] = useState(false);
  // Countdown modal
  const [countdownModal, setCountdownModal] = useState(null);
  const countdownRef = useRef(null);

  useEffect(() => {
    loadProviders();
    loadVouchers();
    // Socket: nhận countdown và status update
    if (socket) {
      socket.on('laundry_countdown', (data) => setCountdownModal(data));
      socket.on('order_status_update', (data) => {
        if (data.message) Alert.alert('👕 Đơn giặt', data.message);
        if (tab === 'orders') loadMyOrders();
      });
      return () => { socket.off('laundry_countdown'); socket.off('order_status_update'); };
    }
  }, []);

  const loadProviders = async () => {
    try {
      const res = await LaundryAPI.getProviders();
      setProviders(res.providers || []);
    } catch (_) {}
  };

  const loadVouchers = async () => {
    try {
      const res = await api.get('/api/vouchers/public');
      setVouchers((res.vouchers || []).filter(v => v.module === 'all' || v.module === 'laundry'));
    } catch (_) {}
  };

  const loadMyOrders = async () => {
    setOrdersLoading(true);
    try {
      const res = await LaundryAPI.getMyOrders();
      setMyOrders(res.orders || []);
    } catch (_) {}
    finally { setOrdersLoading(false); }
  };

  const selectProvider = async (p) => {
    setSelectedProvider(p);
    setSelectedPkg(null);
    setLoadingPkg(true);
    try {
      const res = await LaundryAPI.getServices(p._id);
      setPackages(res.services || []);
    } catch (_) { setPackages([]); }
    finally { setLoadingPkg(false); }
  };

  const getMyLocation = async () => {
    setGettingLoc(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Cần quyền GPS', 'Cho phép truy cập vị trí để điền địa chỉ tự động.'); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const { latitude: lat, longitude: lng } = pos.coords;
      setCoords({ lat, lng });
      const geo = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
      if (geo[0]) {
        const r = geo[0];
        setAddress([r.streetNumber, r.street, r.district, r.city].filter(Boolean).join(', '));
      }
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setGettingLoc(false); }
  };

  const applyVoucherCode = async () => {
    if (!voucherCode.trim()) return;
    setCheckingVoucher(true);
    try {
      const res = await api.get(`/api/vouchers/validate?code=${voucherCode.trim().toUpperCase()}`);
      const v = res.voucher || res;
      setSelectedVoucher(v);
      Alert.alert('✅ Voucher hợp lệ!', fmtDiscount(v));
    } catch (e) {
      Alert.alert('❌ Không hợp lệ', e.message);
      setSelectedVoucher(null);
    } finally { setCheckingVoucher(false); }
  };

  const fmtDiscount = (v) => {
    if (!v) return '';
    if (v.type === 'percent') return `Giảm ${v.value}%${v.maxDiscount ? ` (tối đa ${formatCurrency(v.maxDiscount)})` : ''}`;
    return `Giảm ${formatCurrency(v.discount || v.value || 0)}`;
  };

  const calcTotal = () => {
    if (!selectedPkg || !selectedTime) return 0;
    const kg     = parseFloat(estimatedKg) || 2;
    const price  = selectedPkg.pricePerKg * selectedTime.surcharge;
    const laundry = kg * price;
    const ship   = coords && selectedProvider?.lastLat
      ? Math.round(calcDist(coords.lat, coords.lng, selectedProvider.lastLat, selectedProvider.lastLng) * SHIP_RATE / 1000) * 1000 * 2
      : 30000;
    let discount = 0;
    if (selectedVoucher) {
      discount = selectedVoucher.type === 'percent'
        ? Math.min(Math.round(laundry * selectedVoucher.value / 100), selectedVoucher.maxDiscount || Infinity)
        : (selectedVoucher.discount || selectedVoucher.value || 0);
    }
    return { laundry: Math.round(laundry), ship, discount, total: Math.round(laundry + ship - discount) };
  };

  const calcDist = (lat1, lng1, lat2, lng2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  };

  const handleBook = guardAction(async () => {
    if (!selectedProvider || !selectedPkg || !selectedTime || !address)
      return Alert.alert('Thiếu thông tin', 'Vui lòng hoàn thành tất cả các bước');
    setBooking(true);
    const totals = calcTotal();
    try {
      const res = await LaundryAPI.placeOrder({
        providerId:  selectedProvider._id,
        packageId:   selectedPkg.id,
        packageName: `${selectedPkg.name} (${selectedTime.label})`,
        turnaround:  selectedTime.id,
        estimatedKg: parseFloat(estimatedKg) || 2,
        pricePerKg:  Math.round(selectedPkg.pricePerKg * selectedTime.surcharge),
        pickupAddress: address,
        pickupLat:   coords?.lat,
        pickupLng:   coords?.lng,
        paymentMethod,
        voucherCode: selectedVoucher?.code,
        note: '',
      });
      Alert.alert('🎉 Đặt lịch thành công!',
        `Đơn #${res.orderId?.slice(-6)}\nDeadline: ${selectedTime.id}\nTổng ước tính: ${formatCurrency(totals.total)}`,
        [{ text: 'Xem đơn hàng', onPress: () => { setTab('orders'); loadMyOrders(); } }, { text: 'OK' }]
      );
      setStep(0); setSelectedPkg(null); setSelectedTime(null); setSelectedVoucher(null);
    } catch (e) { Alert.alert('Đặt lịch thất bại', e.message); }
    finally { setBooking(false); }
  });

  const totals = calcTotal();
  const currentStep = STEPS[step];

  const renderStep = () => {
    switch(currentStep) {
      case 'package': return (
        <View>
          <Text style={s.stepTitle}>🏪 Bước 1: Chọn cửa hàng & gói giặt</Text>
          {providers.length === 0 && <View style={s.emptyBox}><Text style={s.emptyText}>Chưa có cửa hàng giặt là nào gần bạn</Text></View>}
          {providers.map(p => (
            <TouchableOpacity key={p._id}
              style={[s.providerCard, selectedProvider?._id === p._id && s.providerCardActive]}
              onPress={() => selectProvider(p)}
            >
              <Text style={s.providerName}>{p.bizName}</Text>
              <Text style={s.providerSub}>{p.address || p.district} · ⭐ {p.rating?.toFixed(1)||'5.0'}</Text>
            </TouchableOpacity>
          ))}
          {selectedProvider && (
            loadingPkg ? <ActivityIndicator color={Colors.primary} style={{ marginTop: 16 }} /> :
            packages.map(pkg => (
              <TouchableOpacity key={pkg.id}
                style={[s.pkgCard, selectedPkg?.id === pkg.id && s.pkgCardActive]}
                onPress={() => setSelectedPkg(pkg)}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={s.pkgName}>{pkg.name}</Text>
                  <Text style={s.pkgPrice}>{formatCurrency(pkg.pricePerKg)}<Text style={{ fontSize: 11, fontWeight: '400' }}>/kg</Text></Text>
                </View>
                <Text style={s.pkgDesc}>{pkg.description}</Text>
                <Text style={{ fontSize: 11, color: Colors.textSub, marginTop: 4 }}>Tối thiểu {pkg.minKg}kg · Hoàn thành trong {pkg.turnaround}</Text>
              </TouchableOpacity>
            ))
          )}
          {/* Số kg ước tính */}
          {selectedPkg && (
            <View style={s.kgRow}>
              <Text style={s.kgLabel}>Số kg ước tính:</Text>
              <TouchableOpacity onPress={() => setEstimatedKg(v => String(Math.max(1, parseFloat(v||1)-1)))} style={s.kgBtn}><Text style={s.kgBtnText}>−</Text></TouchableOpacity>
              <Text style={s.kgNum}>{estimatedKg} kg</Text>
              <TouchableOpacity onPress={() => setEstimatedKg(v => String(parseFloat(v||1)+1))} style={s.kgBtn}><Text style={s.kgBtnText}>+</Text></TouchableOpacity>
            </View>
          )}
        </View>
      );

      case 'time': return (
        <View>
          <Text style={s.stepTitle}>⏰ Bước 2: Chọn thời gian hoàn thành</Text>
          {TURNAROUND_OPTIONS.map(t => (
            <TouchableOpacity key={t.id}
              style={[s.timeCard, selectedTime?.id === t.id && s.timeCardActive]}
              onPress={() => setSelectedTime(t)}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={s.timeLabel}>{t.label}</Text>
                {t.surcharge !== 1 && (
                  <Text style={{ fontSize: 12, color: t.surcharge > 1 ? Colors.danger : Colors.success, fontWeight: '700' }}>
                    {t.surcharge > 1 ? `+${Math.round((t.surcharge-1)*100)}%` : `-${Math.round((1-t.surcharge)*100)}%`}
                  </Text>
                )}
              </View>
              <Text style={s.timeDesc}>{t.desc}</Text>
              {selectedPkg && (
                <Text style={{ fontSize: 13, fontWeight: '800', color: Colors.primary, marginTop: 6 }}>
                  {formatCurrency(Math.round(selectedPkg.pricePerKg * t.surcharge))}/kg
                </Text>
              )}
            </TouchableOpacity>
          ))}
        </View>
      );

      case 'location': return (
        <View>
          <Text style={s.stepTitle}>📍 Bước 3: Địa chỉ lấy đồ</Text>
          <TouchableOpacity style={s.gpsBtn} onPress={getMyLocation} disabled={gettingLoc}>
            {gettingLoc ? <ActivityIndicator color={Colors.primary} size="small" /> : <Text style={s.gpsBtnText}>📡 Dùng vị trí hiện tại</Text>}
          </TouchableOpacity>
          <TextInput
            style={s.addrInput}
            placeholder="Số nhà, đường, phường, quận, thành phố..."
            value={address}
            onChangeText={setAddress}
            multiline
          />
          {coords && (
            <View style={s.coordBadge}>
              <Text style={s.coordBadgeText}>📍 {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</Text>
            </View>
          )}
          {/* Payment method */}
          <Text style={[s.stepTitle, { marginTop: 20 }]}>💳 Phương thức thanh toán</Text>
          {[
            { id: 'cash',          label: '💵 Tiền mặt khi nhận đồ' },
            { id: 'bank_transfer', label: '📲 Chuyển khoản SePay (QR)' },
          ].map(pm => (
            <TouchableOpacity key={pm.id}
              style={[s.payCard, paymentMethod === pm.id && s.payCardActive]}
              onPress={() => setPaymentMethod(pm.id)}
            >
              <View style={[s.radio, paymentMethod === pm.id && s.radioActive]}>
                {paymentMethod === pm.id && <View style={s.radioInner} />}
              </View>
              <Text style={s.payLabel}>{pm.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      );

      case 'voucher': return (
        <View>
          <Text style={s.stepTitle}>🎁 Bước 4: Chọn voucher (tùy chọn)</Text>
          {/* Nhập mã */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
            <TextInput style={[s.addrInput, { flex: 1, marginBottom: 0 }]} placeholder="Nhập mã voucher..." value={voucherCode} onChangeText={setVoucherCode} autoCapitalize="characters" />
            <TouchableOpacity style={s.applyBtn} onPress={applyVoucherCode} disabled={checkingVoucher}>
              {checkingVoucher ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.applyBtnText}>Áp dụng</Text>}
            </TouchableOpacity>
          </View>
          {selectedVoucher && (
            <View style={s.voucherApplied}>
              <Text style={{ color: Colors.success, fontWeight: '800' }}>✅ {selectedVoucher.code} — {fmtDiscount(selectedVoucher)}</Text>
              <TouchableOpacity onPress={() => { setSelectedVoucher(null); setVoucherCode(''); }}>
                <Text style={{ color: Colors.danger, fontWeight: '700', marginLeft: 8 }}>✕ Bỏ</Text>
              </TouchableOpacity>
            </View>
          )}
          {/* Danh sách voucher */}
          {vouchers.map(v => (
            <TouchableOpacity key={v._id}
              style={[s.vCard, selectedVoucher?._id === v._id && s.vCardActive]}
              onPress={() => { setSelectedVoucher(v); setVoucherCode(v.code); }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={s.vCode}>{v.code}</Text>
                <Text style={{ color: Colors.success, fontWeight: '800' }}>{fmtDiscount(v)}</Text>
              </View>
              {v.description ? <Text style={s.vDesc}>{v.description}</Text> : null}
              {v.minOrder > 0 && <Text style={s.vMeta}>Đơn tối thiểu {formatCurrency(v.minOrder)}</Text>}
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={s.skipBtn} onPress={() => setStep(s => s + 1)}>
            <Text style={s.skipBtnText}>Bỏ qua, không dùng voucher →</Text>
          </TouchableOpacity>
        </View>
      );

      case 'confirm': return (
        <View>
          <Text style={s.stepTitle}>✅ Bước 5: Xác nhận đặt lịch</Text>
          <View style={s.confirmCard}>
            <Row label="Cửa hàng"    value={selectedProvider?.bizName} />
            <Row label="Gói giặt"    value={selectedPkg?.name} />
            <Row label="Thời gian"   value={selectedTime?.label} />
            <Row label="Số kg ước tính" value={`${estimatedKg} kg`} />
            <Row label="Địa chỉ lấy" value={address} />
            <Row label="Thanh toán"  value={paymentMethod === 'cash' ? '💵 Tiền mặt' : '📲 SePay'} />
            {selectedVoucher && <Row label="Voucher" value={`${selectedVoucher.code} (${fmtDiscount(selectedVoucher)})`} color={Colors.success} />}
          </View>
          {totals && (
            <View style={s.totalCard}>
              <Row label="Tiền giặt"    value={formatCurrency(totals.laundry)} />
              <Row label="Phí ship (2 chiều)" value={formatCurrency(totals.ship)} />
              {totals.discount > 0 && <Row label="Giảm giá" value={`-${formatCurrency(totals.discount)}`} color={Colors.success} />}
              <View style={{ borderTopWidth: 1, borderTopColor: Colors.border, marginTop: 8, paddingTop: 8 }}>
                <Row label="Tổng ước tính" value={formatCurrency(totals.total)} bold primary />
              </View>
              <Text style={{ fontSize: 11, color: Colors.textSub, marginTop: 6 }}>* Tổng thực tế tính theo kg thực khi nhận đồ</Text>
            </View>
          )}
        </View>
      );
    }
  };

  const canNext = () => {
    if (currentStep === 'package') return !!selectedPkg;
    if (currentStep === 'time')    return !!selectedTime;
    if (currentStep === 'location') return !!address.trim();
    return true;
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.backBtn}>←</Text></TouchableOpacity>
        <Text style={s.headerTitle}>👕 Giặt là CRABOR</Text>
        <View style={{ width: 32 }} />
      </View>

      {/* Tab */}
      <View style={s.tabRow}>
        {[['book','📋 Đặt lịch'],['orders','🕐 Lịch sử']].map(([t,label]) => (
          <TouchableOpacity key={t} style={[s.tabBtn, tab === t && s.tabBtnActive]}
            onPress={() => { setTab(t); if (t === 'orders') loadMyOrders(); }}>
            <Text style={[s.tabBtnText, tab === t && s.tabBtnTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'book' ? (
        <>
          {/* Step indicator */}
          <View style={s.stepBar}>
            {STEPS.map((st, i) => (
              <View key={st} style={[s.stepDot, i <= step && s.stepDotActive]}>
                <Text style={[s.stepDotText, i <= step && s.stepDotTextActive]}>{i + 1}</Text>
              </View>
            ))}
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}>
            {renderStep()}
          </ScrollView>

          {/* Navigation buttons */}
          <View style={s.navBar}>
            {step > 0 && (
              <TouchableOpacity style={s.prevBtn} onPress={() => setStep(s => s - 1)}>
                <Text style={s.prevBtnText}>← Quay lại</Text>
              </TouchableOpacity>
            )}
            {step < STEPS.length - 1 ? (
              <TouchableOpacity
                style={[s.nextBtn, !canNext() && s.nextBtnDisabled]}
                onPress={() => canNext() && setStep(s => s + 1)}
                disabled={!canNext()}
              >
                <Text style={s.nextBtnText}>Tiếp theo →</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={[s.nextBtn, booking && { opacity: 0.6 }]} onPress={handleBook} disabled={booking}>
                {booking ? <ActivityIndicator color="#fff" /> : <Text style={s.nextBtnText}>🎉 Đặt lịch ngay</Text>}
              </TouchableOpacity>
            )}
          </View>
        </>
      ) : (
        ordersLoading ? <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} /> :
        myOrders.length === 0 ? (
          <View style={s.emptyBox}>
            <Text style={{ fontSize: 48 }}>🧺</Text>
            <Text style={s.emptyText}>Chưa có đơn giặt nào</Text>
            <TouchableOpacity style={s.nextBtn} onPress={() => setTab('book')} >
              <Text style={s.nextBtnText}>Đặt lịch ngay</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={myOrders}
            keyExtractor={o => o._id}
            contentContainerStyle={{ padding: Spacing.md }}
            refreshControl={<RefreshControl refreshing={ordersLoading} onRefresh={loadMyOrders} tintColor={Colors.primary} />}
            renderItem={({ item: o }) => (
              <View style={s.orderCard}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontWeight: '800' }}>#{o.orderId?.slice(-6)}</Text>
                  <View style={[s.statusBadge, { backgroundColor: STATUS_COLOR[o.status] || Colors.gray3 }]}>
                    <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{STATUS_LABEL[o.status] || o.status}</Text>
                  </View>
                </View>
                <Text style={{ fontSize: 13, color: Colors.textSub, marginTop: 4 }}>{o.packageName}</Text>
                <Text style={{ fontSize: 13, fontWeight: '700', color: Colors.primary, marginTop: 4 }}>{formatCurrency(o.finalTotal || o.estimatedTotal)}</Text>
                {o.deadline && (
                  <Text style={{ fontSize: 11, color: Colors.textSub, marginTop: 2 }}>
                    ⏰ Deadline: {new Date(o.deadline).toLocaleString('vi-VN')}
                  </Text>
                )}
              </View>
            )}
          />
        )
      )}

      {/* Countdown modal */}
      <Modal visible={!!countdownModal} transparent animationType="slide">
        {countdownModal && (
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 }}>
            <View style={{ backgroundColor: '#fff', borderRadius: 20, padding: 24, alignItems: 'center' }}>
              <Text style={{ fontSize: 48 }}>⏳</Text>
              <Text style={{ fontSize: 18, fontWeight: '900', marginTop: 8 }}>Đang giặt!</Text>
              <Text style={{ fontSize: 13, color: Colors.textSub, textAlign: 'center', marginTop: 8 }}>{countdownModal.message}</Text>
              <TouchableOpacity style={{ backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 12, paddingHorizontal: 32, marginTop: 20 }}
                onPress={() => setCountdownModal(null)}>
                <Text style={{ color: '#fff', fontWeight: '800' }}>OK</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </Modal>
    </SafeAreaView>
  );
}

const STATUS_LABEL = {
  pending: 'Chờ xác nhận', partner_accepted: 'Đã xác nhận',
  shipper_picking: 'Đang lấy đồ', picked_up_by_shipper: 'Đang vận chuyển',
  at_partner: 'Tại cửa hàng', washing: 'Đang giặt', countdown: 'Đang giặt',
  ready_return: 'Sẵn sàng trả', shipper_returning: 'Đang trả đồ',
  delivered: 'Hoàn thành', cancelled: 'Đã huỷ',
};
const STATUS_COLOR = {
  pending: Colors.warning, partner_accepted: Colors.info,
  shipper_picking: Colors.primary, picked_up_by_shipper: Colors.primary,
  at_partner: Colors.info, washing: Colors.info, countdown: Colors.primary,
  ready_return: Colors.primary, shipper_returning: Colors.primary,
  delivered: Colors.success, cancelled: Colors.danger,
};

function Row({ label, value, color, bold, primary }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
      <Text style={{ fontSize: 13, color: Colors.textSub }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: bold?'900':'700', color: primary?Colors.primary:color||Colors.text, flex:1, textAlign:'right' }}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.md },
  backBtn: { color: '#fff', fontSize: 24, fontWeight: '700' },
  headerTitle: { color: '#fff', fontWeight: '800', fontSize: 16 },
  tabRow: { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: Colors.border },
  tabBtn: { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabBtnActive: { borderBottomColor: Colors.primary },
  tabBtnText: { fontSize: 13, fontWeight: '700', color: Colors.gray4 },
  tabBtnTextActive: { color: Colors.primary },
  stepBar: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingVertical: 12, backgroundColor: '#fff' },
  stepDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.gray2, alignItems: 'center', justifyContent: 'center' },
  stepDotActive: { backgroundColor: Colors.primary },
  stepDotText: { fontSize: 12, fontWeight: '800', color: Colors.gray4 },
  stepDotTextActive: { color: '#fff' },
  stepTitle: { fontWeight: '800', fontSize: 15, color: Colors.text, marginBottom: 12 },
  providerCard: { backgroundColor: '#fff', borderRadius: Radius.md, padding: 14, marginBottom: 8, borderWidth: 1.5, borderColor: Colors.border, ...Shadow.sm },
  providerCardActive: { borderColor: Colors.primary, backgroundColor: '#FFF5F4' },
  providerName: { fontWeight: '800', fontSize: 14 },
  providerSub: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
  pkgCard: { backgroundColor: '#fff', borderRadius: Radius.md, padding: 14, marginBottom: 8, borderWidth: 1.5, borderColor: Colors.border },
  pkgCardActive: { borderColor: Colors.primary, backgroundColor: '#FFF5F4' },
  pkgName: { fontWeight: '800', fontSize: 14 },
  pkgPrice: { fontWeight: '800', fontSize: 14, color: Colors.primary },
  pkgDesc: { fontSize: 12, color: Colors.textSub, marginTop: 4 },
  kgRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: Radius.md, padding: 14, marginTop: 8, gap: 12 },
  kgLabel: { flex: 1, fontWeight: '700', fontSize: 14 },
  kgBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, borderColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  kgBtnText: { color: Colors.primary, fontWeight: '800', fontSize: 20, lineHeight: 24 },
  kgNum: { fontWeight: '900', fontSize: 16, color: Colors.text, minWidth: 60, textAlign: 'center' },
  timeCard: { backgroundColor: '#fff', borderRadius: Radius.md, padding: 14, marginBottom: 8, borderWidth: 1.5, borderColor: Colors.border },
  timeCardActive: { borderColor: Colors.primary, backgroundColor: '#FFF5F4' },
  timeLabel: { fontWeight: '800', fontSize: 14 },
  timeDesc: { fontSize: 12, color: Colors.textSub, marginTop: 4 },
  gpsBtn: { backgroundColor: Colors.cream, borderRadius: Radius.md, paddingVertical: 12, alignItems: 'center', marginBottom: 10, borderWidth: 1.5, borderColor: Colors.primary },
  gpsBtnText: { color: Colors.primary, fontWeight: '700' },
  addrInput: { backgroundColor: '#fff', borderRadius: Radius.md, borderWidth: 1.5, borderColor: Colors.border, padding: 12, fontSize: 14, marginBottom: 8, textAlignVertical: 'top', minHeight: 64 },
  coordBadge: { backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 8, marginBottom: 8 },
  coordBadgeText: { fontSize: 12, color: Colors.textSub },
  payCard: { backgroundColor: '#fff', borderRadius: Radius.md, padding: 14, marginBottom: 8, borderWidth: 1.5, borderColor: Colors.border, flexDirection: 'row', alignItems: 'center', gap: 10 },
  payCardActive: { borderColor: Colors.primary, backgroundColor: '#FFF5F4' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: Colors.gray3, alignItems: 'center', justifyContent: 'center' },
  radioActive: { borderColor: Colors.primary },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primary },
  payLabel: { fontSize: 14, fontWeight: '600' },
  applyBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingHorizontal: 16, justifyContent: 'center' },
  applyBtnText: { color: '#fff', fontWeight: '700' },
  voucherApplied: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F0FFF4', borderRadius: Radius.md, padding: 10, marginBottom: 12 },
  vCard: { backgroundColor: '#fff', borderRadius: Radius.md, padding: 14, marginBottom: 8, borderWidth: 1.5, borderColor: Colors.border },
  vCardActive: { borderColor: Colors.primary, backgroundColor: '#FFF5F4' },
  vCode: { fontWeight: '900', fontSize: 15, color: Colors.primary },
  vDesc: { fontSize: 12, color: Colors.textSub, marginTop: 4 },
  vMeta: { fontSize: 11, color: Colors.textSub, marginTop: 4 },
  skipBtn: { alignItems: 'center', paddingVertical: 14 },
  skipBtnText: { color: Colors.gray4, fontSize: 13 },
  confirmCard: { backgroundColor: '#fff', borderRadius: Radius.lg, padding: 16, marginBottom: 12, ...Shadow.sm },
  totalCard: { backgroundColor: '#fff', borderRadius: Radius.lg, padding: 16, ...Shadow.sm },
  navBar: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#fff', flexDirection: 'row', padding: Spacing.md, gap: 10, borderTopWidth: 1, borderTopColor: Colors.border, elevation: 8 },
  prevBtn: { flex: 1, borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center' },
  prevBtnText: { fontWeight: '700', color: Colors.gray5 },
  nextBtn: { flex: 2, backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center' },
  nextBtnDisabled: { backgroundColor: Colors.gray3 },
  nextBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40 },
  emptyText: { fontSize: 14, color: Colors.gray4, textAlign: 'center' },
  orderCard: { backgroundColor: '#fff', borderRadius: Radius.md, padding: 14, marginBottom: 10, ...Shadow.sm },
  statusBadge: { borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
});
