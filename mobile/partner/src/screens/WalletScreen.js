// ============================================================
// Partner Wallet Screen — Ví CRABOR đầy đủ
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator, Alert, TextInput,
  Modal, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Colors, Spacing, Radius, Shadow,
  formatCurrency, formatDateTime,
} from '../../shared/theme';
import { api } from '../../shared/api';

const { width: W } = Dimensions.get('window');
const getMsg = (e) => e?.message || e?.data?.message || e?.error || 'Đã có lỗi xảy ra';

const METHOD_LABELS = {
  cash:     { label: 'Tiền mặt',      icon: '💵', color: '#27AE60' },
  transfer: { label: 'Chuyển khoản',  icon: '🏦', color: '#3498DB' },
  wallet:   { label: 'Ví CRABOR',     icon: '💳', color: '#9B59B6' },
};

export default function WalletScreen({ navigation }) {
  const [wallet, setWallet]     = useState(null);
  const [pmStats, setPmStats]   = useState(null);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Withdraw modal
  const [wdModal, setWdModal]   = useState(false);
  const [wdAmount, setWdAmount] = useState('');
  const [wdBank, setWdBank]     = useState('');
  const [wdAcc, setWdAcc]       = useState('');
  const [wdOwner, setWdOwner]   = useState('');
  const [wdLoading, setWdLoading] = useState(false);

  // Pay fee modal
  const [feeModal, setFeeModal] = useState(false);
  const [feeLoading, setFeeLoading] = useState(false);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    const [w, pm] = await Promise.allSettled([
      api.get('/api/partner/wallet'),
      api.get('/api/partner/stats/payment-methods'),
    ]);
    if (w.status === 'fulfilled') {
      const data = w.value.wallet || w.value;
      setWallet(data);
      setWdBank(data.bankName || '');
      setWdAcc(data.bankAccount || '');
      setWdOwner(data.bankOwner || '');
    }
    if (pm.status === 'fulfilled') setPmStats(pm.value);
    setLoading(false); setRefreshing(false);
  };

  const handleWithdraw = async () => {
    const amt = Number(wdAmount);
    if (!amt || amt < 50000) return Alert.alert('Lỗi', 'Số tiền rút tối thiểu 50,000đ');
    if (amt > (wallet?.balance || 0)) return Alert.alert('Lỗi', 'Số dư không đủ');
    if (!wdBank || !wdAcc || !wdOwner) return Alert.alert('Lỗi', 'Nhập đầy đủ thông tin ngân hàng');
    setWdLoading(true);
    try {
      await api.post('/api/partner/wallet/withdraw', {
        amount: amt, bankName: wdBank, bankAccount: wdAcc, bankOwner: wdOwner,
      });
      Alert.alert('✅ Thành công', 'Yêu cầu rút tiền đã gửi. Xử lý trong 24h.');
      setWdModal(false); setWdAmount('');
      loadAll();
    } catch (e) { Alert.alert('Lỗi', getMsg(e)); }
    finally { setWdLoading(false); }
  };

  const handlePayFeeByWallet = async () => {
    setFeeLoading(true);
    try {
      const res = await api.post('/api/partner/fee/pay-wallet');
      Alert.alert('✅ Thanh toán thành công!',
        `Đã thanh toán ${formatCurrency(res.feeAmount)} từ ví CRABOR.`);
      setFeeModal(false);
      loadAll();
    } catch (e) { Alert.alert('Lỗi', getMsg(e)); }
    finally { setFeeLoading(false); }
  };

  if (loading) return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.backTxt}>←</Text></TouchableOpacity>
        <Text style={s.headerTitle}>💳 Ví CRABOR</Text>
        <View style={{ width: 40 }} />
      </View>
      <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} />
    </SafeAreaView>
  );

  const balance     = wallet?.balance || 0;
  const totalEarned = wallet?.totalEarned || 0;
  const feeAmount   = wallet?.weeklyFeeAmount || 0;
  const feeStatus   = wallet?.weeklyFeeStatus || 'pending';
  const canPayFee   = feeStatus === 'pending' && feeAmount > 0 && balance >= feeAmount;
  const txs         = wallet?.transactions || [];
  const pmData      = pmStats?.stats || {};
  const totalOrders = pmStats?.totalOrders || 0;
  const totalToWallet = pmStats?.totalToWallet || 0;

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.backTxt}>←</Text></TouchableOpacity>
        <Text style={s.headerTitle}>💳 Ví CRABOR</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); loadAll(); }} tintColor={Colors.primary} />}
      >
        {/* ── Balance card ── */}
        <View style={s.balCard}>
          <Text style={s.balLabel}>Số dư ví CRABOR</Text>
          <Text style={s.balAmount}>{formatCurrency(balance)}</Text>
          <View style={s.balStats}>
            <View style={s.balStat}>
              <Text style={s.balStatVal}>{formatCurrency(totalEarned)}</Text>
              <Text style={s.balStatLbl}>Tổng tích luỹ</Text>
            </View>
            <View style={s.balDiv} />
            <View style={s.balStat}>
              <Text style={[s.balStatVal, { color: Colors.warning }]}>{formatCurrency(totalToWallet)}</Text>
              <Text style={s.balStatLbl}>Từ CK/Ví KH</Text>
            </View>
          </View>

          {/* Action buttons */}
          <View style={s.actionRow}>
            <TouchableOpacity style={s.actionBtn} onPress={() => setWdModal(true)}>
              <Text style={s.actionIco}>💸</Text>
              <Text style={s.actionLbl}>Rút tiền</Text>
            </TouchableOpacity>
            {canPayFee && (
              <TouchableOpacity style={[s.actionBtn, { backgroundColor: 'rgba(255,255,255,0.25)' }]}
                onPress={() => setFeeModal(true)}>
                <Text style={s.actionIco}>💳</Text>
                <Text style={s.actionLbl}>Trả phí</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* ── Fee status ── */}
        {feeAmount > 0 && (
          <View style={[s.feeAlert,
            feeStatus === 'paid' && { borderColor: Colors.success },
            feeStatus === 'overdue' && { borderColor: Colors.danger }]}>
            <Text style={s.feeAlertIco}>
              {feeStatus === 'paid' ? '✅' : feeStatus === 'overdue' ? '🚫' : '⏳'}
            </Text>
            <View style={{ flex: 1 }}>
              <Text style={s.feeAlertTitle}>
                {feeStatus === 'paid' ? 'Phí tuần đã thanh toán'
                  : feeStatus === 'overdue' ? 'Phí quá hạn — TK bị khoá'
                  : `Phí tuần cần thanh toán: ${formatCurrency(feeAmount)}`}
              </Text>
              {feeStatus !== 'paid' && (
                <Text style={s.feeAlertSub}>
                  {balance >= feeAmount
                    ? `Số dư đủ — nhấn "Trả phí" để thanh toán ngay`
                    : `Thiếu ${formatCurrency(feeAmount - balance)} — cần thêm thu nhập`}
                </Text>
              )}
            </View>
          </View>
        )}

        {/* ── Payment method stats ── */}
        <View style={s.pmCard}>
          <Text style={s.pmTitle}>📊 Phương thức thanh toán ({totalOrders} đơn)</Text>
          <Text style={s.pmSub}>Thu nhập từ tất cả phương thức đều quy về ví CRABOR</Text>
          {Object.entries(METHOD_LABELS).map(([key, meta]) => {
            const d = pmData[key] || { count: 0, amount: 0 };
            const pct = totalOrders > 0 ? Math.round(d.count / totalOrders * 100) : 0;
            return (
              <View key={key} style={s.pmRow}>
                <View style={[s.pmDot, { backgroundColor: meta.color }]} />
                <View style={{ flex: 1 }}>
                  <View style={s.pmRowTop}>
                    <Text style={s.pmLabel}>{meta.icon} {meta.label}</Text>
                    <Text style={s.pmAmount}>{formatCurrency(d.amount)}</Text>
                  </View>
                  <View style={s.pmBarBg}>
                    <View style={[s.pmBarFill, { width: `${pct}%`, backgroundColor: meta.color }]} />
                  </View>
                  <Text style={s.pmCount}>{d.count} đơn ({pct}%)</Text>
                </View>
              </View>
            );
          })}
          <View style={s.pmTotalRow}>
            <Text style={s.pmTotalLabel}>Tổng thu nhập (sau phí)</Text>
            <Text style={s.pmTotalVal}>{formatCurrency(
              Object.values(pmData).reduce((s, d) => s + (d.amount || 0), 0)
            )}</Text>
          </View>
        </View>

        {/* ── Bank info ── */}
        {wallet?.bankName && (
          <View style={s.bankCard}>
            <Text style={s.bankTitle}>🏦 Tài khoản ngân hàng</Text>
            {[
              ['Ngân hàng', wallet.bankName],
              ['Số TK', wallet.bankAccount],
              ['Chủ TK', wallet.bankOwner],
            ].map(([lbl, val], i) => (
              <View key={i} style={s.bankRow}>
                <Text style={s.bankLbl}>{lbl}</Text>
                <Text style={s.bankVal}>{val}</Text>
              </View>
            ))}
            <TouchableOpacity style={s.editBankBtn} onPress={() => setWdModal(true)}>
              <Text style={s.editBankTxt}>✏️ Cập nhật TK ngân hàng</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Transactions ── */}
        <View style={s.txCard}>
          <Text style={s.txTitle}>📋 Lịch sử giao dịch</Text>
          {txs.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 24 }}>
              <Text style={{ fontSize: 36 }}>💳</Text>
              <Text style={{ color: Colors.gray4, marginTop: 8, fontSize: 13 }}>Chưa có giao dịch</Text>
            </View>
          ) : txs.map((tx, i) => (
            <View key={i} style={s.txRow}>
              <View style={s.txIcon}>
                <Text style={{ fontSize: 18 }}>
                  {tx.type === 'credit' ? '💰' : tx.type === 'withdraw' ? '💸' : tx.type === 'fee' ? '📋' : '🔄'}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.txNote}>{tx.note || 'Giao dịch'}</Text>
                <Text style={s.txDate}>{formatDateTime(tx.createdAt)}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[s.txAmt, { color: tx.type === 'credit' ? Colors.success : Colors.danger }]}>
                  {tx.type === 'credit' ? '+' : '-'}{formatCurrency(Math.abs(tx.amount))}
                </Text>
                <Text style={s.txBal}>{formatCurrency(tx.balance || 0)}</Text>
              </View>
            </View>
          ))}
        </View>
        <View style={{ height: 32 }} />
      </ScrollView>

      {/* ── Withdraw Modal ── */}
      <Modal visible={wdModal} transparent animationType="slide">
        <View style={s.overlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>💸 Rút tiền</Text>
            <Text style={s.modalSub}>
              Số dư: <Text style={{ fontWeight: '900', color: Colors.primary }}>{formatCurrency(balance)}</Text>
            </Text>

            <Text style={s.fieldLbl}>Số tiền rút</Text>
            <TextInput style={s.input} placeholder="VD: 500000"
              keyboardType="numeric" value={wdAmount} onChangeText={setWdAmount} />
            <View style={s.quickRow}>
              {[100000, 200000, 500000, 1000000].map(a => (
                <TouchableOpacity key={a} style={s.quickBtn} onPress={() => setWdAmount(String(a))}>
                  <Text style={s.quickTxt}>{formatCurrency(a)}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={s.sectionLbl}>🏦 Tài khoản nhận</Text>
            <TextInput style={s.input} placeholder="Tên ngân hàng (VD: Vietcombank)"
              value={wdBank} onChangeText={setWdBank} />
            <TextInput style={s.input} placeholder="Số tài khoản"
              keyboardType="numeric" value={wdAcc} onChangeText={setWdAcc} />
            <TextInput style={s.input} placeholder="Tên chủ tài khoản (IN HOA)"
              autoCapitalize="characters" value={wdOwner} onChangeText={setWdOwner} />

            <TouchableOpacity style={[s.confirmBtn, wdLoading && { opacity: 0.6 }]}
              onPress={handleWithdraw} disabled={wdLoading}>
              {wdLoading ? <ActivityIndicator color="#fff" />
                : <Text style={s.confirmTxt}>Xác nhận rút tiền</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setWdModal(false)}>
              <Text style={s.cancelTxt}>Huỷ</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Pay Fee by Wallet Modal ── */}
      <Modal visible={feeModal} transparent animationType="slide">
        <View style={s.overlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>💳 Thanh toán phí bằng ví</Text>
            <View style={s.feePayRow}>
              <Text style={s.feePayLabel}>Phí cần thanh toán</Text>
              <Text style={[s.feePayVal, { color: Colors.danger }]}>{formatCurrency(feeAmount)}</Text>
            </View>
            <View style={s.feePayRow}>
              <Text style={s.feePayLabel}>Số dư hiện tại</Text>
              <Text style={[s.feePayVal, { color: Colors.success }]}>{formatCurrency(balance)}</Text>
            </View>
            <View style={[s.feePayRow, { borderBottomWidth: 0 }]}>
              <Text style={s.feePayLabel}>Còn lại sau khi trả</Text>
              <Text style={s.feePayVal}>{formatCurrency(balance - feeAmount)}</Text>
            </View>
            <TouchableOpacity style={[s.confirmBtn, { marginTop: 20 }, feeLoading && { opacity: 0.6 }]}
              onPress={handlePayFeeByWallet} disabled={feeLoading}>
              {feeLoading ? <ActivityIndicator color="#fff" />
                : <Text style={s.confirmTxt}>✅ Xác nhận thanh toán</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setFeeModal(false)}>
              <Text style={s.cancelTxt}>Huỷ</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.lg },
  backTxt: { color: '#fff', fontSize: 24, fontWeight: '700' },
  headerTitle: { fontSize: 18, fontWeight: '800', color: '#fff' },
  // Balance
  balCard: { margin: Spacing.md, backgroundColor: Colors.primary, borderRadius: Radius.xl, padding: 24, ...Shadow.lg },
  balLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: '700' },
  balAmount: { color: '#fff', fontSize: 34, fontWeight: '900', marginVertical: 6 },
  balStats: { flexDirection: 'row', marginTop: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)' },
  balStat: { flex: 1, alignItems: 'center' },
  balStatVal: { fontSize: 14, fontWeight: '800', color: '#fff' },
  balStatLbl: { fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 2 },
  balDiv: { width: 1, backgroundColor: 'rgba(255,255,255,0.3)' },
  actionRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  actionBtn: { flex: 1, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: Radius.md, paddingVertical: 12, alignItems: 'center', gap: 4 },
  actionIco: { fontSize: 22 },
  actionLbl: { color: '#fff', fontSize: 12, fontWeight: '800' },
  // Fee alert
  feeAlert: { marginHorizontal: Spacing.md, marginBottom: Spacing.md, backgroundColor: '#fff', borderRadius: Radius.md, borderWidth: 2, borderColor: Colors.warning, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, ...Shadow.sm },
  feeAlertIco: { fontSize: 24 },
  feeAlertTitle: { fontSize: 13, fontWeight: '800', color: Colors.text },
  feeAlertSub: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
  // Payment methods
  pmCard: { marginHorizontal: Spacing.md, marginBottom: Spacing.md, backgroundColor: '#fff', borderRadius: Radius.lg, padding: Spacing.lg, ...Shadow.sm },
  pmTitle: { fontWeight: '800', fontSize: 15, marginBottom: 4 },
  pmSub: { fontSize: 11, color: Colors.textSub, marginBottom: 14, lineHeight: 16 },
  pmRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 14 },
  pmDot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
  pmRowTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  pmLabel: { fontSize: 13, fontWeight: '700', color: Colors.text },
  pmAmount: { fontSize: 13, fontWeight: '800', color: Colors.text },
  pmBarBg: { height: 6, backgroundColor: Colors.gray2, borderRadius: 3, marginBottom: 4, overflow: 'hidden' },
  pmBarFill: { height: '100%', borderRadius: 3 },
  pmCount: { fontSize: 11, color: Colors.textSub },
  pmTotalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.border, marginTop: 4 },
  pmTotalLabel: { fontSize: 14, fontWeight: '800', color: Colors.text },
  pmTotalVal: { fontSize: 16, fontWeight: '900', color: Colors.success },
  // Bank
  bankCard: { marginHorizontal: Spacing.md, marginBottom: Spacing.md, backgroundColor: '#fff', borderRadius: Radius.lg, padding: Spacing.lg, ...Shadow.sm },
  bankTitle: { fontWeight: '800', fontSize: 15, marginBottom: 12 },
  bankRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.border },
  bankLbl: { fontSize: 13, color: Colors.textSub, fontWeight: '600' },
  bankVal: { fontSize: 13, fontWeight: '700', color: Colors.text },
  editBankBtn: { marginTop: 12, alignItems: 'center' },
  editBankTxt: { color: Colors.primary, fontWeight: '700', fontSize: 13 },
  // Transactions
  txCard: { marginHorizontal: Spacing.md, marginBottom: Spacing.md, backgroundColor: '#fff', borderRadius: Radius.lg, padding: Spacing.lg, ...Shadow.sm },
  txTitle: { fontWeight: '800', fontSize: 15, marginBottom: 12 },
  txRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.border },
  txIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.gray1, alignItems: 'center', justifyContent: 'center' },
  txNote: { fontSize: 13, fontWeight: '700', color: Colors.text },
  txDate: { fontSize: 11, color: Colors.textSub, marginTop: 2 },
  txAmt: { fontSize: 14, fontWeight: '900' },
  txBal: { fontSize: 11, color: Colors.textSub, marginTop: 2 },
  // Modal
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '85%' },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: 4 },
  modalSub: { fontSize: 13, color: Colors.textSub, marginBottom: 16 },
  sectionLbl: { fontSize: 13, fontWeight: '800', color: Colors.gray5, marginBottom: 8, marginTop: 4 },
  fieldLbl: { fontSize: 12, fontWeight: '700', color: Colors.gray5, marginBottom: 6 },
  input: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15, marginBottom: 10, color: Colors.text },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  quickBtn: { borderWidth: 1.5, borderColor: Colors.primary, borderRadius: Radius.md, paddingHorizontal: 10, paddingVertical: 6 },
  quickTxt: { fontSize: 12, fontWeight: '700', color: Colors.primary },
  feePayRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.border },
  feePayLabel: { fontSize: 14, color: Colors.textSub, fontWeight: '600' },
  feePayVal: { fontSize: 15, fontWeight: '800', color: Colors.text },
  confirmBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center' },
  confirmTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  cancelTxt: { color: Colors.gray4, fontSize: 14 },
});
