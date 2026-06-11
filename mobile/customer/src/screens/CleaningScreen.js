// ============================================================
// CRABOR — Cleaning Screen (Dọn nhà) — Full workflow
// Chọn gói → Lịch → Map → Voucher → Thanh toán → Đặt
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, Modal, FlatList,
  Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { CleaningAPI, api } from '../../shared/api';
import { useRequireAuth } from '../../shared/useRequireAuth';
import { socket } from '../../App';

const PACKAGES = [
  { id: 'basic',  icon: '🧹', name: 'Dọn cơ bản',    price: 200000, duration: '2-3 tiếng', desc: 'Quét lau, hút bụi, vệ sinh bếp & WC' },
  { id: 'medium', icon: '✨', name: 'Dọn tiêu chuẩn', price: 300000, duration: '3-4 tiếng', desc: 'Cơ bản + lau kính, tủ bếp, sắp xếp đồ đạc' },
  { id: 'deep',   icon: '💎', name: 'Dọn toàn diện',  price: 400000, duration: '4-6 tiếng', desc: 'Toàn diện + vệ sinh máy lạnh, thiết bị gia dụng' },
];

const PAYMENT_METHODS = [
  { id: 'cash',          icon: '💵', label: 'Tiền mặt' },
  { id: 'bank_transfer', icon: '📲', label: 'SePay QR' },
  { id: 'momo',          icon: '💜', label: 'MoMo (sắp có)', disabled: true },
  { id: 'zalopay',       icon: '💙', label: 'ZaloPay (sắp có)', disabled: true },
];

const TIME_SLOTS = ['07:00','08:00','09:00','10:00','11:00','13:00','14:00','15:00','16:00','17:00'];

const STEPS = ['package','schedule','location','voucher','payment','confirm'];
const STEP_LABELS = ['Gói dịch vụ','Lịch hẹn','Vị trí','Voucher','Thanh toán','Xác nhận'];

