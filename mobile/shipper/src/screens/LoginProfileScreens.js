// ============================================================
// Shipper Login Screen
// ============================================================
import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
  ActivityIndicator, StatusBar, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Radius, Spacing } from '../../shared/theme';
import { AuthAPI } from '../../shared/api';
import { Storage, KEYS } from '../../shared/storage';
import { ShipperAPI } from '../../shared/api'; // ✅ SỬA: import đúng cách

export function LoginScreen({ navigation }) {
  const [via, setVia]     = useState('phone');
  const [step, setStep]   = useState(0);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [otp, setOtp]     = useState(['', '', '', '', '', '']);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const refs = useRef([]);

  const sendOTP = async () => {
    setLoading(true);
    try {
      if (via === 'phone') {
        await AuthAPI.sendShipperOTP(phone.replace(/\D/g, ''));
      } else {
        const r = await AuthAPI.sendShipperEmailOTP(email);
        setToken(r.token || '');
      }
      setStep(1);
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setLoading(false); }
  };

  const verifyOTP = async () => {
    const code = otp.join('');
    if (code.length < 6) return Alert.alert('Lỗi', 'Nhập đủ 6 số OTP');
    setLoading(true);
    try {
      let res;
      if (via === 'phone') {
        res = await AuthAPI.verifyShipperOTP(phone.replace(/\D/g, ''), code);
        await AuthAPI.createShipperSession(phone.replace(/\D/g, ''));
      } else {
        res = await AuthAPI.verifyShipperEmailOTP(email, code, token);
      }
      if (res.cookie) await Storage.set(KEYS.SESSION, res.cookie);
      // Lưu shipper info để socket join đúng room
      const shipperInfo = res.shipper || res;
      if (shipperInfo?._id) await Storage.set(KEYS.USER, shipperInfo);
      navigation.replace('Main');
    } catch (e) {
      Alert.alert('Sai OTP', e.message);
      setOtp(['', '', '', '', '', '']);
      refs.current[0]?.focus();
    } finally { setLoading(false); }
  };

  const handleOtp = (v, i) => {
    const n = [...otp]; n[i] = v.replace(/\D/g, '').slice(-1); setOtp(n);
    if (v && i < 5) refs.current[i + 1]?.focus();
  };

  return (
    <SafeAreaView style={st.safe}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.primary} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled">
          <View style={st.header}>
            <Text style={st.logo}>🦀</Text>
            <Text style={st.brand}>CRABOR</Text>
            <Text style={st.role}>Shipper</Text>
            <Text style={st.tagline}>Kiếm thêm thu nhập cùng CRABOR</Text>
          </View>

          <View style={st.card}>
            <View style={st.tabs}>
              {['phone', 'email'].map(v => (
                <TouchableOpacity
                  key={v} style={[st.tab, via === v && st.tabActive]}
                  onPress={() => { setVia(v); setStep(0); setOtp(['','','','','','']); }}
                >
                  <Text style={[st.tabText, via === v && st.tabTextActive]}>
                    {v === 'phone' ? '📱 SĐT' : '📧 Email'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {step === 0 && via === 'phone' && (
              <>
                <Text style={st.label}>Số điện thoại đã đăng ký shipper</Text>
                <TextInput style={st.input} placeholder="0xxxxxxxxx" keyboardType="phone-pad" value={phone} onChangeText={setPhone} autoFocus />
              </>
            )}
            {step === 0 && via === 'email' && (
              <>
                <Text style={st.label}>Email đã đăng ký shipper</Text>
                <TextInput style={st.input} placeholder="example@gmail.com" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} autoFocus />
              </>
            )}
            {step === 1 && (
              <>
                <Text style={st.label}>Mã OTP gửi đến {via === 'phone' ? phone : email}</Text>
                <View style={st.otpRow}>
                  {otp.map((d, i) => (
                    <TextInput
                      key={i} ref={r => refs.current[i] = r}
                      style={[st.otpBox, d && st.otpBoxFilled]}
                      value={d} onChangeText={v => handleOtp(v, i)}
                      onKeyPress={({ nativeEvent: { key } }) => key === 'Backspace' && !d && i > 0 && refs.current[i - 1]?.focus()}
                      keyboardType="number-pad" maxLength={1} textAlign="center" autoFocus={i === 0}
                    />
                  ))}
                </View>
                <TouchableOpacity onPress={() => { setStep(0); setOtp(['','','','','','']); }}>
                  <Text style={st.back}>← Đổi {via === 'phone' ? 'số' : 'email'}</Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity style={[st.btn, loading && st.btnDis]} onPress={step === 0 ? sendOTP : verifyOTP} disabled={loading}>
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={st.btnText}>{step === 0 ? 'Gửi OTP →' : 'Đăng nhập →'}</Text>}
            </TouchableOpacity>

            <View style={st.divider}><View style={st.line} /><Text style={st.or}>hoặc</Text><View style={st.line} /></View>
            <Text style={st.newHint}>Chưa đăng ký shipper?</Text>
            <TouchableOpacity
              style={st.registerBtn}
              onPress={() => Linking.openURL('https://crabor-shipper-register.onrender.com/register#shipper')}
            >
              <Text style={st.registerBtnText}>🛵 Đăng ký làm shipper CRABOR</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ============================================================
// Shipper Profile Screen
// ============================================================
export function ProfileScreen({ navigation }) {
  const [shipper, setShipper] = useState(null);
  const [loading, setLoading]   = useState(true);

  React.useEffect(() => {
    ShipperAPI.getMe().then(r => setShipper(r.shipper || r)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleLogout = async () => {
    Alert.alert('Đăng xuất?', 'Bạn sẽ không nhận được đơn sau khi đăng xuất.', [
      { text: 'Huỷ', style: 'cancel' },
      {
        text: 'Đăng xuất', style: 'destructive', onPress: async () => {
          const { Storage, KEYS } = require('../../shared/storage'); // ✅ SỬA: đường dẫn đúng
          await Storage.clear();
          navigation.replace('Login');
        }
      }
    ]);
  };

  if (loading) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={Colors.primary} /></View>;

  return (
    <SafeAreaView style={st.safe2}>
      <View style={{ backgroundColor: Colors.primary, padding: Spacing.lg }}>
        <Text style={{ fontSize: 20, fontWeight: '800', color: '#fff' }}>👤 Hồ sơ</Text>
      </View>
      <ScrollView>
        <View style={st.profileCard}>
          <View style={st.avatarBig}><Text style={{ fontSize: 48 }}>🛵</Text></View>
          <Text style={st.profileName}>{shipper?.name || 'Shipper'}</Text>
          <Text style={st.profilePhone}>{shipper?.phone}</Text>
          <View style={[st.statusBadge, { backgroundColor: shipper?.status === 'approved' ? Colors.success : Colors.warning }]}>
            <Text style={st.statusBadgeText}>{shipper?.status === 'approved' ? '✓ Đã duyệt' : '⏳ Chờ duyệt'}</Text>
          </View>
        </View>

        {[
          { icon: '🪪', label: 'CMND/CCCD', value: shipper?.idCard },
          { icon: '🏍️', label: 'Biển số xe', value: shipper?.vehiclePlate },
          { icon: '📧', label: 'Email', value: shipper?.email },
          { icon: '🗓️', label: 'Tham gia', value: shipper?.createdAt ? new Date(shipper.createdAt).toLocaleDateString('vi-VN') : '' },
        ].map((item, i) => item.value ? (
          <View key={i} style={st.infoRow}>
            <Text style={st.infoIcon}>{item.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={st.infoLabel}>{item.label}</Text>
              <Text style={st.infoValue}>{item.value}</Text>
            </View>
          </View>
        ) : null)}

        <TouchableOpacity style={st.logoutBtn} onPress={handleLogout}>
          <Text style={st.logoutBtnText}>🚪 Đăng xuất</Text>
        </TouchableOpacity>
        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.primary },
  safe2: { flex: 1, backgroundColor: Colors.gray1 },
  scroll: { flexGrow: 1, padding: Spacing.lg },
  header: { alignItems: 'center', paddingVertical: 36 },
  logo: { fontSize: 56 },
  brand: { fontSize: 32, fontWeight: '900', color: '#fff', letterSpacing: 4, marginTop: 4 },
  role: { fontSize: 16, color: 'rgba(255,255,255,0.7)', fontWeight: '700', letterSpacing: 3 },
  tagline: { fontSize: 13, color: 'rgba(255,255,255,0.8)', marginTop: 6 },
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 20, marginBottom: 24, elevation: 8 },
  tabs: { flexDirection: 'row', backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 4, marginBottom: 20 },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: Radius.sm },
  tabActive: { backgroundColor: '#fff', elevation: 2 },
  tabText: { fontSize: 13, fontWeight: '600', color: Colors.gray4 },
  tabTextActive: { color: Colors.primary, fontWeight: '800' },
  label: { fontSize: 13, fontWeight: '700', color: Colors.gray5, marginBottom: 8 },
  input: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, marginBottom: 16 },
  otpRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  otpBox: { width: 46, height: 52, borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, fontSize: 22, fontWeight: '800' },
  otpBoxFilled: { borderColor: Colors.primary, backgroundColor: Colors.cream },
  back: { color: Colors.primary, fontSize: 13, fontWeight: '600', marginBottom: 12 },
  btn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center' },
  btnDis: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 16 },
  line: { flex: 1, height: 1, backgroundColor: Colors.border },
  or: { marginHorizontal: 10, color: Colors.gray4, fontSize: 12 },
  newHint: { textAlign: 'center', color: Colors.gray5, fontSize: 13, marginBottom: 10 },
  registerBtn: { borderWidth: 1.5, borderColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 12, alignItems: 'center' },
  registerBtnText: { color: Colors.primary, fontWeight: '700', fontSize: 14 },
  // Profile
  profileCard: { backgroundColor: '#fff', margin: 16, borderRadius: 16, padding: 24, alignItems: 'center', elevation: 4 },
  avatarBig: { width: 90, height: 90, borderRadius: 45, backgroundColor: Colors.cream, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  profileName: { fontSize: 20, fontWeight: '900', color: Colors.text },
  profilePhone: { fontSize: 14, color: Colors.textSub, marginTop: 4 },
  statusBadge: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, marginTop: 10 },
  statusBadgeText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  infoRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', marginHorizontal: 16, marginBottom: 8, borderRadius: 12, padding: 14, elevation: 2 },
  infoIcon: { fontSize: 22, marginRight: 12 },
  infoLabel: { fontSize: 11, color: Colors.textSub },
  infoValue: { fontSize: 14, fontWeight: '700', color: Colors.text, marginTop: 2 },
  logoutBtn: { margin: 16, marginTop: 24, borderWidth: 1.5, borderColor: Colors.danger, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  logoutBtnText: { color: Colors.danger, fontWeight: '800', fontSize: 15 },
});