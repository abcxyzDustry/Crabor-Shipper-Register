// ============================================================
// CRABOR — Checkout Screen (Full workflow)
// Tên/SĐT → Voucher → Phương thức TT → Xác nhận → Đặt hàng
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, Modal, Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { CustomerAPI, api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { playSuccessSound } from '../../shared/useNotificationSound';

const PAYMENT_METHODS = [
  { id: 'cash',          icon: '💵', label: 'Tiền mặt khi nhận' },
  { id: 'sepay',         icon: '📲', label: 'SePay QR (VIB)' },
  { id: 'payos',         icon: '🔗', label: 'PayOS (ATM/Momo/ZaloPay)' },
  { id: 'wallet',        icon: '💳', label: 'Ví CRABOR' },
  { id: 'momo',          icon: '💜', label: 'MoMo (sắp có)', disabled: true },
  { id: 'zalopay',       icon: '💙', label: 'ZaloPay (sắp có)', disabled: true },
];

const vib = () => Vibration.vibrate(30);

export default function CheckoutScreen({ navigation, route }) {
  const { partner, cartItems, note: initNote, voucher: initVoucher, subtotal, total: initTotal } = route.params || {};
  const { user } = useAuth();

  const [name, setName]         = useState(user?.fullName || '');
  const [phone, setPhone]       = useState(user?.phone || '');
  const [address, setAddress]   = useState('');
  const [note, setNote]         = useState(initNote || '');
  const [payMethod, setPayMethod] = useState('cash');
  const [voucher, setVoucher]   = useState(initVoucher || null);
  const [voucherCode, setVoucherCode] = useState('');
  const [checkingV, setCheckingV] = useState(false);
  const [vouchers, setVouchers] = useState([]);
  const [voucherModal, setVoucherModal] = useState(false);
  const [walletBalance, setWalletBalance] = useState(user?.walletBalance || 0);
  const [placing, setPlacing]   = useState(false);
  const [step, setStep]         = useState('info'); // info | voucher | payment | confirm

  const discount = voucher?.discount || voucher?.value || 0;
  const subtotalAmt = subtotal || (cartItems || []).reduce((s, i) => s + i.price * (i.qty || i.quantity || 1), 0);
  const shipFee  = 20000;
  const total    = Math.max(0, subtotalAmt + shipFee - discount);

  useEffect(() => {
    loadVouchers();
    loadWallet();
  }, []);

  const loadVouchers = async () => {
    try {
      const res = await api.get('/api/vouchers/public');
      setVouchers(res.vouchers || []);
    } catch (_) {}
  };

  const loadWallet = async () => {
    try {
      const res = await api.get('/api/wallet');
      setWalletBalance(res.wallet?.balance || res.balance || 0);
    } catch (_) {}
  };

  const applyVoucherCode = async () => {
    vib();
    if (!voucherCode.trim()) return;
    setCheckingV(true);
    try {
      const res = await CustomerAPI.validateVoucher(voucherCode.trim().toUpperCase());
      setVoucher(res.voucher || res);
      Alert.alert('✅ Voucher hợp lệ!', `Giảm ${formatCurrency(res.voucher?.discount || res.discount || res.value || 0)}`);
    } catch (e) {
      Alert.alert('❌ Không hợp lệ', e.message);
    } finally { setCheckingV(false); }
  };

  const placeOrder = async () => {
    vib();
    if (!name.trim()) return Alert.alert('Lỗi', 'Nhập tên người nhận');
    if (!phone.trim()) return Alert.alert('Lỗi', 'Nhập số điện thoại');
    if (!address.trim()) return Alert.alert('Lỗi', 'Nhập địa chỉ giao hàng');
    if (payMethod === 'wallet' && walletBalance < total)
      return Alert.alert('Không đủ số dư', `Ví CRABOR: ${formatCurrency(walletBalance)}\nCần: ${formatCurrency(total)}`);

    setPlacing(true);
    try {
      const res = await CustomerAPI.createOrder({
        partnerId:     partner?._id,
        items:         cartItems?.map(i => ({ _id: i._id, name: i.name, price: i.price, qty: i.qty || i.quantity || 1 })),
        address:       address.trim(),
        receiverName:  name.trim(),
        receiverPhone: phone.trim(),
        note,
        paymentMethod: payMethod,
        voucherCode:   voucher?.code,
        shipFee,
        total,
      });

      if (!res.success && !res.orderId && !res.order) throw new Error(res.message || 'Đặt hàng thất bại');

      const orderId = res.orderId || res.order?.orderId;
      playSuccessSound();

      // Nếu PayOS → navigate đến màn hình thanh toán
      if (payMethod === 'payos') {
        navigation.replace('PayOSPayment', {
          order: { orderId, customerName: name, finalTotal: total },
          amount: total,
          description: `Thanh toan ${orderId?.slice(-6) || ''}`,
        });
        return;
      }

      // Các phương thức khác → báo thành công
      Alert.alert('🎉 Đặt hàng thành công!',
        `Đơn #${orderId?.slice(-6)}\nTổng: ${formatCurrency(total)}\nThanh toán: ${PAYMENT_METHODS.find(p => p.id === payMethod)?.label}`,
        [{ text: 'Xem đơn hàng', onPress: () => navigation.navigate('Orders') }, { text: 'OK', onPress: () => navigation.popToTop() }]
      );
    } catch (e) {
      Alert.alert('Đặt hàng thất bại', e.message);
    } finally { setPlacing(false); }
  };

  const fmtVoucher = (v) => {
    if (!v) return '';
    return v.type === 'percent'
      ? `Giảm ${v.value}%${v.maxDiscount ? ` (tối đa ${formatCurrency(v.maxDiscount)})` : ''}`
      : `Giảm ${formatCurrency(v.discount || v.value || 0)}`;
  };

  const STEPS = ['info', 'voucher', 'payment', 'confirm'];
  const stepIdx = STEPS.indexOf(step);

  const canNext = () => {
    if (step === 'info') return name.trim() && phone.trim() && address.trim();
    return true;
  };

  const renderStep = () => {
    switch (step) {
      case 'info': return (
        <View>
          <Text style={s.stepTitle}>👤 Thông tin người nhận</Text>
          <TextInput style={s.input} placeholder="Họ và tên *" value={name} onChangeText={setName} />
          <TextInput style={s.input} placeholder="Số điện thoại *" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
          <TextInput style={s.input} placeholder="Địa chỉ giao hàng *" value={address} onChangeText={setAddress} multiline />
          <TextInput style={[s.input, { height: 60 }]} placeholder="Ghi chú thêm (tuỳ chọn)" value={note} onChangeText={setNote} multiline />

          {/* Order summary */}
          <Text style={[s.stepTitle, { marginTop: 16 }]}>📦 Tóm tắt đơn</Text>
          <View style={s.summaryCard}>
            {(cartItems || []).map((i, idx) => (
              <View key={idx} style={s.summaryRow}>
                <Text style={s.summaryItem}>{i.qty || i.quantity}× {i.name}</Text>
                <Text style={s.summaryPrice}>{formatCurrency(i.price * (i.qty || i.quantity || 1))}</Text>
              </View>
            ))}
            <View style={[s.summaryRow, { borderTopWidth: 1, borderTopColor: Colors.border, marginTop: 8, paddingTop: 8 }]}>
              <Text style={s.summaryItem}>Phí ship</Text>
              <Text style={s.summaryPrice}>{formatCurrency(shipFee)}</Text>
            </View>
            {discount > 0 && (
              <View style={s.summaryRow}>
                <Text style={[s.summaryItem, { color: Colors.success }]}>Voucher</Text>
                <Text style={[s.summaryPrice, { color: Colors.success }]}>-{formatCurrency(discount)}</Text>
              </View>
            )}
            <View style={[s.summaryRow, { marginTop: 8 }]}>
              <Text style={{ fontWeight: '800', fontSize: 15 }}>Tổng</Text>
              <Text style={{ fontWeight: '900', fontSize: 16, color: Colors.primary }}>{formatCurrency(total)}</Text>
            </View>
          </View>
        </View>
      );

      case 'voucher': return (
        <View>
          <Text style={s.stepTitle}>🎁 Chọn voucher (tuỳ chọn)</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
            <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Nhập mã voucher..."
              value={voucherCode} onChangeText={setVoucherCode} autoCapitalize="characters" />
            <TouchableOpacity style={s.applyBtn} onPress={applyVoucherCode} disabled={checkingV}>
              {checkingV ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.applyBtnText}>Áp dụng</Text>}
            </TouchableOpacity>
          </View>
          {voucher && (
            <View style={s.voucherApplied}>
              <Text style={{ color: Colors.success, fontWeight: '800', flex: 1 }}>✅ {voucher.code} — {fmtVoucher(voucher)}</Text>
              <TouchableOpacity onPress={() => { vib(); setVoucher(null); setVoucherCode(''); }}>
                <Text style={{ color: Colors.danger, fontWeight: '700' }}>✕</Text>
              </TouchableOpacity>
            </View>
          )}
          {vouchers.filter(v => v.active && v.module !== 'laundry' && v.module !== 'cleaning').map(v => (
            <TouchableOpacity key={v._id}
              style={[s.vCard, voucher?._id === v._id && s.vCardActive]}
              onPress={() => { vib(); setVoucher(v); setVoucherCode(v.code); }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={s.vCode}>{v.code}</Text>
                <Text style={{ color: Colors.success, fontWeight: '800' }}>{fmtVoucher(v)}</Text>
              </View>
              {v.description && <Text style={s.vDesc}>{v.description}</Text>}
              {v.minOrder > 0 && <Text style={s.vMeta}>Đơn tối thiểu {formatCurrency(v.minOrder)}</Text>}
              <Text style={s.vMeta}>HSD: {new Date(v.expiresAt).toLocaleDateString('vi-VN')}</Text>
            </TouchableOpacity>
          ))}
          {vouchers.length === 0 && (
            <View style={{ alignItems: 'center', padding: 24 }}>
              <Text style={{ fontSize: 36 }}>🎁</Text>
              <Text style={{ color: Colors.gray4, marginTop: 8 }}>Chưa có voucher nào</Text>
            </View>
          )}
          <TouchableOpacity style={s.skipBtn} onPress={() => { vib(); setStep('payment'); }}>
            <Text style={s.skipBtnText}>Bỏ qua →</Text>
          </TouchableOpacity>
        </View>
      );

      case 'payment': return (
        <View>
          <Text style={s.stepTitle}>💳 Phương thức thanh toán</Text>
          {PAYMENT_METHODS.map(pm => (
            <TouchableOpacity key={pm.id}
              style={[s.methodCard, payMethod === pm.id && s.methodCardActive, pm.disabled && { opacity: 0.4 }]}
              onPress={() => { if (!pm.disabled) { vib(); setPayMethod(pm.id); } }}
            >
              <View style={[s.radio, payMethod === pm.id && s.radioActive]}>
                {payMethod === pm.id && <View style={s.radioInner} />}
              </View>
              <Text style={{ fontSize: 20 }}>{pm.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.methodLabel}>{pm.label}</Text>
                {pm.id === 'wallet' && <Text style={{ fontSize: 11, color: Colors.success }}>Số dư: {formatCurrency(walletBalance)}</Text>}
                {pm.disabled && <Text style={{ fontSize: 11, color: Colors.gray4 }}>Sắp ra mắt</Text>}
              </View>
            </TouchableOpacity>
          ))}
        </View>
      );

      case 'confirm': return (
        <View>
          <Text style={s.stepTitle}>✅ Xác nhận đơn hàng</Text>
          <View style={s.confirmCard}>
            {[
              ['👤 Người nhận', name],
              ['📞 Số điện thoại', phone],
              ['📍 Địa chỉ', address],
              ['🏪 Cửa hàng', partner?.name || '—'],
              ['💳 Thanh toán', PAYMENT_METHODS.find(p => p.id === payMethod)?.label],
              ...(voucher ? [['🎁 Voucher', `${voucher.code} (-${formatCurrency(discount)})`]] : []),
              ...(note ? [['📝 Ghi chú', note]] : []),
            ].map(([k, v]) => (
              <View key={k} style={s.confirmRow}>
                <Text style={s.confirmKey}>{k}</Text>
                <Text style={s.confirmVal} numberOfLines={2}>{v}</Text>
              </View>
            ))}
            <View style={[s.confirmRow, { borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 10, marginTop: 4 }]}>
              <Text style={{ fontWeight: '800', fontSize: 15 }}>Tổng thanh toán</Text>
              <Text style={{ fontWeight: '900', fontSize: 18, color: Colors.primary }}>{formatCurrency(total)}</Text>
            </View>
          </View>

          {payMethod === 'wallet' && walletBalance < total && (
            <View style={s.warnCard}>
              <Text style={{ color: Colors.danger, fontWeight: '700' }}>⚠️ Số dư ví không đủ</Text>
              <Text style={{ fontSize: 12, color: Colors.danger, marginTop: 4 }}>Cần: {formatCurrency(total)} · Có: {formatCurrency(walletBalance)}</Text>
              <TouchableOpacity onPress={() => { vib(); navigation.navigate('WalletTopup'); }}>
                <Text style={{ color: Colors.primary, fontWeight: '700', marginTop: 6 }}>→ Nạp tiền ngay</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      );
    }
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => { vib(); step === 'info' ? navigation.goBack() : setStep(STEPS[stepIdx - 1]); }}>
          <Text style={s.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>🛒 Thanh toán</Text>
        <Text style={s.stepIndicator}>{stepIdx + 1}/{STEPS.length}</Text>
      </View>

      {/* Step dots */}
      <View style={s.stepBar}>
        {STEPS.map((st, i) => (
          <View key={st} style={[s.stepDot, i <= stepIdx && s.stepDotActive]} />
        ))}
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}>
        {renderStep()}
      </ScrollView>

      {/* Bottom bar */}
      <View style={s.bottomBar}>
        <View>
          <Text style={s.totalLabel}>Tổng: {formatCurrency(total)}</Text>
          {discount > 0 && <Text style={{ fontSize: 11, color: Colors.success }}>Tiết kiệm {formatCurrency(discount)}</Text>}
        </View>
        {step !== 'confirm' ? (
          <TouchableOpacity
            style={[s.nextBtn, !canNext() && { backgroundColor: Colors.gray3 }]}
            onPress={() => { if (canNext()) { vib(); setStep(STEPS[stepIdx + 1]); } }}
            disabled={!canNext()}
          >
            <Text style={s.nextBtnText}>Tiếp theo →</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[s.nextBtn, placing && { opacity: 0.6 }]} onPress={placeOrder} disabled={placing}>
            {placing ? <ActivityIndicator color="#fff" /> : <Text style={s.nextBtnText}>🎉 Đặt hàng</Text>}
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.md },
  backBtn: { color: '#fff', fontSize: 24, fontWeight: '700' },
  headerTitle: { color: '#fff', fontWeight: '800', fontSize: 16 },
  stepIndicator: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '700' },
  stepBar: { flexDirection: 'row', gap: 6, padding: 10, backgroundColor: '#fff', justifyContent: 'center' },
  stepDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.gray2 },
  stepDotActive: { backgroundColor: Colors.primary, width: 24 },
  stepTitle: { fontWeight: '800', fontSize: 15, marginBottom: 14, color: Colors.text },
  input: { backgroundColor: '#fff', borderRadius: Radius.md, borderWidth: 1.5, borderColor: Colors.border, padding: 12, fontSize: 15, marginBottom: 10 },
  applyBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingHorizontal: 14, justifyContent: 'center' },
  applyBtnText: { color: '#fff', fontWeight: '700' },
  summaryCard: { backgroundColor: '#fff', borderRadius: Radius.lg, padding: 14, ...Shadow.sm, marginBottom: 8 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  summaryItem: { fontSize: 13, color: Colors.text },
  summaryPrice: { fontSize: 13, fontWeight: '700' },
  voucherApplied: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F0FFF4', borderRadius: Radius.md, padding: 10, marginBottom: 12 },
  vCard: { backgroundColor: '#fff', borderRadius: Radius.md, padding: 14, marginBottom: 8, borderWidth: 1.5, borderColor: Colors.border },
  vCardActive: { borderColor: Colors.primary, backgroundColor: '#FFF5F4' },
  vCode: { fontWeight: '900', fontSize: 15, color: Colors.primary },
  vDesc: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
  vMeta: { fontSize: 11, color: Colors.textSub, marginTop: 2 },
  skipBtn: { alignItems: 'center', paddingVertical: 14 },
  skipBtnText: { color: Colors.gray4, fontSize: 13 },
  methodCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, padding: 14, marginBottom: 8, backgroundColor: '#fff' },
  methodCardActive: { borderColor: Colors.primary, backgroundColor: '#FFF5F4' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: Colors.gray3, alignItems: 'center', justifyContent: 'center' },
  radioActive: { borderColor: Colors.primary },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primary },
  methodLabel: { fontSize: 14, fontWeight: '600' },
  confirmCard: { backgroundColor: '#fff', borderRadius: Radius.lg, padding: 16, ...Shadow.sm, marginBottom: 12 },
  confirmRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8, gap: 8 },
  confirmKey: { fontSize: 13, color: Colors.textSub, minWidth: 100 },
  confirmVal: { fontSize: 13, fontWeight: '700', flex: 1, textAlign: 'right' },
  warnCard: { backgroundColor: '#FFF0F0', borderRadius: Radius.md, padding: 14, borderLeftWidth: 3, borderLeftColor: Colors.danger },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#fff', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.md, borderTopWidth: 1, borderTopColor: Colors.border, elevation: 12 },
  totalLabel: { fontWeight: '800', fontSize: 16, color: Colors.text },
  nextBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 13, paddingHorizontal: 24, ...Shadow.sm },
  nextBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
