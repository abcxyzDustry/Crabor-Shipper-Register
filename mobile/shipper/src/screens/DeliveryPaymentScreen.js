// ============================================================
// CRABOR Shipper — Delivery Payment Screen
// Hiện QR SePay khi giao hàng bank_transfer
// Sau khi thanh toán: popup xác nhận → pending 30p → ví
// ============================================================
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert,
  ActivityIndicator, Image, Modal, ScrollView, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { api } from '../../shared/api';
import { socket } from '../../App';

const BANK_NAME    = 'VIB';
const BANK_ACC     = '068394585';
const BANK_HOLDER  = 'CRABOR TECH CO LTD';
const SEPAY_PENDING_MINUTES = 30;

export default function DeliveryPaymentScreen({ navigation, route }) {
  const { order } = route.params;
  const [qrData, setQrData]           = useState(null);
  const [loadingQR, setLoadingQR]     = useState(true);
  const [paymentStatus, setPaymentStatus] = useState('waiting'); // waiting | confirmed | manual_confirmed
  const [confirmModal, setConfirmModal]   = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [pendingCountdown, setPendingCountdown] = useState(null); // giây còn lại
  const countdownRef = useRef(null);

  useEffect(() => {
    generateQR();
    setupSocket();
    return () => {
      socket?.off('sepay_payment_confirmed');
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  const generateQR = async () => {
    try {
      const res = await api.post(`/api/orders/${order.orderId}/delivery-qr`);
      setQrData(res);
    } catch (e) {
      Alert.alert('Lỗi', e.message || 'Không tạo được QR');
    } finally { setLoadingQR(false); }
  };

  const setupSocket = () => {
    if (!socket) return;
    // Nhận xác nhận thanh toán từ SePay webhook
    socket.on('sepay_payment_confirmed', (data) => {
      if (data.orderId === order.orderId) {
        setPaymentStatus('confirmed');
        if (countdownRef.current) clearInterval(countdownRef.current);
        Alert.alert(
          '✅ Khách đã thanh toán!',
          `${formatCurrency(data.amount)} đã được nhận.\nThu nhập sẽ vào ví sau khi admin duyệt (tối đa ${SEPAY_PENDING_MINUTES} phút).`,
          [{ text: 'Hoàn thành', onPress: () => navigation.goBack() }]
        );
      }
    });
  };

  // Shipper bấm "Khách đã thanh toán" thủ công
  const handleManualConfirm = () => {
    setConfirmModal(true);
  };

  const confirmManualPayment = async () => {
    setConfirmLoading(true);
    try {
      await api.post(`/api/orders/${order.orderId}/confirm-payment`, {
        method: 'manual_confirm',
        note: 'Shipper xác nhận khách đã thanh toán',
      });
      setConfirmModal(false);
      setPaymentStatus('manual_confirmed');
      // Bắt đầu countdown 30 phút
      let secs = SEPAY_PENDING_MINUTES * 60;
      setPendingCountdown(secs);
      countdownRef.current = setInterval(() => {
        secs--;
        setPendingCountdown(secs);
        if (secs <= 0) {
          clearInterval(countdownRef.current);
          setPendingCountdown(0);
        }
      }, 1000);
    } catch (e) {
      Alert.alert('Lỗi', e.message);
    } finally { setConfirmLoading(false); }
  };

  const formatCountdown = (secs) => {
    if (secs === null) return '';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const openBankApp = () => {
    // Deep link sang app ngân hàng (VIB)
    Linking.openURL('https://vib.com.vn/dang-nhap').catch(() => {
      Alert.alert('Không mở được app ngân hàng', 'Vui lòng mở thủ công.');
    });
  };

  if (loadingQR) return (
    <SafeAreaView style={s.safe}>
      <ActivityIndicator color={Colors.primary} size="large" style={{ flex: 1 }} />
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={s.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>💳 Thanh toán chuyển khoản</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>

        {/* Order summary */}
        <View style={s.orderCard}>
          <Text style={s.orderCardTitle}>📦 Đơn #{order.orderId?.slice(-6)}</Text>
          <Text style={s.orderCardCustomer}>👤 {order.customerName}</Text>
          <View style={s.totalRow}>
            <Text style={s.totalLabel}>Tổng thanh toán</Text>
            <Text style={s.totalValue}>{formatCurrency(order.finalTotal || order.total)}</Text>
          </View>
        </View>

        {/* Payment status banner */}
        {paymentStatus === 'confirmed' && (
          <View style={[s.statusBanner, { backgroundColor: Colors.success }]}>
            <Text style={s.statusBannerText}>✅ Đã nhận tiền — Thu nhập đang chờ duyệt</Text>
          </View>
        )}
        {paymentStatus === 'manual_confirmed' && (
          <View style={[s.statusBanner, { backgroundColor: Colors.warning }]}>
            <Text style={s.statusBannerText}>
              ⏳ Đang kiểm tra thanh toán
              {pendingCountdown !== null && pendingCountdown > 0
                ? ` — còn ${formatCountdown(pendingCountdown)}`
                : pendingCountdown === 0 ? ' — Đã xong!' : ''}
            </Text>
          </View>
        )}

        {/* QR Code */}
        {qrData?.qrUrl && paymentStatus === 'waiting' && (
          <View style={s.qrCard}>
            <Text style={s.qrTitle}>📲 QR chuyển khoản cho khách quét</Text>
            <Text style={s.qrSub}>Yêu cầu khách mở app ngân hàng và quét mã này</Text>

            <View style={s.qrWrapper}>
              <Image
                source={{ uri: qrData.qrUrl }}
                style={s.qrImage}
                resizeMode="contain"
              />
            </View>

            {/* Bank info */}
            <View style={s.bankInfoCard}>
              <View style={s.bankRow}>
                <Text style={s.bankLabel}>Ngân hàng</Text>
                <Text style={s.bankValue}>{BANK_NAME}</Text>
              </View>
              <View style={s.bankRow}>
                <Text style={s.bankLabel}>Số tài khoản</Text>
                <Text style={[s.bankValue, { color: Colors.primary, fontWeight: '900' }]}>{BANK_ACC}</Text>
              </View>
              <View style={s.bankRow}>
                <Text style={s.bankLabel}>Chủ tài khoản</Text>
                <Text style={s.bankValue}>{BANK_HOLDER}</Text>
              </View>
              <View style={s.bankRow}>
                <Text style={s.bankLabel}>Số tiền</Text>
                <Text style={[s.bankValue, { color: Colors.success, fontWeight: '900', fontSize: 18 }]}>
                  {formatCurrency(order.finalTotal || order.total)}
                </Text>
              </View>
              <View style={[s.bankRow, { borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 8, marginTop: 4 }]}>
                <Text style={s.bankLabel}>Nội dung CK</Text>
                <Text style={[s.bankValue, { color: Colors.primary, fontWeight: '800' }]}>
                  {qrData?.sePayRef || `CRABOR${order.orderId?.slice(-8).toUpperCase()}`}
                </Text>
              </View>
            </View>

            <Text style={s.qrNote}>
              ⚡ Tự động xác nhận khi nhận được chuyển khoản{'\n'}
              Nếu không tự xác nhận sau 2 phút, nhấn "Đã nhận tiền" bên dưới
            </Text>
          </View>
        )}

        {/* Hướng dẫn */}
        {paymentStatus === 'waiting' && (
          <View style={s.guideCard}>
            <Text style={s.guideTitle}>📋 Hướng dẫn</Text>
            {[
              'Đưa màn hình QR để khách quét bằng app ngân hàng bất kỳ',
              `Nhập đúng số tiền: ${formatCurrency(order.finalTotal || order.total)}`,
              `Nhập đúng nội dung: ${qrData?.sePayRef || 'theo mã trên QR'}`,
              'Chờ xác nhận tự động hoặc nhấn "Kiểm tra & Xác nhận" sau khi khách gửi',
            ].map((step, i) => (
              <View key={i} style={s.guideStep}>
                <View style={s.guideNum}><Text style={s.guideNumText}>{i + 1}</Text></View>
                <Text style={s.guideStepText}>{step}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Buttons */}
        {paymentStatus === 'waiting' && (
          <View style={s.btnGroup}>
            <TouchableOpacity style={s.checkBtn} onPress={openBankApp}>
              <Text style={s.checkBtnText}>🏦 Mở app ngân hàng kiểm tra</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.confirmBtn} onPress={handleManualConfirm}>
              <Text style={s.confirmBtnText}>✅ Khách đã thanh toán</Text>
            </TouchableOpacity>
          </View>
        )}

        {paymentStatus === 'manual_confirmed' && (
          <View style={s.btnGroup}>
            <TouchableOpacity
              style={[s.confirmBtn, { backgroundColor: Colors.success }]}
              onPress={() => navigation.goBack()}
            >
              <Text style={s.confirmBtnText}>✅ Hoàn thành giao hàng</Text>
            </TouchableOpacity>
          </View>
        )}

        {paymentStatus === 'confirmed' && (
          <View style={s.btnGroup}>
            <TouchableOpacity
              style={[s.confirmBtn, { backgroundColor: Colors.success }]}
              onPress={() => navigation.goBack()}
            >
              <Text style={s.confirmBtnText}>🎉 Hoàn thành!</Text>
            </TouchableOpacity>
          </View>
        )}

      </ScrollView>

      {/* Confirm Modal */}
      <Modal visible={confirmModal} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={{ fontSize: 48, textAlign: 'center' }}>💳</Text>
            <Text style={s.modalTitle}>Xác nhận khách đã thanh toán?</Text>
            <Text style={s.modalSub}>
              Bạn xác nhận đã nhận được {formatCurrency(order.finalTotal || order.total)} từ khách hàng{'\n'}
              {order.customerName}.{'\n\n'}
              Thu nhập sẽ được đưa vào hàng chờ duyệt trong vòng{' '}
              <Text style={{ fontWeight: '900', color: Colors.primary }}>{SEPAY_PENDING_MINUTES} phút</Text>.
            </Text>
            <View style={s.modalInfo}>
              <Text style={s.modalInfoRow}>📦 Đơn: #{order.orderId?.slice(-6)}</Text>
              <Text style={s.modalInfoRow}>💰 Số tiền: {formatCurrency(order.finalTotal || order.total)}</Text>
              <Text style={s.modalInfoRow}>🏦 Phương thức: Chuyển khoản SePay</Text>
            </View>
            <TouchableOpacity
              style={[s.modalConfirmBtn, confirmLoading && { opacity: 0.6 }]}
              onPress={confirmManualPayment}
              disabled={confirmLoading}
            >
              {confirmLoading
                ? <ActivityIndicator color="#fff" />
                : <Text style={s.modalConfirmBtnText}>✅ Xác nhận đã nhận tiền</Text>
              }
            </TouchableOpacity>
            <TouchableOpacity style={s.modalCancelBtn} onPress={() => setConfirmModal(false)}>
              <Text style={s.modalCancelBtnText}>Chưa nhận, kiểm tra lại</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: {
    backgroundColor: Colors.primary, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', padding: Spacing.lg,
  },
  backBtn: { color: '#fff', fontSize: 24, fontWeight: '700' },
  headerTitle: { color: '#fff', fontWeight: '800', fontSize: 16 },
  orderCard: { backgroundColor: '#fff', margin: Spacing.md, borderRadius: Radius.lg, padding: Spacing.lg, ...Shadow.sm },
  orderCardTitle: { fontWeight: '800', fontSize: 16, marginBottom: 4 },
  orderCardCustomer: { fontSize: 13, color: Colors.textSub, marginBottom: 12 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 10 },
  totalLabel: { fontSize: 14, fontWeight: '700', color: Colors.gray5 },
  totalValue: { fontSize: 22, fontWeight: '900', color: Colors.primary },
  statusBanner: { marginHorizontal: Spacing.md, borderRadius: Radius.md, padding: 12, alignItems: 'center', marginBottom: 8 },
  statusBannerText: { color: '#fff', fontWeight: '800', fontSize: 14, textAlign: 'center' },
  qrCard: {
    backgroundColor: '#fff', margin: Spacing.md, borderRadius: Radius.lg,
    padding: Spacing.lg, alignItems: 'center', ...Shadow.md,
  },
  qrTitle: { fontSize: 16, fontWeight: '800', color: Colors.text, textAlign: 'center' },
  qrSub: { fontSize: 12, color: Colors.textSub, marginTop: 4, marginBottom: 16, textAlign: 'center' },
  qrWrapper: {
    borderWidth: 3, borderColor: Colors.primary, borderRadius: 16,
    padding: 8, backgroundColor: '#fff', marginBottom: 16,
  },
  qrImage: { width: 220, height: 220 },
  bankInfoCard: { width: '100%', backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 14, gap: 8 },
  bankRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  bankLabel: { fontSize: 12, color: Colors.textSub, fontWeight: '600' },
  bankValue: { fontSize: 13, fontWeight: '700', color: Colors.text, textAlign: 'right', flex: 1, marginLeft: 8 },
  qrNote: { fontSize: 11, color: Colors.textSub, textAlign: 'center', marginTop: 12, lineHeight: 18 },
  guideCard: { backgroundColor: '#fff', margin: Spacing.md, borderRadius: Radius.lg, padding: Spacing.lg, ...Shadow.sm },
  guideTitle: { fontWeight: '800', fontSize: 14, marginBottom: 12 },
  guideStep: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 10 },
  guideNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  guideNumText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  guideStepText: { flex: 1, fontSize: 13, color: Colors.text, lineHeight: 20 },
  btnGroup: { paddingHorizontal: Spacing.md, gap: 10 },
  checkBtn: { borderWidth: 1.5, borderColor: Colors.info, borderRadius: Radius.md, paddingVertical: 13, alignItems: 'center' },
  checkBtnText: { color: Colors.info, fontWeight: '700', fontSize: 14 },
  confirmBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center', ...Shadow.sm },
  confirmBtnText: { color: '#fff', fontWeight: '900', fontSize: 15 },
  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 36 },
  modalTitle: { fontSize: 18, fontWeight: '800', textAlign: 'center', marginTop: 8, marginBottom: 8 },
  modalSub: { fontSize: 13, color: Colors.textSub, textAlign: 'center', lineHeight: 20, marginBottom: 16 },
  modalInfo: { backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 14, gap: 6, marginBottom: 20 },
  modalInfoRow: { fontSize: 13, color: Colors.text, fontWeight: '600' },
  modalConfirmBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center', marginBottom: 10 },
  modalConfirmBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  modalCancelBtn: { alignItems: 'center', paddingVertical: 10 },
  modalCancelBtnText: { color: Colors.gray4, fontSize: 13 },
});
