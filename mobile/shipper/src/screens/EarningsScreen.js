// ============================================================
// Shipper Earnings Screen — Ví, Nhiệm vụ, Cấp bậc
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator, Modal, TextInput, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Spacing, Radius, Shadow, formatCurrency, formatDate } from '../../shared/theme';
import { ShipperAPI } from '../../shared/api';

const TIER_CONFIG = {
  bronze:   { label: 'Đồng', icon: '🥉', color: '#CD7F32', next: 'silver' },
  silver:   { label: 'Bạc',  icon: '🥈', color: '#C0C0C0', next: 'gold' },
  gold:     { label: 'Vàng', icon: '🥇', color: '#FFD700', next: 'diamond' },
  diamond:  { label: 'Kim cương', icon: '💎', color: '#B9F2FF', next: null },
};

export default function EarningsScreen() {
  const [wallet, setWallet]   = useState(null);
  const [missions, setMissions] = useState([]);
  const [tier, setTier]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [withdrawModal, setWithdrawModal] = useState(false);
  const [form, setForm]       = useState({ amount: '', bankName: '', accountNo: '', accountName: '' });
  const [submitting, setSubmitting] = useState(false);
  const [tab, setTab] = useState('wallet');

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    const [w, m, t] = await Promise.allSettled([
      ShipperAPI.getWallet(),
      ShipperAPI.getMissions(),
      ShipperAPI.getTier(),
    ]);
    if (w.status === 'fulfilled') setWallet(w.value);
    if (m.status === 'fulfilled') setMissions(m.value?.missions || m.value || []);
    if (t.status === 'fulfilled') setTier(t.value?.tier || t.value);
    setLoading(false); setRefreshing(false);
  };

  const handleWithdraw = async () => {
    const { amount, bankName, accountNo, accountName } = form;
    if (!amount || !bankName || !accountNo || !accountName)
      return Alert.alert('Lỗi', 'Điền đầy đủ thông tin');
    if (Number(amount) < 50000) return Alert.alert('Lỗi', 'Rút tối thiểu 50,000đ');
    setSubmitting(true);
    try {
      await ShipperAPI.withdraw({ amount: Number(amount), bankName, accountNo, accountName });
      Alert.alert('✅ Đã gửi yêu cầu', 'Xử lý trong vòng 24h làm việc.');
      setWithdrawModal(false);
      setForm({ amount: '', bankName: '', accountNo: '', accountName: '' });
      loadAll();
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setSubmitting(false); }
  };

  if (loading) return (
    <SafeAreaView style={s.safe}>
      <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} />
    </SafeAreaView>
  );

  const tierInfo = TIER_CONFIG[tier?.current] || TIER_CONFIG.bronze;

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Text style={s.headerTitle}>💰 Thu nhập</Text>
      </View>

      {/* Tab row */}
      <View style={s.tabs}>
        {['wallet', 'missions', 'tier'].map(t => (
          <TouchableOpacity key={t} style={[s.tab, tab === t && s.tabActive]} onPress={() => setTab(t)}>
            <Text style={[s.tabText, tab === t && s.tabTextActive]}>
              {t === 'wallet' ? '💳 Ví' : t === 'missions' ? '🎯 Nhiệm vụ' : '🏅 Cấp bậc'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadAll(); }} tintColor={Colors.primary} />}
      >
        <View style={{ padding: Spacing.lg }}>

          {/* ── WALLET TAB ── */}
          {tab === 'wallet' && (
            <>
              <View style={s.balanceCard}>
                <Text style={s.balanceLabel}>Số dư khả dụng</Text>
                <Text style={s.balanceAmount}>{formatCurrency(wallet?.balance || 0)}</Text>
                <Text style={s.pendingLabel}>Đang chờ: {formatCurrency(wallet?.pending || 0)}</Text>
                <TouchableOpacity style={s.withdrawBtn} onPress={() => setWithdrawModal(true)}>
                  <Text style={s.withdrawBtnText}>⬆️ Rút tiền</Text>
                </TouchableOpacity>
              </View>

              {/* Summary */}
              <View style={s.summaryRow}>
                {[
                  { label: 'Hôm nay', value: formatCurrency(wallet?.todayEarnings || 0), icon: '📅' },
                  { label: 'Tuần này', value: formatCurrency(wallet?.weekEarnings || 0), icon: '📆' },
                  { label: 'Tháng này', value: formatCurrency(wallet?.monthEarnings || 0), icon: '🗓️' },
                ].map((item, i) => (
                  <View key={i} style={s.summaryCard}>
                    <Text style={s.summaryIcon}>{item.icon}</Text>
                    <Text style={s.summaryValue}>{item.value}</Text>
                    <Text style={s.summaryLabel}>{item.label}</Text>
                  </View>
                ))}
              </View>

              {/* Transactions */}
              <Text style={s.sectionTitle}>Lịch sử giao dịch</Text>
              {wallet?.transactions?.length
                ? wallet.transactions.map((tx, i) => (
                    <View key={i} style={s.txRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={s.txDesc}>{tx.description || 'Giao dịch'}</Text>
                        <Text style={s.txDate}>{formatDate(tx.createdAt)}</Text>
                      </View>
                      <Text style={[s.txAmount, { color: tx.amount > 0 ? Colors.success : Colors.danger }]}>
                        {tx.amount > 0 ? '+' : ''}{formatCurrency(tx.amount)}
                      </Text>
                    </View>
                  ))
                : <Text style={s.empty}>Chưa có giao dịch</Text>
              }
            </>
          )}

          {/* ── MISSIONS TAB ── */}
          {tab === 'missions' && (
            <>
              <Text style={s.missionHint}>Hoàn thành nhiệm vụ để nhận thưởng thêm!</Text>
              {missions.length === 0
                ? <Text style={s.empty}>Chưa có nhiệm vụ nào</Text>
                : missions.map((m, i) => {
                    const pct = Math.min(100, Math.round((m.progress / m.target) * 100));
                    return (
                      <View key={i} style={s.missionCard}>
                        <View style={s.missionTop}>
                          <Text style={s.missionEmoji}>{m.icon || '🎯'}</Text>
                          <View style={{ flex: 1, marginLeft: 10 }}>
                            <Text style={s.missionTitle}>{m.title}</Text>
                            <Text style={s.missionDesc}>{m.description}</Text>
                          </View>
                          <View style={s.rewardBadge}>
                            <Text style={s.rewardText}>+{formatCurrency(m.reward)}</Text>
                          </View>
                        </View>
                        <View style={s.progressBarBg}>
                          <View style={[s.progressBarFill, { width: `${pct}%` }]} />
                        </View>
                        <Text style={s.progressLabel}>{m.progress}/{m.target} — {pct}%</Text>
                      </View>
                    );
                  })
              }
            </>
          )}

          {/* ── TIER TAB ── */}
          {tab === 'tier' && (
            <>
              <View style={[s.tierCard, { borderTopColor: tierInfo.color }]}>
                <Text style={s.tierEmoji}>{tierInfo.icon}</Text>
                <Text style={[s.tierLabel, { color: tierInfo.color }]}>{tierInfo.label}</Text>
                <Text style={s.tierPoints}>{tier?.points || 0} điểm</Text>
                {tier?.nextThreshold && (
                  <>
                    <View style={s.tierProgressBg}>
                      <View style={[s.tierProgressFill, {
                        width: `${Math.min(100, ((tier.points - tier.prevThreshold) / (tier.nextThreshold - tier.prevThreshold)) * 100)}%`,
                        backgroundColor: tierInfo.color,
                      }]} />
                    </View>
                    <Text style={s.tierProgressLabel}>
                      Còn {tier.nextThreshold - tier.points} điểm lên {TIER_CONFIG[tierInfo.next]?.label}
                    </Text>
                  </>
                )}
              </View>

              {/* Benefits */}
              <Text style={s.sectionTitle}>Quyền lợi cấp bậc</Text>
              {[
                { tier: 'bronze', benefits: ['Tham gia chương trình', 'Nhận đơn cơ bản', 'Hỗ trợ 8h/ngày'] },
                { tier: 'silver', benefits: ['Ưu tiên nhận đơn giờ cao điểm', 'Bonus 5% mỗi đơn', 'Hỗ trợ 16h/ngày'] },
                { tier: 'gold',   benefits: ['Ưu tiên cao nhất', 'Bonus 10% mỗi đơn', 'Nhiệm vụ đặc biệt', 'Hỗ trợ 24/7'] },
                { tier: 'diamond', benefits: ['Ưu tiên tuyệt đối', 'Bonus 15%', 'Quản lý tài khoản riêng', 'Thưởng tháng'] },
              ].map((item, i) => {
                const cfg = TIER_CONFIG[item.tier];
                return (
                  <View key={i} style={[s.benefitCard, tier?.current === item.tier && s.benefitCardActive]}>
                    <Text style={s.benefitTierName}>{cfg.icon} {cfg.label}</Text>
                    {item.benefits.map((b, j) => (
                      <Text key={j} style={s.benefitItem}>✓ {b}</Text>
                    ))}
                  </View>
                );
              })}
            </>
          )}
        </View>
      </ScrollView>

      {/* Withdraw Modal */}
      <Modal visible={withdrawModal} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>⬆️ Rút tiền về ngân hàng</Text>
            {[
              { k: 'amount', label: 'Số tiền (đ)', keyType: 'numeric', ph: '50000' },
              { k: 'bankName', label: 'Ngân hàng', ph: 'Vietcombank, MB Bank...' },
              { k: 'accountNo', label: 'Số tài khoản', keyType: 'numeric', ph: '...' },
              { k: 'accountName', label: 'Tên chủ TK (IN HOA)', ph: 'NGUYEN VAN A' },
            ].map(f => (
              <View key={f.k} style={{ marginBottom: 10 }}>
                <Text style={s.fieldLabel}>{f.label}</Text>
                <TextInput
                  style={s.fieldInput}
                  placeholder={f.ph}
                  keyboardType={f.keyType || 'default'}
                  autoCapitalize="characters"
                  value={form[f.k]}
                  onChangeText={v => setForm(p => ({ ...p, [f.k]: v }))}
                />
              </View>
            ))}
            <TouchableOpacity style={s.confirmBtn} onPress={handleWithdraw} disabled={submitting}>
              {submitting
                ? <ActivityIndicator color="#fff" />
                : <Text style={s.confirmBtnText}>Xác nhận rút tiền</Text>
              }
            </TouchableOpacity>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setWithdrawModal(false)}>
              <Text style={s.cancelBtnText}>Huỷ</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, padding: Spacing.lg },
  headerTitle: { fontSize: 20, fontWeight: '800', color: Colors.white },
  tabs: { flexDirection: 'row', backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2.5, borderBottomColor: Colors.primary },
  tabText: { fontSize: 12, fontWeight: '700', color: Colors.gray4 },
  tabTextActive: { color: Colors.primary },
  balanceCard: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg,
    padding: Spacing.xl, alignItems: 'center', marginBottom: 12, ...Shadow.md,
  },
  balanceLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 13 },
  balanceAmount: { color: Colors.white, fontSize: 34, fontWeight: '900', marginVertical: 6 },
  pendingLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  withdrawBtn: {
    backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: Radius.md,
    paddingVertical: 10, paddingHorizontal: 28, marginTop: 12,
  },
  withdrawBtnText: { color: Colors.white, fontWeight: '800', fontSize: 14 },
  summaryRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  summaryCard: {
    flex: 1, backgroundColor: Colors.white, borderRadius: Radius.md,
    padding: 10, alignItems: 'center', ...Shadow.sm,
  },
  summaryIcon: { fontSize: 22 },
  summaryValue: { fontSize: 12, fontWeight: '800', color: Colors.primary, marginTop: 2 },
  summaryLabel: { fontSize: 10, color: Colors.textSub },
  sectionTitle: { fontWeight: '800', fontSize: 15, marginBottom: 10 },
  txRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.white,
    borderRadius: Radius.md, padding: 12, marginBottom: 8, ...Shadow.sm,
  },
  txDesc: { fontWeight: '600', fontSize: 13 },
  txDate: { fontSize: 11, color: Colors.textLight, marginTop: 2 },
  txAmount: { fontWeight: '800', fontSize: 14 },
  empty: { textAlign: 'center', color: Colors.gray4, paddingVertical: 24 },
  missionHint: { fontSize: 13, color: Colors.textSub, marginBottom: 12 },
  missionCard: {
    backgroundColor: Colors.white, borderRadius: Radius.md, padding: 14, marginBottom: 10, ...Shadow.sm,
  },
  missionTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  missionEmoji: { fontSize: 28 },
  missionTitle: { fontWeight: '800', fontSize: 14 },
  missionDesc: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
  rewardBadge: { backgroundColor: Colors.success, borderRadius: Radius.sm, paddingHorizontal: 8, paddingVertical: 4 },
  rewardText: { color: Colors.white, fontWeight: '700', fontSize: 12 },
  progressBarBg: { height: 8, backgroundColor: Colors.gray2, borderRadius: 4, overflow: 'hidden' },
  progressBarFill: { height: '100%', backgroundColor: Colors.primary, borderRadius: 4 },
  progressLabel: { fontSize: 11, color: Colors.textSub, marginTop: 4 },
  tierCard: {
    backgroundColor: Colors.white, borderRadius: Radius.lg, padding: 24,
    alignItems: 'center', marginBottom: 16, borderTopWidth: 4, ...Shadow.md,
  },
  tierEmoji: { fontSize: 56 },
  tierLabel: { fontSize: 22, fontWeight: '900', marginTop: 8 },
  tierPoints: { fontSize: 16, color: Colors.textSub, marginTop: 4 },
  tierProgressBg: { width: '100%', height: 10, backgroundColor: Colors.gray2, borderRadius: 5, marginTop: 12, overflow: 'hidden' },
  tierProgressFill: { height: '100%', borderRadius: 5 },
  tierProgressLabel: { fontSize: 12, color: Colors.textSub, marginTop: 6 },
  benefitCard: {
    backgroundColor: Colors.white, borderRadius: Radius.md, padding: 14, marginBottom: 8, ...Shadow.sm,
  },
  benefitCardActive: { borderWidth: 2, borderColor: Colors.primary },
  benefitTierName: { fontWeight: '800', fontSize: 14, marginBottom: 8 },
  benefitItem: { fontSize: 13, color: Colors.text, marginBottom: 4 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: Colors.white, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24 },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: 16 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: Colors.gray5, marginBottom: 4 },
  fieldInput: {
    borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
  },
  confirmBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  confirmBtnText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12 },
  cancelBtnText: { color: Colors.gray4 },
});