export default function CleaningScreen({ navigation }) {
  const { guardAction } = useRequireAuth(navigation);

  const [step, setStep]               = useState(0);
  const [selectedPkg, setSelectedPkg] = useState(null);
  const [note, setNote]               = useState('');
  // Schedule
  const [bookDate, setBookDate]       = useState('');
  const [bookTime, setBookTime]       = useState('');
  const dateOptions = (() => {
    const arr = [];
    for (let i = 1; i <= 7; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      arr.push({ label: i===1 ? 'Ngày mai' : d.toLocaleDateString('vi-VN',{weekday:'short',day:'2-digit',month:'2-digit'}), value: d.toISOString().split('T')[0] });
    }
    return arr;
  })();
  // Location
  const [address, setAddress]         = useState('');
  const [coords, setCoords]           = useState(null);
  const [gettingLoc, setGettingLoc]   = useState(false);
  // Voucher
  const [vouchers, setVouchers]       = useState([]);
  const [selectedVoucher, setSelectedVoucher] = useState(null);
  const [voucherCode, setVoucherCode] = useState('');
  const [checkingV, setCheckingV]     = useState(false);
  // Payment
  const [payMethod, setPayMethod]     = useState('cash');
  // Booking
  const [booking, setBooking]         = useState(false);
  // My orders
  const [tab, setTab]                 = useState('book');
  const [myOrders, setMyOrders]       = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);

  useEffect(() => {
    loadVouchers();
    if (socket) {
      socket.on('order_status_update', (d) => {
        if (d.message) Alert.alert('🧹 Đơn dọn nhà', d.message);
        if (tab === 'orders') loadMyOrders();
      });
      return () => socket.off('order_status_update');
    }
  }, []);

  const loadVouchers = async () => {
    try {
      const res = await api.get('/api/vouchers/public');
      setVouchers((res.vouchers || []).filter(v => v.module === 'all' || v.module === 'cleaning'));
    } catch (_) {}
  };

  const loadMyOrders = async () => {
    setOrdersLoading(true);
    try {
      const res = await CleaningAPI.getMyOrders();
      setMyOrders(res.orders || []);
    } catch (_) {}
    finally { setOrdersLoading(false); }
  };

  const getLocation = async () => {
    Vibration.vibrate(30);
    setGettingLoc(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Cần quyền GPS'); return; }
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

  const applyVoucher = async () => {
    Vibration.vibrate(30);
    if (!voucherCode.trim()) return;
    setCheckingV(true);
    try {
      const res = await api.get(`/api/vouchers/validate?code=${voucherCode.trim().toUpperCase()}`);
      setSelectedVoucher(res.voucher || res);
      Alert.alert('✅ Voucher hợp lệ!', `Giảm ${formatCurrency(res.voucher?.discount || res.discount || 0)}`);
    } catch (e) {
      Alert.alert('❌ Không hợp lệ', e.message);
      setSelectedVoucher(null);
    } finally { setCheckingV(false); }
  };

  const calcTotal = () => {
    if (!selectedPkg) return 0;
    const discount = selectedVoucher?.discount || selectedVoucher?.value || 0;
    return Math.max(0, selectedPkg.price - discount);
  };

  const handleBook = guardAction(async () => {
    if (!selectedPkg || !bookDate || !bookTime || !address.trim())
      return Alert.alert('Thiếu thông tin', 'Hoàn thành tất cả các bước');
    Vibration.vibrate(50);
    setBooking(true);
    try {
      const res = await CleaningAPI.placeOrder({
        serviceId:     selectedPkg.id,
        serviceName:   selectedPkg.name,
        price:         selectedPkg.price,
        duration:      selectedPkg.duration,
        date:          bookDate,
        time:          bookTime,
        address,
        lat:           coords?.lat,
        lng:           coords?.lng,
        note,
        paymentMethod: payMethod,
        voucherCode:   selectedVoucher?.code,
        total:         calcTotal(),
      });
      Alert.alert('🎉 Đặt lịch thành công!',
        `Đơn #${res.orderId?.slice(-6)}\n${bookDate} lúc ${bookTime}\nTổng: ${formatCurrency(calcTotal())}`,
        [{ text: 'Xem đơn', onPress: () => { setTab('orders'); loadMyOrders(); } }, { text: 'OK' }]
      );
      setStep(0); setSelectedPkg(null); setNote('');
      setBookDate(''); setBookTime(''); setSelectedVoucher(null);
    } catch (e) { Alert.alert('Đặt lịch thất bại', e.message); }
    finally { setBooking(false); }
  });

  const vib = () => Vibration.vibrate(30);
  const canNext = () => {
    if (step === 0) return !!selectedPkg;
    if (step === 1) return !!(bookDate && bookTime);
    if (step === 2) return !!address.trim();
    return true;
  };

  const renderStepContent = () => {
    switch(STEPS[step]) {

      case 'package': return (
        <View>
          <Text style={s.stepTitle}>🧹 Chọn gói dọn nhà</Text>
          {PACKAGES.map(pkg => (
            <TouchableOpacity key={pkg.id}
              style={[s.pkgCard, selectedPkg?.id === pkg.id && s.pkgCardActive]}
              onPress={() => { vib(); setSelectedPkg(pkg); }}
            >
              <View style={{ flexDirection:'row', alignItems:'center', gap: 12 }}>
                <Text style={{ fontSize: 36 }}>{pkg.icon}</Text>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection:'row', justifyContent:'space-between' }}>
                    <Text style={s.pkgName}>{pkg.name}</Text>
                    <Text style={s.pkgPrice}>{formatCurrency(pkg.price)}</Text>
                  </View>
                  <Text style={s.pkgDesc}>{pkg.desc}</Text>
                  <Text style={s.pkgDuration}>⏱ {pkg.duration}</Text>
                </View>
                <View style={[s.radio, selectedPkg?.id === pkg.id && s.radioActive]}>
                  {selectedPkg?.id === pkg.id && <View style={s.radioInner}/>}
                </View>
              </View>
            </TouchableOpacity>
          ))}
          <Text style={[s.stepTitle, { marginTop: 20 }]}>📝 Ghi chú (tuỳ chọn)</Text>
          <TextInput
            style={s.noteInput}
            placeholder="Nhà có trẻ nhỏ, dị ứng hoá chất, tập trung phòng bếp..."
            value={note} onChangeText={setNote}
            multiline numberOfLines={3}
          />
        </View>
      );

      case 'schedule': return (
        <View>
          <Text style={s.stepTitle}>📅 Chọn ngày</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
            {dateOptions.map(d => (
              <TouchableOpacity key={d.value}
                style={[s.chip, bookDate===d.value && s.chipActive]}
                onPress={() => { vib(); setBookDate(d.value); }}
              >
                <Text style={[s.chipText, bookDate===d.value && s.chipTextActive]}>{d.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <Text style={s.stepTitle}>🕐 Chọn giờ bắt đầu</Text>
          <View style={{ flexDirection:'row', flexWrap:'wrap', gap: 8 }}>
            {TIME_SLOTS.map(t => (
              <TouchableOpacity key={t}
                style={[s.chip, bookTime===t && s.chipActive]}
                onPress={() => { vib(); setBookTime(t); }}
              >
                <Text style={[s.chipText, bookTime===t && s.chipTextActive]}>{t}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {selectedPkg && bookDate && bookTime && (
            <View style={s.summaryBox}>
              <Text style={s.summaryText}>✅ {selectedPkg.name} · {bookDate} · {bookTime}</Text>
              <Text style={s.summaryText}>⏱ Dự kiến xong sau {selectedPkg.duration}</Text>
            </View>
          )}
        </View>
      );

      case 'location': return (
        <View>
          <Text style={s.stepTitle}>📍 Địa chỉ dọn nhà</Text>
          <TouchableOpacity style={s.gpsBtn} onPress={getLocation} disabled={gettingLoc}>
            {gettingLoc
              ? <ActivityIndicator color={Colors.primary} size="small"/>
              : <Text style={s.gpsBtnText}>📡 Dùng vị trí hiện tại</Text>
            }
          </TouchableOpacity>
          <TextInput
            style={s.addressInput}
            placeholder="Số nhà, đường, phường, quận..."
            value={address} onChangeText={setAddress}
            multiline
          />
          {coords && (
            <View style={s.coordBadge}>
              <Text style={s.coordText}>📍 {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</Text>
            </View>
          )}
        </View>
      );

      case 'voucher': return (
        <View>
          <Text style={s.stepTitle}>🎁 Chọn voucher (tuỳ chọn)</Text>
          <View style={{ flexDirection:'row', gap: 8, marginBottom: 16 }}>
            <TextInput
              style={[s.addressInput, { flex:1, marginBottom:0, minHeight: 44 }]}
              placeholder="Nhập mã voucher..."
              value={voucherCode} onChangeText={setVoucherCode}
              autoCapitalize="characters"
            />
            <TouchableOpacity style={s.applyBtn} onPress={applyVoucher} disabled={checkingV}>
              {checkingV ? <ActivityIndicator color="#fff" size="small"/> : <Text style={s.applyBtnText}>Áp dụng</Text>}
            </TouchableOpacity>
          </View>
          {selectedVoucher && (
            <View style={s.voucherApplied}>
              <Text style={{ color: Colors.success, fontWeight:'800', flex: 1 }}>
                ✅ {selectedVoucher.code} — Giảm {formatCurrency(selectedVoucher.discount || selectedVoucher.value || 0)}
              </Text>
              <TouchableOpacity onPress={() => { setSelectedVoucher(null); setVoucherCode(''); }}>
                <Text style={{ color: Colors.danger, fontWeight:'700' }}>✕ Bỏ</Text>
              </TouchableOpacity>
            </View>
          )}
          {vouchers.map(v => (
            <TouchableOpacity key={v._id}
              style={[s.vCard, selectedVoucher?._id===v._id && s.vCardActive]}
              onPress={() => { vib(); setSelectedVoucher(v); setVoucherCode(v.code); }}
            >
              <View style={{ flexDirection:'row', justifyContent:'space-between' }}>
                <Text style={s.vCode}>{v.code}</Text>
                <Text style={{ color: Colors.success, fontWeight:'800' }}>
                  Giảm {formatCurrency(v.discount || v.value || 0)}
                </Text>
              </View>
              {v.description && <Text style={{ fontSize:12, color: Colors.textSub, marginTop:4 }}>{v.description}</Text>}
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={s.skipBtn} onPress={() => { vib(); setStep(s => s + 1); }}>
            <Text style={s.skipBtnText}>Bỏ qua →</Text>
          </TouchableOpacity>
        </View>
      );

      case 'payment': return (
        <View>
          <Text style={s.stepTitle}>💳 Phương thức thanh toán</Text>
          {PAYMENT_METHODS.map(pm => (
            <TouchableOpacity key={pm.id}
              style={[s.payCard, payMethod===pm.id && s.payCardActive, pm.disabled && { opacity: 0.4 }]}
              onPress={() => { if (!pm.disabled) { vib(); setPayMethod(pm.id); } }}
            >
              <View style={[s.radio, payMethod===pm.id && s.radioActive]}>
                {payMethod===pm.id && <View style={s.radioInner}/>}
              </View>
              <Text style={{ fontSize: 20 }}>{pm.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.payLabel}>{pm.label}</Text>
                {pm.disabled && <Text style={{ fontSize:11, color:Colors.gray4 }}>Sắp ra mắt</Text>}
              </View>
            </TouchableOpacity>
          ))}
        </View>
      );

      case 'confirm': return (
        <View>
          <Text style={s.stepTitle}>✅ Xác nhận đặt lịch</Text>
          <View style={s.confirmCard}>
            {[
              ['Dịch vụ',    `${selectedPkg?.icon} ${selectedPkg?.name}`],
              ['Giá',         formatCurrency(selectedPkg?.price || 0)],
              ['Thời gian',   selectedPkg?.duration],
              ['Ngày',        bookDate],
              ['Giờ',         bookTime],
              ['Địa chỉ',     address],
              ['Thanh toán',  PAYMENT_METHODS.find(p => p.id === payMethod)?.label],
            ].map(([k, v]) => v ? (
              <View key={k} style={s.confirmRow}>
                <Text style={s.confirmKey}>{k}</Text>
                <Text style={s.confirmVal} numberOfLines={2}>{v}</Text>
              </View>
            ) : null)}
            {selectedVoucher && (
              <View style={s.confirmRow}>
                <Text style={s.confirmKey}>Voucher</Text>
                <Text style={[s.confirmVal, { color: Colors.success }]}>
                  {selectedVoucher.code} (-{formatCurrency(selectedVoucher.discount || selectedVoucher.value || 0)})
                </Text>
              </View>
            )}
            {note ? <View style={s.confirmRow}>
              <Text style={s.confirmKey}>Ghi chú</Text>
              <Text style={s.confirmVal}>{note}</Text>
            </View> : null}
            <View style={[s.confirmRow, { borderTopWidth:1, borderTopColor:Colors.border, marginTop:8, paddingTop:8 }]}>
              <Text style={{ fontWeight:'800', fontSize:15 }}>Tổng thanh toán</Text>
              <Text style={{ fontWeight:'900', fontSize:18, color:Colors.primary }}>{formatCurrency(calcTotal())}</Text>
            </View>
          </View>
          <View style={s.infoCard}>
            <Text style={s.infoText}>🛵 Nhân viên CRABOR sẽ đến đúng giờ đã hẹn</Text>
            <Text style={s.infoText}>📞 Chúng tôi sẽ liên hệ xác nhận trước 30 phút</Text>
            <Text style={s.infoText}>⭐ Đánh giá sau khi hoàn thành để nhận điểm thưởng</Text>
          </View>
        </View>
      );
    }
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={s.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>🧹 Dọn nhà CRABOR</Text>
        <View style={{ width: 32 }}/>
      </View>

      {/* Tabs */}
      <View style={s.tabRow}>
        {[['book','📋 Đặt lịch'],['orders','🕐 Lịch sử']].map(([t,l]) => (
          <TouchableOpacity key={t} style={[s.tabBtn, tab===t && s.tabBtnActive]}
            onPress={() => { vib(); setTab(t); if(t==='orders') loadMyOrders(); }}>
            <Text style={[s.tabBtnText, tab===t && s.tabBtnTextActive]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'book' ? (
        <>
          {/* Step indicator */}
          <View style={s.stepBar}>
            {STEPS.map((_, i) => (
              <View key={i} style={[s.stepDot, i <= step && s.stepDotActive]}>
                <Text style={[s.stepDotTxt, i <= step && s.stepDotTxtActive]}>{i+1}</Text>
              </View>
            ))}
          </View>
          <Text style={{ textAlign:'center', fontSize:12, color:Colors.primary, fontWeight:'700', paddingBottom:4 }}>
            {STEP_LABELS[step]}
          </Text>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding:Spacing.md, paddingBottom:120 }}>
            {renderStepContent()}
          </ScrollView>

          {/* Nav buttons */}
          <View style={s.navBar}>
            {step > 0 && (
              <TouchableOpacity style={s.prevBtn} onPress={() => { vib(); setStep(s => s - 1); }}>
                <Text style={s.prevBtnText}>← Quay lại</Text>
              </TouchableOpacity>
            )}
            {step < STEPS.length - 1 ? (
              <TouchableOpacity
                style={[s.nextBtn, !canNext() && s.nextBtnDis]}
                onPress={() => { if(canNext()) { vib(); setStep(s => s+1); } }}
                disabled={!canNext()}
              >
                <Text style={s.nextBtnText}>Tiếp theo →</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[s.nextBtn, booking && { opacity:0.6 }]}
                onPress={handleBook} disabled={booking}
              >
                {booking ? <ActivityIndicator color="#fff"/> : <Text style={s.nextBtnText}>🎉 Đặt lịch ngay</Text>}
              </TouchableOpacity>
            )}
          </View>
        </>
      ) : (
        ordersLoading ? <ActivityIndicator color={Colors.primary} style={{ flex:1 }}/> :
        myOrders.length === 0 ? (
          <View style={{ flex:1, alignItems:'center', justifyContent:'center', gap:12 }}>
            <Text style={{ fontSize:48 }}>🏠</Text>
            <Text style={{ color:Colors.gray4, textAlign:'center' }}>Chưa có đơn dọn nhà nào</Text>
            <TouchableOpacity style={s.nextBtn} onPress={() => setTab('book')}>
              <Text style={s.nextBtnText}>Đặt lịch ngay</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={myOrders}
            keyExtractor={o => o._id}
            contentContainerStyle={{ padding:Spacing.md }}
            renderItem={({ item: o }) => (
              <View style={[s.orderCard, ...Shadow.sm]}>
                <View style={{ flexDirection:'row', justifyContent:'space-between' }}>
                  <Text style={{ fontWeight:'800' }}>#{o._id?.slice(-6)}</Text>
                  <Text style={{ fontSize:11, fontWeight:'700', color: o.status==='delivered'?Colors.success:Colors.primary }}>
                    {o.status==='delivered'?'✅ Hoàn thành':o.status==='cancelled'?'❌ Đã huỷ':'🔄 Đang xử lý'}
                  </Text>
                </View>
                <Text style={{ fontSize:13, color:Colors.textSub, marginTop:4 }}>{o.serviceName}</Text>
                <Text style={{ fontSize:13, fontWeight:'700', color:Colors.primary, marginTop:4 }}>{formatCurrency(o.total)}</Text>
                <Text style={{ fontSize:11, color:Colors.textSub }}>{o.date} {o.time}</Text>
              </View>
            )}
          />
        )
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex:1, backgroundColor:Colors.gray1 },
  header: { backgroundColor:Colors.primary, flexDirection:'row', alignItems:'center', justifyContent:'space-between', padding:Spacing.md },
  backBtn: { color:'#fff', fontSize:24, fontWeight:'700' },
  headerTitle: { color:'#fff', fontWeight:'800', fontSize:16 },
  tabRow: { flexDirection:'row', backgroundColor:'#fff', borderBottomWidth:1, borderBottomColor:Colors.border },
  tabBtn: { flex:1, paddingVertical:12, alignItems:'center', borderBottomWidth:2, borderBottomColor:'transparent' },
  tabBtnActive: { borderBottomColor:Colors.primary },
  tabBtnText: { fontSize:13, fontWeight:'700', color:Colors.gray4 },
  tabBtnTextActive: { color:Colors.primary },
  stepBar: { flexDirection:'row', justifyContent:'center', gap:6, paddingVertical:10, backgroundColor:'#fff' },
  stepDot: { width:26, height:26, borderRadius:13, backgroundColor:Colors.gray2, alignItems:'center', justifyContent:'center' },
  stepDotActive: { backgroundColor:Colors.primary },
  stepDotTxt: { fontSize:11, fontWeight:'800', color:Colors.gray4 },
  stepDotTxtActive: { color:'#fff' },
  stepTitle: { fontWeight:'800', fontSize:14, marginBottom:12, color:Colors.text },
  pkgCard: { backgroundColor:'#fff', borderRadius:Radius.lg, padding:16, marginBottom:10, borderWidth:1.5, borderColor:Colors.border, ...Shadow.sm },
  pkgCardActive: { borderColor:Colors.primary, backgroundColor:'#FFF5F4' },
  pkgName: { fontWeight:'800', fontSize:15, color:Colors.text },
  pkgPrice: { fontWeight:'900', fontSize:16, color:Colors.primary },
  pkgDesc: { fontSize:12, color:Colors.textSub, marginTop:4 },
  pkgDuration: { fontSize:11, color:Colors.gray4, marginTop:4 },
  noteInput: { backgroundColor:'#fff', borderRadius:Radius.md, borderWidth:1.5, borderColor:Colors.border, padding:12, fontSize:14, textAlignVertical:'top', minHeight:72, marginBottom:8 },
  chip: { paddingHorizontal:14, paddingVertical:8, borderRadius:Radius.full, borderWidth:1.5, borderColor:Colors.border, backgroundColor:'#fff', marginRight:8, marginBottom:8 },
  chipActive: { backgroundColor:Colors.primary, borderColor:Colors.primary },
  chipText: { fontSize:12, fontWeight:'700', color:Colors.gray5 },
  chipTextActive: { color:'#fff' },
  summaryBox: { backgroundColor:Colors.cream, borderRadius:Radius.md, padding:12, marginTop:12, borderLeftWidth:3, borderLeftColor:Colors.primary },
  summaryText: { fontSize:13, fontWeight:'600', color:Colors.text },
  gpsBtn: { backgroundColor:Colors.cream, borderRadius:Radius.md, paddingVertical:12, alignItems:'center', marginBottom:10, borderWidth:1.5, borderColor:Colors.primary },
  gpsBtnText: { color:Colors.primary, fontWeight:'700' },
  addressInput: { backgroundColor:'#fff', borderRadius:Radius.md, borderWidth:1.5, borderColor:Colors.border, padding:12, fontSize:14, marginBottom:8, textAlignVertical:'top', minHeight:60 },
  coordBadge: { backgroundColor:Colors.gray1, borderRadius:Radius.md, padding:8 },
  coordText: { fontSize:12, color:Colors.textSub },
  applyBtn: { backgroundColor:Colors.primary, borderRadius:Radius.md, paddingHorizontal:14, justifyContent:'center' },
  applyBtnText: { color:'#fff', fontWeight:'700' },
  voucherApplied: { flexDirection:'row', alignItems:'center', backgroundColor:'#F0FFF4', borderRadius:Radius.md, padding:10, marginBottom:12 },
  vCard: { backgroundColor:'#fff', borderRadius:Radius.md, padding:14, marginBottom:8, borderWidth:1.5, borderColor:Colors.border },
  vCardActive: { borderColor:Colors.primary, backgroundColor:'#FFF5F4' },
  vCode: { fontWeight:'900', fontSize:15, color:Colors.primary },
  skipBtn: { alignItems:'center', paddingVertical:14 },
  skipBtnText: { color:Colors.gray4, fontSize:13 },
  payCard: { backgroundColor:'#fff', borderRadius:Radius.md, padding:14, marginBottom:8, borderWidth:1.5, borderColor:Colors.border, flexDirection:'row', alignItems:'center', gap:12 },
  payCardActive: { borderColor:Colors.primary, backgroundColor:'#FFF5F4' },
  radio: { width:20, height:20, borderRadius:10, borderWidth:2, borderColor:Colors.gray3, alignItems:'center', justifyContent:'center' },
  radioActive: { borderColor:Colors.primary },
  radioInner: { width:10, height:10, borderRadius:5, backgroundColor:Colors.primary },
  payLabel: { fontSize:14, fontWeight:'600', color:Colors.text },
  confirmCard: { backgroundColor:'#fff', borderRadius:Radius.lg, padding:16, marginBottom:12, ...Shadow.sm },
  confirmRow: { flexDirection:'row', justifyContent:'space-between', marginBottom:8, gap:8 },
  confirmKey: { fontSize:13, color:Colors.textSub, minWidth:80 },
  confirmVal: { fontSize:13, fontWeight:'700', flex:1, textAlign:'right' },
  infoCard: { backgroundColor:Colors.cream, borderRadius:Radius.md, padding:14, gap:6, borderLeftWidth:3, borderLeftColor:Colors.primary },
  infoText: { fontSize:12, color:Colors.textSub },
  navBar: { position:'absolute', bottom:0, left:0, right:0, backgroundColor:'#fff', flexDirection:'row', padding:Spacing.md, gap:10, borderTopWidth:1, borderTopColor:Colors.border, elevation:8 },
  prevBtn: { flex:1, borderWidth:1.5, borderColor:Colors.border, borderRadius:Radius.md, paddingVertical:14, alignItems:'center' },
  prevBtnText: { fontWeight:'700', color:Colors.gray5 },
  nextBtn: { flex:2, backgroundColor:Colors.primary, borderRadius:Radius.md, paddingVertical:14, alignItems:'center' },
  nextBtnDis: { backgroundColor:Colors.gray3 },
  nextBtnText: { color:'#fff', fontWeight:'800', fontSize:15 },
  orderCard: { backgroundColor:'#fff', borderRadius:Radius.md, padding:14, marginBottom:10 },
});
