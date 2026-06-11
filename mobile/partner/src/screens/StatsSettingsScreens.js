// ============================================================
// Partner Stats Screen — Doanh thu & Thống kê
// ============================================================
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator, Dimensions, Modal,
  Image, Alert, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { PartnerAPI, api } from '../../shared/api';

const getMsg = (e) => e?.message || e?.data?.message || e?.error || 'Đã có lỗi xảy ra';

const { width: W } = Dimensions.get('window');

// Simple bar chart component
function BarChart({ data, height = 160 }) {
  if (!data?.length) return null;
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height, gap: 4 }}>
      {data.map((d, i) => (
        <View key={i} style={{ flex: 1, alignItems: 'center' }}>
          <Text style={{ fontSize: 9, color: Colors.textSub, marginBottom: 2 }}>
            {formatCurrency(d.value).replace('đ', '')}
          </Text>
          <View style={{
            width: '100%', borderRadius: 4,
            height: Math.max(8, (d.value / max) * (height - 32)),
            backgroundColor: i === data.length - 1 ? Colors.primary : Colors.primaryLight,
          }} />
          <Text style={{ fontSize: 9, color: Colors.textSub, marginTop: 4 }} numberOfLines={1}>{d.label}</Text>
        </View>
      ))}
    </View>
  );
}

