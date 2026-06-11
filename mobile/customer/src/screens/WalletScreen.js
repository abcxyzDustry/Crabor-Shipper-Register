// ============================================================
// Customer Wallet Screen — Ví CRABOR, BNPL, Vay nhanh
// ============================================================
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Modal, TextInput, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Spacing, Radius, Shadow, formatCurrency, formatDate } from '../../shared/theme';
import { CustomerAPI } from '../../shared/api';

const TABS = ['wallet', 'bnpl', 'loan'];
const TAB_LABELS = { wallet: '💳 Ví tiền', bnpl: '🛒 Trả sau', loan: '💵 Vay nhanh' };

export default function WalletScreen({ navigation }) {
  const [tab, setTab] = useState('wallet');
  const [wallet, setWallet] = useState(null);
  const [bnpl, setBnpl] = useState(null);
  const [bnplElig, setBnplElig] = useState(null);
  const [loans, setLoans] = useState([]);
  const [loanElig, setLoanElig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [withdrawModal, setWithdrawModal] = useState(false);
  const [withdrawForm, setWithdrawForm] = useState({ amount: '', bankName: '', accountNo: '', accountName: '' });
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [loanModal, setLoanModal] = useState(false);
  const [loanForm, setLoanForm] = useState({ amount: '', reason: '' });
  const [loanLoading, setLoanLoading] = useState(false);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    try {
      const [w, bs, be, le, ls] = await Promise.allSettled([
        CustomerAPI.getWallet(),
        CustomerAPI.getBNPLSummary(),
        CustomerAPI.getBNPLEligibility(),
        CustomerAPI.getLoanEligibility(),
        CustomerAPI.getMyLoans(),
      ]);
      if (w.status === 'fulfilled') setWallet(w.value);
      if (bs.status === 'fulfilled') setBnpl(bs.value);
      if (be.status === 'fulfilled') setBnplElig(be.value);
      if (le.status === 'fulfilled') setLoanElig(le.value);
      if (ls.status === 'fulfilled') setLoans(ls.value?.loans || ls.value || []);
    } catch (e) {}
    finally { setLoading(false); setRefreshing(false); }
  };

  const handleWithdraw = async () => {
    const { amount, bankName, accountNo, accountName } = withdrawForm;
    if (!amount || !bankName || !accountNo || !accountName)
      return Alert.alert('Lỗi', 'Vui lòng điền đầy đủ thông tin');
    if (Number(amount) < 50000) return Alert.alert('Lỗi', 'Rút tối thiểu 50,000đ');
    setWithdrawLoading(true);
    try {
      await CustomerAPI.withdraw({ amount: Number(amount), bankName, accountNo, accountName });
      Alert.alert('✅ Thành công', 'Yêu cầu rút tiền đã được gửi. Xử lý trong 24h.');
      setWithdrawModal(false);
      setWithdrawForm({ amount: '', bankName: '', accountNo: '', accountName: '' });
      loadAll();
    } catch (e) {
      Alert.alert('Lỗi', e.message);
    } finally { setWithdrawLoading(false); }
  };

  const handleLoanApply = async () => {
    const { amount, reason } = loanForm;
    if (!amount || Number(amount) < 100000) return Alert.alert('Lỗi', 'Số tiền vay tối thiểu 100,000đ');
    setLoanLoading(true);
    try {
      await CustomerAPI.applyLoan({ amount: Number(amount), reason });
      Alert.alert('✅ Đã gửi', 'Đơn vay của bạn đang được xem xét. Kết quả trong 24h.');
      setLoanModal(false);
      setLoanForm({ amount: '', reason: '' });
      loadAll();
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setLoanLoading(false); }
  };

  const renderWallet = () => (
    <View>
      {/* Balance card */}
      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Số dư ví</Text>
        <Text style={styles.balanceAmount}>{formatCurrency(wallet?.balance || 0)}</Text>
        <View style={styles.balanceActions}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setWithdrawModal(true)}>
            <Text style={styles.actionBtnText}>⬆️ Rút tiền</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, styles.actionBtnOutline]} onPress={() => navigation.navigate('Orders')}>
            <Text style={[styles.actionBtnText, { color: Colors.white }]}>📦 Đơn hàng</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Transactions */}
      <Text style={styles.subsectionTitle}>Lịch sử giao dịch</Text>
      {wallet?.transactions?.length ? wallet.transactions.map((t, i) => (
        <View key={i} style={styles.txRow}>
          <View>
            <Text style={styles.txDesc}>{t.description || 'Giao dịch'}</Text>
            <Text style={styles.txDate}>{formatDate(t.createdAt)}</Text>
          </View>
          <Text style={[styles.txAmount, { color: t.amount > 0 ? Colors.success : Colors.danger }]}>
            {t.amount > 0 ? '+' : ''}{formatCurrency(t.amount)}
          </Text>
        </View>
      )) : <Text style={styles.empty}>Chưa có giao dịch nào</Text>}
    </View>
  );

  const renderBNPL = () => (
    <View>
      {bnplElig?.eligible ? (
        <View style={styles.eligCard}>
          <Text style={styles.eligIcon}>✅</Text>
          <Text style={styles.eligTitle}>Đủ điều kiện Trả sau</Text>
          <Text style={styles.eligSub}>Hạn mức: {formatCurrency(bnplElig.limit || 0)}</Text>
        </View>
      ) : (
        <View style={styles.eligCard}>
          <Text style={styles.eligIcon}>⏳</Text>
          <Text style={styles.eligTitle}>Chưa đủ điều kiện</Text>
          <Text style={styles.eligSub}>{bnplElig?.reason || 'Đặt thêm đơn hàng để mở khoá tính năng này'}</Text>
        </View>
      )}

      {bnpl?.invoices?.length > 0 && (
        <>
          <Text style={styles.subsectionTitle}>Hoá đơn trả sau</Text>
          {bnpl.invoices.map((inv, i) => (
            <View key={i} style={styles.invoiceCard}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={styles.invoiceId}>#{inv._id?.slice(-6)}</Text>
                <View style={[styles.statusPill, { backgroundColor: inv.paid ? Colors.success : Colors.warning }]}>
                  <Text style={styles.statusPillText}>{inv.paid ? 'Đã trả' : 'Chưa trả'}</Text>
                </View>
              </View>
              <Text style={styles.invoiceAmount}>{formatCurrency(inv.amount)}</Text>
              <Text style={styles.invoiceDue}>Hạn: {formatDate(inv.dueDate)}</Text>
            </View>
          ))}
        </>
      )}
    </View>
  );

  const renderLoan = () => (
    <View>
      {loanElig?.eligible ? (
        <View style={styles.eligCard}>
          <Text style={styles.eligIcon}>💵</Text>
          <Text style={styles.eligTitle}>Bạn có thể vay nhanh!</Text>
          <Text style={styles.eligSub}>Tối đa: {formatCurrency(loanElig.maxAmount || 0)}</Text>
          <TouchableOpacity style={styles.applyBtn} onPress={() => setLoanModal(true)}>
            <Text style={styles.applyBtnText}>Đăng ký vay ngay</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.eligCard}>
          <Text style={styles.eligIcon}>🔒</Text>
          <Text style={styles.eligTitle}>Chưa đủ điều kiện</Text>
          <Text style={styles.eligSub}>{loanElig?.reason || 'Sử dụng CRABOR thường xuyên hơn để mở khoá'}</Text>
        </View>
      )}

      {loans.length > 0 && (
        <>
          <Text style={styles.subsectionTitle}>Lịch sử vay</Text>
          {loans.map((l, i) => (
            <View key={i} style={styles.loanCard}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={styles.loanAmount}>{formatCurrency(l.amount)}</Text>
                <View style={[styles.statusPill, { backgroundColor: l.status === 'approved' ? Colors.success : l.status === 'rejected' ? Colors.danger : Colors.warning }]}>
                  <Text style={styles.statusPillText}>
                    {l.status === 'approved' ? 'Duyệt' : l.status === 'rejected' ? 'Từ chối' : 'Đang xét'}
                  </Text>
                </View>
              </View>
              {l.reason && <Text style={styles.loanReason}>{l.reason}</Text>}
              <Text style={styles.loanDate}>{formatDate(l.createdAt)}</Text>
            </View>
          ))}
        </>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>💳 Tài chính</Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {TABS.map(t => (
          <TouchableOpacity key={t} style={[styles.tabBtn, tab === t && styles.tabBtnActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabBtnText, tab === t && styles.tabBtnTextActive]}>{TAB_LABELS[t]}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} />
      ) : (
        <ScrollView
          style={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadAll(); }} tintColor={Colors.primary} />}
        >
          <View style={{ padding: Spacing.lg }}>
            {tab === 'wallet' && renderWallet()}
            {tab === 'bnpl' && renderBNPL()}
            {tab === 'loan' && renderLoan()}
          </View>
        </ScrollView>
      )}

      {/* Withdraw Modal */}
      <Modal visible={withdrawModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>⬆️ Rút tiền</Text>
            {[
              { key: 'amount', label: 'Số tiền (đ)', placeholder: 'VD: 100000', keyboardType: 'numeric' },
              { key: 'bankName', label: 'Ngân hàng', placeholder: 'VD: Vietcombank' },
              { key: 'accountNo', label: 'Số tài khoản', placeholder: '...' },
              { key: 'accountName', label: 'Tên chủ tài khoản', placeholder: 'NGUYEN VAN A' },
            ].map(f => (
              <View key={f.key} style={{ marginBottom: 12 }}>
                <Text style={styles.fieldLabel}>{f.label}</Text>
                <TextInput
                  style={styles.fieldInput}
                  placeholder={f.placeholder}
                  keyboardType={f.keyboardType || 'default'}
                  value={withdrawForm[f.key]}
                  onChangeText={v => setWithdrawForm(prev => ({ ...prev, [f.key]: v }))}
                  autoCapitalize="characters"
                />
              </View>
            ))}
            <TouchableOpacity style={styles.confirmBtn} onPress={handleWithdraw} disabled={withdrawLoading}>
              {withdrawLoading ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.confirmBtnText}>Xác nhận rút</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setWithdrawModal(false)}>
              <Text style={styles.cancelBtnText}>Huỷ</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Loan Modal */}
      <Modal visible={loanModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>💵 Đăng ký vay</Text>
            <Text style={styles.fieldLabel}>Số tiền vay (đ)</Text>
            <TextInput style={styles.fieldInput} placeholder="VD: 500000" keyboardType="numeric" value={loanForm.amount} onChangeText={v => setLoanForm(p => ({ ...p, amount: v }))} />
            <Text style={styles.fieldLabel}>Lý do vay</Text>
            <TextInput style={[styles.fieldInput, { height: 80, textAlignVertical: 'top' }]} placeholder="Mô tả ngắn lý do..." multiline value={loanForm.reason} onChangeText={v => setLoanForm(p => ({ ...p, reason: v }))} />
            <TouchableOpacity style={styles.confirmBtn} onPress={handleLoanApply} disabled={loanLoading}>
              {loanLoading ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.confirmBtnText}>Gửi đơn vay</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setLoanModal(false)}>
              <Text style={styles.cancelBtnText}>Huỷ</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.lg },
  headerTitle: { fontSize: 20, fontWeight: '800', color: Colors.white },
  tabRow: { flexDirection: 'row', backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  tabBtn: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabBtnActive: { borderBottomWidth: 2.5, borderBottomColor: Colors.primary },
  tabBtnText: { fontSize: 12, fontWeight: '700', color: Colors.gray4 },
  tabBtnTextActive: { color: Colors.primary },
  scroll: { flex: 1 },
  balanceCard: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg, padding: Spacing.xl,
    marginBottom: Spacing.lg, ...Shadow.md,
  },
  balanceLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 13 },
  balanceAmount: { color: Colors.white, fontSize: 32, fontWeight: '900', marginVertical: 8 },
  balanceActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  actionBtn: {
    flex: 1, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: Radius.md,
    paddingVertical: 10, alignItems: 'center',
  },
  actionBtnOutline: { backgroundColor: 'rgba(255,255,255,0.1)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' },
  actionBtnText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  subsectionTitle: { fontWeight: '800', fontSize: 15, color: Colors.text, marginBottom: 12 },
  txRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: Colors.white, borderRadius: Radius.md, padding: 14, marginBottom: 8,
  },
  txDesc: { fontWeight: '600', color: Colors.text, fontSize: 13 },
  txDate: { color: Colors.textLight, fontSize: 11, marginTop: 2 },
  txAmount: { fontWeight: '800', fontSize: 14 },
  empty: { textAlign: 'center', color: Colors.gray4, paddingVertical: 20 },
  eligCard: {
    backgroundColor: Colors.white, borderRadius: Radius.lg, padding: Spacing.xl,
    alignItems: 'center', marginBottom: Spacing.lg, ...Shadow.sm,
  },
  eligIcon: { fontSize: 44, marginBottom: 8 },
  eligTitle: { fontSize: 16, fontWeight: '800', color: Colors.text, textAlign: 'center' },
  eligSub: { fontSize: 13, color: Colors.textSub, textAlign: 'center', marginTop: 6 },
  applyBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 12,
    paddingHorizontal: 32, marginTop: 16,
  },
  applyBtnText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  invoiceCard: {
    backgroundColor: Colors.white, borderRadius: Radius.md, padding: 14, marginBottom: 10, ...Shadow.sm,
  },
  invoiceId: { fontWeight: '700', color: Colors.gray5, fontSize: 13 },
  invoiceAmount: { fontSize: 18, fontWeight: '900', color: Colors.primary, marginTop: 4 },
  invoiceDue: { fontSize: 12, color: Colors.textLight, marginTop: 4 },
  statusPill: { borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  statusPillText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
  loanCard: { backgroundColor: Colors.white, borderRadius: Radius.md, padding: 14, marginBottom: 10, ...Shadow.sm },
  loanAmount: { fontSize: 16, fontWeight: '800', color: Colors.text },
  loanReason: { fontSize: 12, color: Colors.textSub, marginTop: 4 },
  loanDate: { fontSize: 11, color: Colors.textLight, marginTop: 4 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: Colors.white, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24,
  },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: 16 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: Colors.gray5, marginBottom: 6 },
  fieldInput: {
    borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, marginBottom: 4,
  },
  confirmBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.md,
    paddingVertical: 14, alignItems: 'center', marginTop: 8,
  },
  confirmBtnText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12 },
  cancelBtnText: { color: Colors.gray4, fontSize: 14 },
});
