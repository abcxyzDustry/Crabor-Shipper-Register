// ============================================================
// Sales Screen — Tích hợp vào app khách hàng
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, RefreshControl, Share,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { SalesAPI } from '../../shared/api';
import { Storage, KEYS } from '../../shared/storage';

export default function SalesScreen({ navigation }) {
  const [salesUser, setSalesUser] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [registerModal, setRegisterModal] = useState(false);
  const [regForm, setRegForm] = useState({ name: '', phone: '', refCode: '' });
  const [regLoading, setRegLoading] = useState(false);
  const [loginModal, setLoginModal] = useState(false);
  const [loginPhone, setLoginPhone] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [me, lb] = await Promise.allSettled([
        SalesAPI.getMe(),
        SalesAPI.getLeaderboard(),
      ]);
      if (me.status === 'fulfilled') setSalesUser(me.value?.sales || me.value);
      if (lb.status === 'fulfilled') setLeaderboard(lb.value?.leaderboard || lb.value || []);
    } catch (e) {}
    finally { setLoading(false); setRefreshing(false); }
  };

  const handleRegister = async () => {
    if (!regForm.name || !regForm.phone) return Alert.alert('Lỗi', 'Vui lòng điền đầy đủ');
    setRegLoading(true);
    try {
      const res = await SalesAPI.register(regForm);
      setSalesUser(res.sales || res);
      setRegisterModal(false);
      Alert.alert('🎉 Đăng ký thành công!', `Mã giới thiệu của bạn: ${res.sales?.refCode || res.refCode}`);
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setRegLoading(false); }
  };

  const handleLogin = async () => {
    if (!loginPhone) return;
    setLoginLoading(true);
    try {
      const res = await SalesAPI.login({ phone: loginPhone });
      setSalesUser(res.sales || res);
      setLoginModal(false);
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setLoginLoading(false); }
  };

  const handleShare = async () => {
    if (!salesUser?.refCode) return;
    const link = `https://crabor-shipper-register.onrender.com?ref=${salesUser.refCode}`;
    await Share.share({
      message: `Đặt đồ ăn nhanh với CRABOR! Dùng mã ${salesUser.refCode} để nhận ưu đãi!\n${link}`,
      title: 'CRABOR — Giao đồ ăn',
    });
  };

  const getMedalEmoji = (rank) => {
    if (rank === 0) return '🥇';
    if (rank === 1) return '🥈';
    if (rank === 2) return '🥉';
    return `${rank + 1}.`;
  };

  if (loading) return (
    <SafeAreaView style={styles.safe}>
      <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} />
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>💰 Kiếm thêm thu nhập</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadData(); }} tintColor={Colors.primary} />}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <Text style={styles.heroEmoji}>💰</Text>
          <Text style={styles.heroTitle}>Chương trình Sales CRABOR</Text>
          <Text style={styles.heroSub}>Giới thiệu bạn bè — nhận hoa hồng ngay khi họ đặt đơn đầu tiên!</Text>
        </View>

        {salesUser ? (
          <>
            {/* My ref card */}
            <View style={styles.refCard}>
              <Text style={styles.refLabel}>Mã giới thiệu của bạn</Text>
              <Text style={styles.refCode}>{salesUser.refCode}</Text>
              <TouchableOpacity style={styles.shareBtn} onPress={handleShare}>
                <Text style={styles.shareBtnText}>📤 Chia sẻ ngay</Text>
              </TouchableOpacity>
            </View>

            {/* Stats */}
            <View style={styles.statsRow}>
              {[
                { label: 'Lượt giới thiệu', value: salesUser.referralCount || 0, icon: '👥' },
                { label: 'Tổng hoa hồng', value: formatCurrency(salesUser.totalCommission || 0), icon: '💵' },
                { label: 'Ví Sales', value: formatCurrency(salesUser.walletBalance || 0), icon: '💳' },
              ].map((s, i) => (
                <View key={i} style={styles.statCard}>
                  <Text style={styles.statIcon}>{s.icon}</Text>
                  <Text style={styles.statValue}>{s.value}</Text>
                  <Text style={styles.statLabel}>{s.label}</Text>
                </View>
              ))}
            </View>

            {/* How it works */}
            <View style={styles.howCard}>
              <Text style={styles.howTitle}>Cách nhận hoa hồng</Text>
              {[
                '📤 Chia sẻ mã giới thiệu cho bạn bè',
                '📥 Bạn bè đăng ký & đặt đơn đầu tiên',
                '💰 Bạn nhận hoa hồng tự động vào ví',
                '🏦 Rút tiền về tài khoản bất cứ lúc nào',
              ].map((s, i) => (
                <Text key={i} style={styles.howStep}>{s}</Text>
              ))}
            </View>
          </>
        ) : (
          <View style={styles.joinCard}>
            <Text style={styles.joinTitle}>Tham gia ngay!</Text>
            <Text style={styles.joinSub}>Đăng ký tài khoản Sales để nhận mã giới thiệu và bắt đầu kiếm tiền.</Text>
            <TouchableOpacity style={styles.joinBtn} onPress={() => setRegisterModal(true)}>
              <Text style={styles.joinBtnText}>🚀 Đăng ký Sales</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.loginLinkBtn} onPress={() => setLoginModal(true)}>
              <Text style={styles.loginLinkText}>Đã có tài khoản? Đăng nhập</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Leaderboard */}
        {leaderboard.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>🏆 Bảng xếp hạng tháng</Text>
            {leaderboard.slice(0, 10).map((s, i) => (
              <View key={i} style={[styles.lbRow, salesUser?.refCode === s.refCode && styles.lbRowMe]}>
                <Text style={styles.lbRank}>{getMedalEmoji(i)}</Text>
                <View style={styles.lbInfo}>
                  <Text style={styles.lbName}>{s.name}</Text>
                  <Text style={styles.lbSub}>{s.referralCount} lượt giới thiệu</Text>
                </View>
                <Text style={styles.lbCommission}>{formatCurrency(s.totalCommission)}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Register Modal */}
      <Modal visible={registerModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>🚀 Đăng ký Sales</Text>
            <TextInput style={styles.input} placeholder="Họ và tên" value={regForm.name} onChangeText={v => setRegForm(p => ({ ...p, name: v }))} />
            <TextInput style={styles.input} placeholder="Số điện thoại" keyboardType="phone-pad" value={regForm.phone} onChangeText={v => setRegForm(p => ({ ...p, phone: v }))} />
            <TextInput style={styles.input} placeholder="Mã giới thiệu (nếu có)" value={regForm.refCode} onChangeText={v => setRegForm(p => ({ ...p, refCode: v }))} autoCapitalize="characters" />
            <TouchableOpacity style={styles.confirmBtn} onPress={handleRegister} disabled={regLoading}>
              {regLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.confirmBtnText}>Đăng ký</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setRegisterModal(false)}>
              <Text style={styles.cancelBtnText}>Huỷ</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Login Modal */}
      <Modal visible={loginModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>🔐 Đăng nhập Sales</Text>
            <TextInput style={styles.input} placeholder="Số điện thoại" keyboardType="phone-pad" value={loginPhone} onChangeText={setLoginPhone} />
            <TouchableOpacity style={styles.confirmBtn} onPress={handleLogin} disabled={loginLoading}>
              {loginLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.confirmBtnText}>Đăng nhập</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setLoginModal(false)}>
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
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.primary, padding: Spacing.lg,
  },
  backBtn: { color: Colors.white, fontSize: 24, fontWeight: '700' },
  headerTitle: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  hero: {
    backgroundColor: Colors.primary, padding: Spacing.xl,
    alignItems: 'center', paddingBottom: 32,
  },
  heroEmoji: { fontSize: 56, marginBottom: 8 },
  heroTitle: { fontSize: 20, fontWeight: '900', color: Colors.white, textAlign: 'center' },
  heroSub: { fontSize: 13, color: 'rgba(255,255,255,0.85)', textAlign: 'center', marginTop: 8, lineHeight: 20 },
  refCard: {
    margin: Spacing.lg, backgroundColor: Colors.white, borderRadius: Radius.lg,
    padding: Spacing.xl, alignItems: 'center', ...Shadow.md,
  },
  refLabel: { fontSize: 12, color: Colors.textSub, fontWeight: '600' },
  refCode: { fontSize: 36, fontWeight: '900', color: Colors.primary, letterSpacing: 6, marginVertical: 8 },
  shareBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.md,
    paddingVertical: 12, paddingHorizontal: 32, marginTop: 8,
  },
  shareBtnText: { color: Colors.white, fontWeight: '800', fontSize: 14 },
  statsRow: { flexDirection: 'row', marginHorizontal: Spacing.lg, gap: 8, marginBottom: Spacing.md },
  statCard: {
    flex: 1, backgroundColor: Colors.white, borderRadius: Radius.md,
    padding: 12, alignItems: 'center', ...Shadow.sm,
  },
  statIcon: { fontSize: 24, marginBottom: 4 },
  statValue: { fontSize: 13, fontWeight: '800', color: Colors.primary, textAlign: 'center' },
  statLabel: { fontSize: 10, color: Colors.textSub, textAlign: 'center', marginTop: 2 },
  howCard: {
    margin: Spacing.lg, backgroundColor: Colors.white, borderRadius: Radius.lg,
    padding: Spacing.xl, ...Shadow.sm,
  },
  howTitle: { fontWeight: '800', fontSize: 15, marginBottom: 12 },
  howStep: { fontSize: 13, color: Colors.text, marginBottom: 8, lineHeight: 20 },
  joinCard: {
    margin: Spacing.lg, backgroundColor: Colors.white, borderRadius: Radius.lg,
    padding: Spacing.xl, alignItems: 'center', ...Shadow.md,
  },
  joinTitle: { fontSize: 20, fontWeight: '900', color: Colors.text },
  joinSub: { fontSize: 13, color: Colors.textSub, textAlign: 'center', marginTop: 8, lineHeight: 20 },
  joinBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.md,
    paddingVertical: 14, paddingHorizontal: 32, marginTop: 20, width: '100%', alignItems: 'center',
  },
  joinBtnText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  loginLinkBtn: { marginTop: 12 },
  loginLinkText: { color: Colors.primary, fontSize: 13, fontWeight: '600' },
  section: { margin: Spacing.lg },
  sectionTitle: { fontWeight: '800', fontSize: 16, marginBottom: 12 },
  lbRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.white,
    borderRadius: Radius.md, padding: 14, marginBottom: 8, ...Shadow.sm,
  },
  lbRowMe: { borderWidth: 2, borderColor: Colors.primary },
  lbRank: { fontSize: 20, width: 36 },
  lbInfo: { flex: 1, marginLeft: 8 },
  lbName: { fontWeight: '700', fontSize: 14 },
  lbSub: { fontSize: 11, color: Colors.textSub },
  lbCommission: { fontWeight: '800', color: Colors.primary, fontSize: 14 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: Colors.white, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24 },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: 16 },
  input: {
    borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, marginBottom: 12,
  },
  confirmBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  confirmBtnText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12 },
  cancelBtnText: { color: Colors.gray4, fontSize: 14 },
});
