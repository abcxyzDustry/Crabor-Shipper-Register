// ============================================================
// CRABOR — Wallet Topup Screen
// Nạp tiền vào ví CRABOR qua SePay hoặc PayOS
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert,
  ActivityIndicator, TextInput, ScrollView, Modal, Image,
  Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { playSuccessSound } from '../../shared/useNotificationSound';
import { socket } from '../../App';

const QUICK_AMOUNTS = [50000, 100000, 200000, 500000, 1000000, 2000000];
const BANK_NAME    = 'VIB';
const BANK_ACC     = '068394585';
const BANK_HOLDER  = 'CRABOR TECH CO LTD';

export default function WalletTopupScreen({ navigation }) {
  const { user, setUser } = useAuth();
  const [amount, setAmount]       = useState('');
  const [method, setMethod]       = useState('sepay');
  const [loading, setLoading]     = useState(false);
  const [qrData, setQrData]       = useState(null);
  const [showWebView, setShowWebView] = useState(false);
  const [checking, setChecking]   = useState(false);
  const [orderCode, setOrderCode] = useState(null);

  useEffect(() => {
    if (!socket) return;
    socket.on('wallet_topup_success', (data) => {
      playSuccessSound();
      Alert.alert('💰 Nạp tiền thành công!',
        `+${data.amount?.toLocaleString('vi-VN')}đ\nSố dư mới: ${data.newBalance?.toLocaleString('vi-VN')}đ`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    });
    return () => socket.off('wallet_topup_success');
  }, []);

  const vib = () => Vibration.vibrate(30);

  const prepare = async () => {
    vib();
    const amt = parseInt(amount.replace(/\D/g, ''));
    if (!amt || amt < 10000) return Alert.alert('Lỗi', 'Nhập số tiền tối thiểu 10,000đ');
    setLoading(true);
    try {
      const res = await api.post('/api/wallet/topup/prepare', { amount: amt, method });
      if (method === 'payos') {
        setOrderCode(res.orderCode);
        setQrData(res);
        setShowWebView(true);
      } else {
        setQrData(res);
      }
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setLoading(false); }
  };

  const checkPayment = async () => {
    vib();
    if (!orderCode && method === 'payos') return Alert.alert('Chưa tạo giao dịch', 'Nhấn "Tạo QR" trước');
    setChecking(true);
    try {
      if (method === 'payos') {
        const res = await api.post('/api/wallet/topup/check', { orderCode });
        if (res.paid) {
          playSuccessSound();
          Alert.alert('✅ Đã nạp tiền!', `+${res.amount?.toLocaleString('vi-VN')}đ vào ví CRABOR!`, [
            { text: 'OK', onPress: () => navigation.goBack() }
          ]);
        } else {
          Alert.alert('Chưa nhận được', 'Giao dịch chưa được xác nhận. Kiểm tra lại sau 1-2 phút.');
        }
      } else {
        // SePay — nhắc người dùng đã chuyển chưa
        Alert.alert('Kiểm tra SePay', 'Nếu bạn đã chuyển khoản đúng nội dung, số dư sẽ được cộng tự động trong vòng 1-2 phút.');
      }
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setChecking(false); }
  };

  const handleWebViewNav = (navState) => {
    const url = navState.url || '';
    if (url.includes('type=topup') && url.includes('success')) {
      setShowWebView(false);
      checkPayment();
    } else if (url.includes('cancel')) {
      setShowWebView(false);
    }
  };

  const amtInt = parseInt(amount.replace(/\D/g, '')) || 0;

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => { vib(); navigation.goBack(); }}>
          <Text style={s.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>💳 Nạp tiền ví CRABOR</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 40 }}>
        {/* Số dư hiện tại */}
        <View style={s.balanceCard}>
          <Text style={s.balanceLabel}>Số dư hiện tại</Text>
          <Text style={s.balanceVal}>{formatCurrency(user?.walletBalance || 0)}</Text>
        </View>

        {/* Nhập số tiền */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>💰 Số tiền nạp</Text>
          <TextInput
            style={s.amountInput}
            placeholder="Nhập số tiền..."
            keyboardType="numeric"
            value={amount}
            onChangeText={setAmount}
          />
          {amtInt > 0 && (
            <Text style={s.amountPreview}>{formatCurrency(amtInt)}</Text>
          )}
          <View style={s.quickRow}>
            {QUICK_AMOUNTS.map(a => (
              <TouchableOpacity key={a} style={s.quickChip}
                onPress={() => { vib(); setAmount(String(a)); }}>
                <Text style={s.quickChipText}>{a >= 1000000 ? `${a/1000000}tr` : `${a/1000}k`}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Phương thức */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>🏦 Phương thức nạp</Text>
          {[
            { id: 'sepay', icon: '📲', label: 'SePay QR — VIB', sub: 'Quét QR chuyển khoản ngân hàng' },
            { id: 'payos', icon: '🔗', label: 'PayOS — Link thanh toán', sub: 'Hỗ trợ ATM, Momo, ZaloPay...' },
          ].map(m => (
            <TouchableOpacity key={m.id} style={[s.methodCard, method === m.id && s.methodCardActive]}
              onPress={() => { vib(); setMethod(m.id); setQrData(null); }}>
              <View style={[s.radio, method === m.id && s.radioActive]}>
                {method === m.id && <View style={s.radioInner} />}
              </View>
              <Text style={{ fontSize: 22 }}>{m.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.methodLabel}>{m.label}</Text>
                <Text style={s.methodSub}>{m.sub}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {/* QR / Bank info */}
        {qrData && method === 'sepay' && (
          <View style={s.qrCard}>
            <Text style={s.qrTitle}>📲 Quét QR để chuyển khoản</Text>
            <Image source={{ uri: qrData.qrUrl }} style={s.qrImage} resizeMode="contain" />
            <View style={s.bankInfo}>
              {[
                ['Ngân hàng', BANK_NAME],
                ['Số tài khoản', BANK_ACC],
                ['Chủ tài khoản', BANK_HOLDER],
                ['Số tiền', formatCurrency(amtInt)],
                ['Nội dung CK', qrData.sePayRef],
              ].map(([k, v]) => (
                <View key={k} style={s.bankRow}>
                  <Text style={s.bankKey}>{k}</Text>
                  <Text style={[s.bankVal, k === 'Nội dung CK' && { color: Colors.primary, fontWeight: '900' }]}>{v}</Text>
                </View>
              ))}
            </View>
            <Text style={s.qrNote}>⚡ Tự động xác nhận sau khi chuyển khoản thành công</Text>
          </View>
        )}

        {/* Buttons */}
        {!qrData ? (
          <TouchableOpacity style={[s.mainBtn, loading && { opacity: 0.6 }]} onPress={prepare} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.mainBtnText}>Tạo QR / Link nạp tiền →</Text>}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[s.checkBtn, checking && { opacity: 0.6 }]} onPress={checkPayment} disabled={checking}>
            {checking ? <ActivityIndicator color={Colors.primary} size="small" /> : <Text style={s.checkBtnText}>🔄 Kiểm tra đã nạp chưa</Text>}
          </TouchableOpacity>
        )}

        <View style={s.infoCard}>
          <Text style={s.infoText}>✅ Số dư cộng ngay sau khi xác nhận thanh toán</Text>
          <Text style={s.infoText}>⏱ SePay tự động trong 1-2 phút</Text>
          <Text style={s.infoText}>📞 Hỗ trợ: support@crabor.vn</Text>
        </View>
      </ScrollView>

      {/* PayOS WebView */}
      <Modal visible={showWebView} animationType="slide">
        <SafeAreaView style={{ flex: 1 }}>
          <View style={{ backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12 }}>
            <TouchableOpacity onPress={() => setShowWebView(false)}>
              <Text style={{ color: '#fff', fontSize: 22, fontWeight: '700' }}>✕</Text>
            </TouchableOpacity>
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>Thanh toán PayOS</Text>
            <TouchableOpacity onPress={() => { setShowWebView(false); checkPayment(); }}>
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Đã thanh toán</Text>
            </TouchableOpacity>
          </View>
          {qrData?.checkoutUrl && (
            <WebView source={{ uri: qrData.checkoutUrl }} onNavigationStateChange={handleWebViewNav}
              startInLoadingState renderLoading={() => <ActivityIndicator color={Colors.primary} size="large" style={{ flex: 1 }} />} />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.md },
  backBtn: { color: '#fff', fontSize: 24, fontWeight: '700' },
  headerTitle: { color: '#fff', fontWeight: '800', fontSize: 16 },
  balanceCard: { backgroundColor: Colors.primary, borderRadius: Radius.lg, padding: 20, alignItems: 'center', marginBottom: 14, ...Shadow.md },
  balanceLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '600' },
  balanceVal: { color: '#fff', fontSize: 28, fontWeight: '900', marginTop: 4 },
  section: { backgroundColor: '#fff', borderRadius: Radius.lg, padding: Spacing.md, marginBottom: 12, ...Shadow.sm },
  sectionTitle: { fontWeight: '800', fontSize: 14, marginBottom: 12 },
  amountInput: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, padding: 12, fontSize: 18, fontWeight: '700', marginBottom: 6 },
  amountPreview: { fontSize: 13, color: Colors.primary, fontWeight: '700', marginBottom: 10 },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  quickChip: { backgroundColor: Colors.gray1, borderRadius: Radius.full, paddingHorizontal: 14, paddingVertical: 7, borderWidth: 1.5, borderColor: Colors.border },
  quickChipText: { fontSize: 13, fontWeight: '700', color: Colors.text },
  methodCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, padding: 14, marginBottom: 8 },
  methodCardActive: { borderColor: Colors.primary, backgroundColor: '#FFF5F4' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: Colors.gray3, alignItems: 'center', justifyContent: 'center' },
  radioActive: { borderColor: Colors.primary },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primary },
  methodLabel: { fontWeight: '700', fontSize: 14 },
  methodSub: { fontSize: 11, color: Colors.textSub, marginTop: 2 },
  qrCard: { backgroundColor: '#fff', borderRadius: Radius.lg, padding: Spacing.md, marginBottom: 12, alignItems: 'center', ...Shadow.md },
  qrTitle: { fontWeight: '800', fontSize: 14, marginBottom: 12 },
  qrImage: { width: 220, height: 220, borderWidth: 3, borderColor: Colors.primary, borderRadius: 12, marginBottom: 16 },
  bankInfo: { width: '100%', backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 12, gap: 6 },
  bankRow: { flexDirection: 'row', justifyContent: 'space-between' },
  bankKey: { fontSize: 12, color: Colors.textSub },
  bankVal: { fontSize: 12, fontWeight: '700', color: Colors.text },
  qrNote: { fontSize: 11, color: Colors.textSub, marginTop: 10, textAlign: 'center' },
  mainBtn: { backgroundColor: Colors.primary, borderRadius: Radius.lg, paddingVertical: 16, alignItems: 'center', marginBottom: 10, ...Shadow.md },
  mainBtnText: { color: '#fff', fontWeight: '900', fontSize: 16 },
  checkBtn: { backgroundColor: '#fff', borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center', marginBottom: 10, borderWidth: 1.5, borderColor: Colors.primary },
  checkBtnText: { color: Colors.primary, fontWeight: '700', fontSize: 14 },
  infoCard: { backgroundColor: Colors.cream, borderRadius: Radius.md, padding: 14, gap: 6, borderLeftWidth: 3, borderLeftColor: Colors.primary },
  infoText: { fontSize: 12, color: Colors.textSub },
});
