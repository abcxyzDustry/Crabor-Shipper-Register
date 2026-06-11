// ============================================================
// CRABOR — PayOS Payment Screen
// Tạo link thanh toán PayOS, mở WebView QR, nhận kết quả
// ============================================================
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert,
  ActivityIndicator, Linking, Modal, Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { api } from '../../shared/api';
import { socket } from '../../App';

export default function PayOSPaymentScreen({ navigation, route }) {
  const { order, amount, description, onSuccess } = route.params;
  const [loading, setLoading]       = useState(true);
  const [checkoutUrl, setCheckoutUrl] = useState(null);
  const [orderCode, setOrderCode]   = useState(null);
  const [paymentStatus, setPaymentStatus] = useState('pending'); // pending | paid | cancelled
  const [showWebView, setShowWebView] = useState(false);
  const [checking, setChecking]     = useState(false);
  const checkRef = useRef(null);

  useEffect(() => {
    createPaymentLink();
    setupSocket();
    return () => {
      socket?.off('order_status_update');
      if (checkRef.current) clearInterval(checkRef.current);
    };
  }, []);

  const setupSocket = () => {
    if (!socket) return;
    socket.on('order_status_update', (data) => {
      if (data.orderId === order?.orderId && data.status === 'payment_confirmed') {
        handlePaymentSuccess();
      }
    });
  };

  const createPaymentLink = async () => {
    setLoading(true);
    try {
      const res = await api.post('/api/payment/payos/create', {
        orderId:     order?.orderId || `ORD-${Date.now()}`,
        amount:      Math.round(amount || order?.finalTotal || order?.total || 0),
        description: (description || `Thanh toan DH ${order?.orderId?.slice(-6) || ''}`).slice(0, 25),
        buyerName:   order?.customerName,
      });
      if (res.success) {
        setCheckoutUrl(res.checkoutUrl);
        setOrderCode(res.orderCode);
        setLoading(false);
        // Auto-check mỗi 10 giây
        checkRef.current = setInterval(() => checkPaymentStatus(res.orderCode), 10000);
      }
    } catch (e) {
      setLoading(false);
      Alert.alert('Không tạo được link', e.message, [
        { text: 'Quay lại', onPress: () => navigation.goBack() }
      ]);
    }
  };

  const checkPaymentStatus = async (code) => {
    if (paymentStatus === 'paid') return;
    try {
      const res = await api.get(`/api/payment/payos/${code || orderCode}`);
      if (res.payment?.status === 'PAID') handlePaymentSuccess();
    } catch (_) {}
  };

  const handlePaymentSuccess = () => {
    Vibration.vibrate([0, 300, 100, 300, 100, 500]);
    if (checkRef.current) clearInterval(checkRef.current);
    setPaymentStatus('paid');
    setShowWebView(false);
    Alert.alert('🎉 Thanh toán thành công!',
      `Đơn hàng #${order?.orderId?.slice(-6)} đã được thanh toán.\nThu nhập đang được xử lý.`,
      [{ text: 'Hoàn thành', onPress: () => { onSuccess?.(); navigation.goBack(); } }]
    );
  };

  const handleCancel = async () => {
    Vibration.vibrate(30);
    Alert.alert('Huỷ thanh toán?', 'Link PayOS sẽ bị huỷ. Bạn vẫn có thể thanh toán tiền mặt.', [
      { text: 'Tiếp tục thanh toán', style: 'cancel' },
      {
        text: 'Huỷ giao dịch', style: 'destructive', onPress: async () => {
          try { if (orderCode) await api.delete(`/api/payment/payos/${orderCode}/cancel`); } catch (_) {}
          setPaymentStatus('cancelled');
          setShowWebView(false);
          navigation.goBack();
        }
      }
    ]);
  };

  // Xử lý deep link return từ PayOS
  const handleWebViewNav = (navState) => {
    const url = navState.url || '';
    if (url.includes('/payment/success') || url.includes('status=PAID')) {
      handlePaymentSuccess();
    } else if (url.includes('/payment/cancel') || url.includes('status=CANCELLED')) {
      setPaymentStatus('cancelled');
      setShowWebView(false);
      navigation.goBack();
    }
  };

  const orderAmt = Math.round(amount || order?.finalTotal || order?.total || 0);

  if (loading) return (
    <SafeAreaView style={s.safe}>
      <View style={s.center}>
        <ActivityIndicator color={Colors.primary} size="large" />
        <Text style={s.loadText}>Đang tạo link thanh toán PayOS...</Text>
      </View>
    </SafeAreaView>
  );

  if (paymentStatus === 'paid') return (
    <SafeAreaView style={s.safe}>
      <View style={s.center}>
        <Text style={{ fontSize: 72 }}>✅</Text>
        <Text style={s.successTitle}>Thanh toán thành công!</Text>
        <Text style={s.successSub}>{formatCurrency(orderAmt)}</Text>
      </View>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={handleCancel}>
          <Text style={s.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>💳 Thanh toán PayOS</Text>
        <View style={{ width: 32 }} />
      </View>

      <View style={s.content}>
        {/* Order info */}
        <View style={s.orderCard}>
          <Text style={s.orderLabel}>Đơn hàng</Text>
          <Text style={s.orderValue}>#{order?.orderId?.slice(-6) || '—'}</Text>
          <View style={s.divider} />
          <Text style={s.orderLabel}>Số tiền</Text>
          <Text style={[s.orderValue, { fontSize: 28, color: Colors.primary }]}>{formatCurrency(orderAmt)}</Text>
        </View>

        {/* PayOS badge */}
        <View style={s.payosBadge}>
          <Text style={s.payosBadgeText}>🔒 Thanh toán bảo mật bởi PayOS</Text>
          <Text style={s.payosBadgeSub}>Hỗ trợ tất cả ngân hàng Việt Nam · ATM · QR Code</Text>
        </View>

        {/* CTA */}
        <TouchableOpacity style={s.payBtn} onPress={() => { Vibration.vibrate(30); setShowWebView(true); }}>
          <Text style={s.payBtnText}>🔗 Mở trang thanh toán PayOS</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.checkBtn} onPress={() => { Vibration.vibrate(30); checkPaymentStatus(orderCode); }}
          disabled={checking}>
          {checking
            ? <ActivityIndicator color={Colors.primary} size="small" />
            : <Text style={s.checkBtnText}>🔄 Kiểm tra thanh toán</Text>
          }
        </TouchableOpacity>

        <TouchableOpacity style={s.cancelBtn} onPress={handleCancel}>
          <Text style={s.cancelBtnText}>Huỷ giao dịch</Text>
        </TouchableOpacity>

        <Text style={s.hint}>Sau khi quét QR hoặc chuyển khoản,{'\n'}nhấn "Kiểm tra thanh toán" để xác nhận.</Text>
      </View>

      {/* WebView Modal */}
      <Modal visible={showWebView} animationType="slide" statusBarTranslucent>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={s.wvHeader}>
            <TouchableOpacity onPress={() => setShowWebView(false)} style={{ padding: 8 }}>
              <Text style={{ color: '#fff', fontSize: 22, fontWeight: '700' }}>✕</Text>
            </TouchableOpacity>
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>Thanh toán PayOS</Text>
            <TouchableOpacity onPress={() => checkPaymentStatus(orderCode)} style={{ padding: 8 }}>
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>Kiểm tra</Text>
            </TouchableOpacity>
          </View>
          {checkoutUrl && (
            <WebView
              source={{ uri: checkoutUrl }}
              onNavigationStateChange={handleWebViewNav}
              style={{ flex: 1 }}
              startInLoadingState
              renderLoading={() => <ActivityIndicator color={Colors.primary} size="large" style={{ flex: 1 }} />}
            />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32 },
  loadText: { fontSize: 14, color: Colors.textSub, textAlign: 'center' },
  successTitle: { fontSize: 24, fontWeight: '900', color: Colors.success },
  successSub: { fontSize: 18, fontWeight: '700', color: Colors.text },
  header: { backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.md },
  backBtn: { color: '#fff', fontSize: 24, fontWeight: '700' },
  headerTitle: { color: '#fff', fontWeight: '800', fontSize: 16 },
  content: { flex: 1, padding: Spacing.md },
  orderCard: { backgroundColor: '#fff', borderRadius: Radius.lg, padding: 20, marginBottom: 14, alignItems: 'center', ...Shadow.md },
  orderLabel: { fontSize: 12, color: Colors.textSub, fontWeight: '600' },
  orderValue: { fontSize: 18, fontWeight: '900', color: Colors.text, marginTop: 4, marginBottom: 8 },
  divider: { width: '100%', height: 1, backgroundColor: Colors.border, marginVertical: 8 },
  payosBadge: { backgroundColor: '#EBF5FB', borderRadius: Radius.md, padding: 14, marginBottom: 20, alignItems: 'center' },
  payosBadgeText: { fontSize: 13, fontWeight: '800', color: '#2980B9' },
  payosBadgeSub: { fontSize: 11, color: Colors.textSub, marginTop: 4 },
  payBtn: { backgroundColor: Colors.primary, borderRadius: Radius.lg, paddingVertical: 16, alignItems: 'center', marginBottom: 10, ...Shadow.md },
  payBtnText: { color: '#fff', fontWeight: '900', fontSize: 16 },
  checkBtn: { backgroundColor: '#fff', borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center', marginBottom: 10, borderWidth: 1.5, borderColor: Colors.primary },
  checkBtnText: { color: Colors.primary, fontWeight: '700', fontSize: 14 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12 },
  cancelBtnText: { color: Colors.danger, fontSize: 13, fontWeight: '600' },
  hint: { fontSize: 12, color: Colors.textSub, textAlign: 'center', marginTop: 8, lineHeight: 18 },
  wvHeader: { backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12 },
});