// ─── Countdown timer hook ────────────────────────────────────
function useCountdown(dueDate) {
  const [timeLeft, setTimeLeft] = useState('');
  const [isOverdue, setIsOverdue] = useState(false);
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const due = new Date(dueDate);
      const diff = due - now;
      if (diff <= 0) { setIsOverdue(true); setTimeLeft('Đã hết hạn'); return; }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setTimeLeft(d > 0 ? `${d}n ${h}g ${m}p ${s}s` : `${h}g ${m}p ${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [dueDate]);
  return { timeLeft, isOverdue };
}

export function StatsScreen() {
  const [stats, setStats]     = useState(null);
  const [chart, setChart]     = useState([]);
  const [fee, setFee]         = useState(null);
  const [pmStats, setPmStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [qrModal, setQrModal] = useState(false);
  const [qrData, setQrData]   = useState(null);
  const [paying, setPaying]   = useState(false);
  const [waitingConfirm, setWaitingConfirm] = useState(false);
  const confirmTimer = useRef(null);

  useEffect(() => {
    loadAll();
    return () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); };
  }, []);

  const loadAll = async () => {
    const [stRes, chRes, feeRes, pmRes] = await Promise.allSettled([
      PartnerAPI.getStats(),
      PartnerAPI.getRevenueChart(),
      api.get('/api/partner/fee'),
      api.get('/api/partner/stats/payment-methods'),
    ]);
    if (stRes.status === 'fulfilled') setStats(stRes.value);
    if (chRes.status === 'fulfilled') {
      const raw = chRes.value?.chart || chRes.value?.data || [];
      setChart(raw.map(d => ({ label: d.label || d.date, value: d.revenue || d.value || 0 })));
    }
    if (feeRes.status === 'fulfilled') setFee(feeRes.value?.fee || null);
    if (pmRes.status === 'fulfilled') setPmStats(pmRes.value?.stats || null);
    setLoading(false); setRefreshing(false);
  };

  const handlePayFee = async () => {
    if (!fee) return;
    // Hỏi chọn phương thức
    Alert.alert(
      '💳 Chọn phương thức thanh toán',
      `Phí cần trả: ${formatCurrency(feeAmount || fee.amount)}`,
      [
        { text: 'Huỷ', style: 'cancel' },
        {
          text: '💳 Trả bằng ví CRABOR',
          onPress: async () => {
            setPaying(true);
            try {
              const res = await api.post('/api/partner/fee/pay-wallet');
              Alert.alert('✅ Thành công!', `Đã thanh toán ${formatCurrency(res.feeAmount)} từ ví CRABOR.`);
              loadAll();
            } catch (e) { Alert.alert('Lỗi', getMsg(e)); }
            finally { setPaying(false); }
          }
        },
        {
          text: '🏦 Chuyển khoản QR',
          onPress: async () => {
            setPaying(true);
            try {
              const res = await api.post('/api/partner/fee/prepare', { amount: fee.amount });
              setQrData(res);
              setQrModal(true);
            } catch (e) { Alert.alert('Lỗi', getMsg(e)); }
            finally { setPaying(false); }
          }
        },
      ]
    );
  };

  const handleQrPaid = () => {
    setWaitingConfirm(true);
    // Đợi 30 phút tự check
    confirmTimer.current = setTimeout(async () => {
      const res = await api.get('/api/partner/fee').catch(() => null);
      if (res?.fee?.status === 'paid') {
        Alert.alert('✅ Thanh toán thành công!', 'Tài khoản của bạn đã được kích hoạt lại.');
        setFee(res.fee);
      } else {
        Alert.alert('⏳ Chưa xác nhận', 'Chưa nhận được thanh toán. Liên hệ hỗ trợ nếu đã chuyển.');
      }
      setWaitingConfirm(false);
      setQrModal(false);
    }, 30 * 60 * 1000);
    Alert.alert('⏳ Đang chờ xác nhận', 'Hệ thống sẽ tự xác nhận trong vòng 30 phút sau khi nhận được tiền.');
  };

  const { timeLeft, isOverdue } = useCountdown(fee?.dueDate || new Date());

  if (loading) return (
    <SafeAreaView style={st.safe}><ActivityIndicator color={Colors.primary} style={{ flex: 1 }} /></SafeAreaView>
  );

  const feeRate    = fee?.rate || 18;
  const weekRev    = fee?.weekRevenue || 0;
  const feeAmount  = fee?.amount || Math.round(weekRev * feeRate / 100);
  const partnerRev = weekRev - feeAmount;
  const feeStatus  = fee?.status || 'pending';

  const summary = [
    { icon: '💰', label: 'Doanh thu hôm nay', value: formatCurrency(stats?.todayRevenue || 0), color: Colors.primary },
    { icon: '📆', label: 'Doanh thu tháng',   value: formatCurrency(stats?.monthRevenue || 0), color: Colors.info },
    { icon: '📦', label: 'Đơn hôm nay',        value: `${stats?.todayOrders || 0} đơn`,        color: Colors.success },
    { icon: '⭐', label: 'Đánh giá TB',         value: `${stats?.avgRating || '5.0'}/5`,        color: Colors.warning },
    { icon: '❌', label: 'Đơn huỷ',             value: `${stats?.cancelledOrders || 0} đơn`,    color: Colors.danger },
    { icon: '🛒', label: 'Giá trị đơn TB',      value: formatCurrency(stats?.avgOrderValue || 0),color: Colors.primary },
  ];

  return (
    <SafeAreaView style={st.safe}>
      <View style={st.header}><Text style={st.headerTitle}>📊 Thống kê</Text></View>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadAll(); }} tintColor={Colors.primary}/>}
      >
        {/* ── PHÍ TUẦN / THANH TOÁN ─────────────────────────── */}
        <View style={[st.feeCard, isOverdue && st.feeCardOverdue, feeStatus==='paid' && st.feeCardPaid]}>
          {/* Status badge */}
          <View style={st.feeHeader}>
            <Text style={st.feeTitle}>💳 Phí tuần này</Text>
            <View style={[st.feeBadge,
              feeStatus==='paid' && st.feeBadgePaid,
              feeStatus==='overdue' && st.feeBadgeOverdue]}>
              <Text style={st.feeBadgeTxt}>
                {feeStatus==='paid' ? '✅ Đã thanh toán' : feeStatus==='overdue' ? '🚫 Quá hạn' : '⏳ Chờ thanh toán'}
              </Text>
            </View>
          </View>

          {/* Breakdown */}
          <View style={st.feeBreakdown}>
            <View style={st.feeRow}>
              <Text style={st.feeLabel}>Doanh thu tuần</Text>
              <Text style={st.feeVal}>{formatCurrency(weekRev)}</Text>
            </View>
            <View style={st.feeRow}>
              <Text style={st.feeLabel}>Phí CRABOR ({feeRate}%)</Text>
              <Text style={[st.feeVal, {color: Colors.danger}]}>-{formatCurrency(feeAmount)}</Text>
            </View>
            <View style={[st.feeRow, st.feeTotalRow]}>
              <Text style={st.feeTotalLabel}>Bạn nhận được</Text>
              <Text style={st.feeTotalVal}>{formatCurrency(partnerRev)}</Text>
            </View>
          </View>

          {/* Countdown */}
          {feeStatus !== 'paid' && (
            <View style={[st.countdownBox, isOverdue && {backgroundColor: Colors.danger + '20'}]}>
              <Text style={st.countdownLabel}>
                {isOverdue ? '🚫 Tài khoản bị vô hiệu hoá' : '⏰ Hạn thanh toán (Chủ nhật)'}
              </Text>
              <Text style={[st.countdownTime, isOverdue && {color: Colors.danger}]}>{timeLeft}</Text>
              {isOverdue && (
                <Text style={st.overdueNote}>Thanh toán ngay để khôi phục tài khoản</Text>
              )}
            </View>
          )}

          {/* Pay button */}
          {feeStatus !== 'paid' && feeAmount > 0 && (
            <TouchableOpacity
              style={[st.payBtn, paying && {opacity:0.6}, isOverdue && {backgroundColor: Colors.danger}]}
              onPress={handlePayFee} disabled={paying}>
              {paying
                ? <ActivityIndicator color="#fff"/>
                : <Text style={st.payBtnTxt}>
                    {isOverdue ? '🚫 Thanh toán để mở khoá' : '💸 Thanh toán phí ngay'}
                  </Text>
              }
            </TouchableOpacity>
          )}

          {feeStatus === 'paid' && (
            <Text style={st.paidNote}>
              ✅ Đã thanh toán lúc {fee?.paidAt ? new Date(fee.paidAt).toLocaleString('vi-VN') : ''}
            </Text>
          )}
        </View>

        {/* Summary grid */}
        <View style={st.grid}>
          {summary.map((item, i) => (
            <View key={i} style={[st.summaryCard, { borderTopColor: item.color }]}>
              <Text style={st.summaryIcon}>{item.icon}</Text>
              <Text style={[st.summaryValue, { color: item.color }]}>{item.value}</Text>
              <Text style={st.summaryLabel}>{item.label}</Text>
            </View>
          ))}
        </View>

        {chart.length > 0 && (
          <View style={st.chartCard}>
            <Text style={st.chartTitle}>📈 Doanh thu 7 ngày gần nhất</Text>
            <BarChart data={chart.slice(-7)} height={180}/>
          </View>
        )}

        {/* Payment method summary */}
        <View style={st.pmSection}>
          <Text style={st.sectionTitle}>💰 Thu nhập theo phương thức</Text>
          <Text style={st.pmNote}>Tất cả quy về ví CRABOR • Xem chi tiết trong màn Ví</Text>
          {['cash','transfer','wallet'].map((key) => {
            const meta = { cash:{icon:'💵',label:'Tiền mặt',color:'#27AE60'}, transfer:{icon:'🏦',label:'Chuyển khoản',color:'#3498DB'}, wallet:{icon:'💳',label:'Ví CRABOR',color:'#9B59B6'} }[key];
            const amt = pmStats?.[key]?.amount || 0;
            const cnt = pmStats?.[key]?.count || 0;
            return (
              <View key={key} style={st.pmRow}>
                <Text style={st.pmIco}>{meta.icon}</Text>
                <View style={{flex:1}}>
                  <Text style={st.pmLabel}>{meta.label}</Text>
                  <Text style={st.pmCount}>{cnt} đơn</Text>
                </View>
                <Text style={[st.pmAmt, {color: meta.color}]}>{formatCurrency(amt)}</Text>
              </View>
            );
          })}
        </View>

        {stats?.topItems?.length > 0 && (
          <View style={st.section}>
            <Text style={st.sectionTitle}>🏆 Món bán chạy</Text>
            {stats.topItems.slice(0, 5).map((item, i) => (
              <View key={i} style={st.topItemRow}>
                <Text style={st.topItemRank}>{i + 1}</Text>
                <Text style={st.topItemName}>{item.name}</Text>
                <Text style={st.topItemCount}>{item.count} lần</Text>
                <Text style={st.topItemRevenue}>{formatCurrency(item.revenue)}</Text>
              </View>
            ))}
          </View>
        )}
        <View style={{ height: 24 }}/>
      </ScrollView>

      {/* ── QR PAYMENT MODAL ───────────────────────────────── */}
      <Modal visible={qrModal} transparent animationType="slide">
        <View style={st.modalOverlay}>
          <View style={st.modalCard}>
            <Text style={st.modalTitle}>💸 Thanh toán phí tuần</Text>
            {waitingConfirm ? (
              <View style={{alignItems:'center', paddingVertical:32}}>
                <ActivityIndicator size="large" color={Colors.primary}/>
                <Text style={st.waitTxt}>Đang chờ xác nhận thanh toán...</Text>
                <Text style={st.waitSub}>Hệ thống tự xác nhận trong 30 phút</Text>
              </View>
            ) : qrData ? (
              <>
                <View style={st.qrWrap}>
                  <Image
                    source={{ uri: qrData.qrUrl }}
                    style={st.qrImg}
                    resizeMode="contain"
                  />
                </View>
                <View style={st.bankInfo}>
                  <View style={st.bankRow}>
                    <Text style={st.bankLabel}>Ngân hàng</Text>
                    <Text style={st.bankVal}>{qrData.bankName}</Text>
                  </View>
                  <View style={st.bankRow}>
                    <Text style={st.bankLabel}>Số TK</Text>
                    <Text style={st.bankVal}>{qrData.accountNumber}</Text>
                  </View>
                  <View style={st.bankRow}>
                    <Text style={st.bankLabel}>Chủ TK</Text>
                    <Text style={st.bankVal}>{qrData.accountName}</Text>
                  </View>
                  <View style={[st.bankRow, {borderBottomWidth:0}]}>
                    <Text style={st.bankLabel}>Nội dung CK</Text>
                    <Text style={[st.bankVal, {color: Colors.primary, fontWeight:'900'}]}>{qrData.content}</Text>
                  </View>
                </View>
                <View style={[st.bankRow, {paddingHorizontal:0, marginBottom:16}]}>
                  <Text style={st.bankLabel}>Số tiền</Text>
                  <Text style={[st.bankVal, {fontSize:18, color: Colors.primary, fontWeight:'900'}]}>
                    {formatCurrency(qrData.amount)}
                  </Text>
                </View>
                <Text style={st.qrNote}>
                  ⚠️ Nhập ĐÚNG nội dung chuyển khoản để hệ thống tự xác nhận
                </Text>
                <TouchableOpacity style={st.paidConfirmBtn} onPress={handleQrPaid}>
                  <Text style={st.paidConfirmTxt}>✅ Tôi đã chuyển khoản</Text>
                </TouchableOpacity>
              </>
            ) : null}
            <TouchableOpacity style={st.closeModal} onPress={() => { setQrModal(false); setWaitingConfirm(false); }}>
              <Text style={st.closeModalTxt}>Đóng</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ============================================================
// Partner Settings Screen
// ============================================================
import { Switch, Alert as RNAlert } from 'react-native';

export function SettingsScreen({ navigation }) {
  const [partner, setPartner]     = useState(null);
  const [accepting, setAccepting]   = useState(true);
  const [autoPayFee, setAutoPayFee] = useState(false);
  const [loading, setLoading]       = useState(true);
  const [toggling, setToggling]     = useState(false);
  const [savingAuto, setSavingAuto] = useState(false);

  useEffect(() => {
    PartnerAPI.getMe()
      .then(r => {
        const p = r.partner || r;
        setPartner(p);
        setAccepting(p.accepting ?? p.isAccepting ?? true);
        setAutoPayFee(p.autoPayFee || false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleToggleAutoPayFee = async (val) => {
    setSavingAuto(true);
    try {
      await api.patch('/api/partner/settings', { autoPayFee: val });
      setAutoPayFee(val);
      if (val) RNAlert.alert('✅ Đã bật', 'Hệ thống sẽ tự động thanh toán phí hàng tuần từ ví CRABOR khi đủ số dư.');
    } catch (e) { RNAlert.alert('Lỗi', getMsg(e)); }
    finally { setSavingAuto(false); }
  };

  const handleToggleAccepting = async (val) => {
    setToggling(true);
    try {
      await PartnerAPI.setAccepting(val);
      setAccepting(val);
      // Khi bật nhận đơn → mở bản đồ để shipper xác định vị trí
      if (val) {
        RNAlert.alert(
          '🟢 Đang nhận đơn',
          'Mở bản đồ để shipper xác định vị trí cửa hàng?',
          [
            { text: 'Để sau', style: 'cancel' },
            { text: '📍 Mở bản đồ', onPress: () => navigation.navigate('Map') },
          ]
        );
      }
    } catch (e) { RNAlert.alert('Lỗi', getMsg(e)); }
    finally { setToggling(false); }
  };

  const handleLogout = () => {
    RNAlert.alert('Đăng xuất?', '', [
      { text: 'Huỷ', style: 'cancel' },
      {
        text: 'Đăng xuất', style: 'destructive', onPress: async () => {
          const { Storage } = require('../../shared/storage');
          await Storage.clear();
          navigation.replace('Login');
        }
      }
    ]);
  };

  if (loading) return (
    <SafeAreaView style={st.safe}><ActivityIndicator color={Colors.primary} style={{ flex: 1 }} /></SafeAreaView>
  );

  return (
    <SafeAreaView style={st.safe}>
      <View style={st.header}><Text style={st.headerTitle}>⚙️ Cài đặt</Text></View>
      <ScrollView>
        {/* Partner info */}
        <View style={st.profileCard}>
          <View style={st.avatarBig}><Text style={{ fontSize: 44 }}>🏪</Text></View>
          <Text style={st.profileName}>{partner?.name || 'Cửa hàng'}</Text>
          <Text style={st.profileSub}>{partner?.address || 'CRABOR Partner'}</Text>
        </View>

        {/* Accepting orders toggle */}
        <View style={st.settingRow}>
          <View style={{ flex: 1 }}>
            <Text style={st.settingLabel}>🟢 Nhận đơn hàng</Text>
            <Text style={st.settingHint}>{accepting ? 'Đang nhận đơn' : 'Đang tạm dừng'}</Text>
          </View>
          <Switch value={accepting} onValueChange={handleToggleAccepting}
            disabled={toggling} trackColor={{ false: Colors.gray3, true: Colors.success }} thumbColor="#fff"/>
        </View>

        <View style={st.settingRow}>
          <View style={{ flex: 1 }}>
            <Text style={st.settingLabel}>💳 Tự động thanh toán phí</Text>
            <Text style={st.settingHint}>
              {autoPayFee ? 'Tự trừ ví CRABOR mỗi tuần' : 'Tắt — tự thanh toán thủ công'}
            </Text>
          </View>
          <Switch value={autoPayFee} onValueChange={handleToggleAutoPayFee}
            disabled={savingAuto} trackColor={{ false: Colors.gray3, true: Colors.primary }} thumbColor="#fff"/>
        </View>

        {/* Info rows */}
        {[
          { icon: '📞', label: 'Số điện thoại', value: partner?.phone },
          { icon: '📧', label: 'Email', value: partner?.email },
          { icon: '📍', label: 'Địa chỉ', value: partner?.address },
          { icon: '🗓️', label: 'Tham gia', value: partner?.createdAt ? new Date(partner.createdAt).toLocaleDateString('vi-VN') : '' },
        ].filter(i => i.value).map((item, i) => (
          <View key={i} style={st.infoRow}>
            <Text style={st.infoIcon}>{item.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={st.infoLabel}>{item.label}</Text>
              <Text style={st.infoValue}>{item.value}</Text>
            </View>
          </View>
        ))}

        <TouchableOpacity style={st.walletBtn} onPress={() => navigation.navigate('Wallet')}>
          <Text style={st.walletBtnText}>💳 Xem ví & rút tiền</Text>
        </TouchableOpacity>

        <TouchableOpacity style={st.logoutBtn} onPress={handleLogout}>
          <Text style={st.logoutBtnText}>🚪 Đăng xuất</Text>
        </TouchableOpacity>

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, padding: Spacing.lg },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#fff' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: Spacing.md, gap: 8 },
  summaryCard: {
    width: (W - 40) / 2, backgroundColor: '#fff', borderRadius: Radius.md,
    padding: 14, alignItems: 'center', borderTopWidth: 3, ...Shadow.sm,
  },
  summaryIcon: { fontSize: 28, marginBottom: 6 },
  summaryValue: { fontSize: 16, fontWeight: '900' },
  summaryLabel: { fontSize: 11, color: Colors.textSub, textAlign: 'center', marginTop: 4 },
  chartCard: { backgroundColor: '#fff', margin: Spacing.md, borderRadius: Radius.lg, padding: Spacing.lg, ...Shadow.sm },
  chartTitle: { fontWeight: '800', fontSize: 14, marginBottom: 16 },
  section: { backgroundColor: '#fff', margin: Spacing.md, borderRadius: Radius.lg, padding: Spacing.lg, ...Shadow.sm },
  sectionTitle: { fontWeight: '800', fontSize: 15, marginBottom: 12 },
  topItemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.border },
  topItemRank: { width: 24, fontWeight: '800', color: Colors.primary, fontSize: 14 },
  topItemName: { flex: 1, fontSize: 13, fontWeight: '600', color: Colors.text },
  topItemCount: { fontSize: 12, color: Colors.textSub, marginRight: 8 },
  topItemRevenue: { fontWeight: '800', color: Colors.primary, fontSize: 13 },
  // Settings
  profileCard: { backgroundColor: '#fff', margin: Spacing.md, borderRadius: Radius.lg, padding: 24, alignItems: 'center', ...Shadow.sm },
  avatarBig: { width: 80, height: 80, borderRadius: 20, backgroundColor: Colors.cream, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  profileName: { fontSize: 18, fontWeight: '900', color: Colors.text },
  profileSub: { fontSize: 12, color: Colors.textSub, marginTop: 4, textAlign: 'center' },
  settingRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff',
    marginHorizontal: Spacing.md, marginBottom: 8, borderRadius: Radius.md, padding: 14, ...Shadow.sm,
  },
  settingLabel: { fontWeight: '700', fontSize: 14 },
  settingHint: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
  infoRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', marginHorizontal: Spacing.md, marginBottom: 6, borderRadius: Radius.md, padding: 14, ...Shadow.sm },
  infoIcon: { fontSize: 20, marginRight: 12 },
  infoLabel: { fontSize: 11, color: Colors.textSub },
  infoValue: { fontSize: 14, fontWeight: '700', color: Colors.text, marginTop: 2 },
  walletBtn: { margin: Spacing.md, backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center' },
  walletBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  logoutBtn: { marginHorizontal: Spacing.md, borderWidth: 1.5, borderColor: Colors.danger, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center' },
  logoutBtnText: { color: Colors.danger, fontWeight: '800', fontSize: 15 },
  pmSection: { backgroundColor:'#fff', marginHorizontal: Spacing.md, marginBottom: Spacing.md, borderRadius: Radius.lg, padding: Spacing.lg, ...Shadow.sm },
  pmNote: { fontSize:11, color: Colors.textSub, marginBottom:12, lineHeight:16 },
  pmRow: { flexDirection:'row', alignItems:'center', gap:10, paddingVertical:8, borderBottomWidth:1, borderBottomColor: Colors.border },
  pmIco: { fontSize:20, width:28 },
  pmLabel: { fontSize:13, fontWeight:'700', color: Colors.text },
  pmCount: { fontSize:11, color: Colors.textSub, marginTop:2 },
  pmAmt: { fontSize:14, fontWeight:'900' },
  // Fee card styles
  feeCard: { backgroundColor:'#fff', margin: Spacing.md, borderRadius: Radius.lg, padding: Spacing.lg, ...Shadow.md, borderLeftWidth:4, borderLeftColor: Colors.warning },
  feeCardOverdue: { borderLeftColor: Colors.danger },
  feeCardPaid: { borderLeftColor: Colors.success },
  feeHeader: { flexDirection:'row', justifyContent:'space-between', alignItems:'center', marginBottom:14 },
  feeTitle: { fontWeight:'800', fontSize:16, color: Colors.text },
  feeBadge: { backgroundColor: Colors.warning + '20', borderRadius: Radius.full, paddingHorizontal:10, paddingVertical:4 },
  feeBadgePaid: { backgroundColor: Colors.success + '20' },
  feeBadgeOverdue: { backgroundColor: Colors.danger + '20' },
  feeBadgeTxt: { fontSize:11, fontWeight:'800', color: Colors.text },
  feeBreakdown: { backgroundColor: Colors.gray1, borderRadius: Radius.md, padding:12, marginBottom:12 },
  feeRow: { flexDirection:'row', justifyContent:'space-between', paddingVertical:6, borderBottomWidth:1, borderBottomColor: Colors.border },
  feeLabel: { fontSize:13, color: Colors.textSub, fontWeight:'600' },
  feeVal: { fontSize:13, fontWeight:'800', color: Colors.text },
  feeTotalRow: { borderBottomWidth:0, marginTop:4, paddingTop:8 },
  feeTotalLabel: { fontSize:14, fontWeight:'800', color: Colors.text },
  feeTotalVal: { fontSize:16, fontWeight:'900', color: Colors.success },
  countdownBox: { backgroundColor: Colors.warning + '15', borderRadius: Radius.md, padding:12, marginBottom:12, alignItems:'center' },
  countdownLabel: { fontSize:12, fontWeight:'700', color: Colors.textSub, marginBottom:4 },
  countdownTime: { fontSize:22, fontWeight:'900', color: Colors.warning, letterSpacing:1 },
  overdueNote: { fontSize:12, color: Colors.danger, fontWeight:'700', marginTop:4 },
  payBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical:14, alignItems:'center' },
  payBtnTxt: { color:'#fff', fontWeight:'900', fontSize:15 },
  paidNote: { fontSize:12, color: Colors.success, fontWeight:'700', textAlign:'center', marginTop:4 },
  // Modal
  modalOverlay: { flex:1, backgroundColor:'rgba(0,0,0,0.5)', justifyContent:'flex-end' },
  modalCard: { backgroundColor:'#fff', borderTopLeftRadius:24, borderTopRightRadius:24, padding:24, maxHeight:'90%' },
  modalTitle: { fontSize:18, fontWeight:'800', marginBottom:16 },
  qrWrap: { alignItems:'center', marginBottom:16 },
  qrImg: { width:220, height:220, borderRadius:12 },
  bankInfo: { borderWidth:1.5, borderColor: Colors.border, borderRadius: Radius.md, marginBottom:12, overflow:'hidden' },
  bankRow: { flexDirection:'row', justifyContent:'space-between', padding:10, borderBottomWidth:1, borderBottomColor: Colors.border },
  bankLabel: { fontSize:12, color: Colors.textSub, fontWeight:'600' },
  bankVal: { fontSize:12, fontWeight:'700', color: Colors.text, flex:1, textAlign:'right' },
  qrNote: { fontSize:12, color: Colors.warning, fontWeight:'700', textAlign:'center', marginBottom:14, lineHeight:18 },
  paidConfirmBtn: { backgroundColor: Colors.success, borderRadius: Radius.md, paddingVertical:14, alignItems:'center', marginBottom:10 },
  paidConfirmTxt: { color:'#fff', fontWeight:'900', fontSize:15 },
  closeModal: { alignItems:'center', paddingVertical:10 },
  closeModalTxt: { color: Colors.gray4, fontSize:14, fontWeight:'600' },
  waitTxt: { fontSize:15, fontWeight:'800', color: Colors.text, marginTop:16, textAlign:'center' },
  waitSub: { fontSize:13, color: Colors.textSub, marginTop:8, textAlign:'center' },
});
