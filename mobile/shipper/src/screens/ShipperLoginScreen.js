// ============================================================
// CRABOR Shipper Login — No OTP (check account + password)
// ============================================================
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
  ActivityIndicator, StatusBar, Vibration, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Radius, Spacing } from '../../shared/theme';
import { api } from '../../shared/api';
import { Storage, KEYS } from '../../shared/storage';

export default function ShipperLoginScreen({ navigation }) {
  const [via, setVia]           = useState('phone');
  const [identifier, setId]     = useState('');
  const [step, setStep]         = useState('input');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [loading, setLoading]   = useState(false);

  const vib = () => Vibration.vibrate(30);

  const checkAccount = async () => {
    vib();
    const val = identifier.trim();
    if (!val) return Alert.alert('Lỗi', 'Nhập thông tin đăng nhập');
    setLoading(true);
    try {
      const res = await api.post('/api/shipper/check-account', {
        [via === 'phone' ? 'phone' : 'email']: val,
      });
      if (!res.exists)
        return Alert.alert('Chưa đăng ký', 'Số điện thoại/email chưa đăng ký shipper.\nVui lòng đăng ký tại website.');
      setStep(res.hasPassword ? 'password' : 'create');
    } catch(e) { Alert.alert('Lỗi', e.message); }
    finally { setLoading(false); }
  };

  const handleLogin = async () => {
    vib();
    if (!password) return Alert.alert('Lỗi', 'Nhập mật khẩu');
    setLoading(true);
    try {
      const res = await api.post('/api/shipper/login', {
        [via === 'phone' ? 'phone' : 'email']: identifier.trim(), password,
      });
      if (res.cookie) await Storage.set(KEYS.SESSION, res.cookie);
      if (res.shipper) await Storage.set(KEYS.USER, res.shipper);
      navigation.replace('Main');
    } catch(e) { Alert.alert('Sai mật khẩu', e.message); }
    finally { setLoading(false); }
  };

  const handleSetPassword = async () => {
    vib();
    if (password.length < 6) return Alert.alert('Lỗi', 'Mật khẩu tối thiểu 6 ký tự');
    if (password !== confirmPw) return Alert.alert('Lỗi', 'Mật khẩu không khớp');
    setLoading(true);
    try {
      const res = await api.post('/api/shipper/set-password', {
        [via === 'phone' ? 'phone' : 'email']: identifier.trim(), password,
      });
      if (res.cookie) await Storage.set(KEYS.SESSION, res.cookie);
      if (res.shipper) await Storage.set(KEYS.USER, res.shipper);
      navigation.replace('Main');
    } catch(e) { Alert.alert('Lỗi', e.message); }
    finally { setLoading(false); }
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
            <Text style={st.tagline}>Nhận đơn — Giao nhanh — Thu nhập tốt</Text>
          </View>
          <View style={st.card}>
            {step === 'input' && (
              <>
                <Text style={st.title}>Đăng nhập Shipper</Text>
                <View style={st.tabs}>
                  {[['phone','📱 SĐT'],['email','📧 Email']].map(([v,l]) => (
                    <TouchableOpacity key={v} style={[st.tab, via===v && st.tabActive]}
                      onPress={() => { vib(); setVia(v); setId(''); }}>
                      <Text style={[st.tabText, via===v && st.tabTextActive]}>{l}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput style={st.input}
                  placeholder={via==='phone' ? '0xxxxxxxxx' : 'email@gmail.com'}
                  keyboardType={via==='phone' ? 'phone-pad' : 'email-address'}
                  autoCapitalize="none" autoFocus
                  value={identifier} onChangeText={setId}
                  onSubmitEditing={checkAccount}
                />
                <TouchableOpacity style={[st.btn, loading && st.btnDis]} onPress={checkAccount} disabled={loading}>
                  {loading ? <ActivityIndicator color="#fff"/> : <Text style={st.btnText}>Tiếp tục →</Text>}
                </TouchableOpacity>
                <View style={st.divider}><View style={st.line}/><Text style={st.or}>hoặc</Text><View style={st.line}/></View>
                <Text style={st.hint}>Chưa đăng ký shipper?</Text>
                <TouchableOpacity style={st.regBtn} onPress={() => Linking.openURL('https://crabor-shipper-register.onrender.com/register#shipper')}>
                  <Text style={st.regBtnText}>🛵 Đăng ký làm shipper</Text>
                </TouchableOpacity>
              </>
            )}
            {step === 'password' && (
              <>
                <TouchableOpacity onPress={() => { vib(); setStep('input'); setPassword(''); }}>
                  <Text style={{ color: Colors.primary, fontWeight: '700', marginBottom: 12 }}>← {identifier}</Text>
                </TouchableOpacity>
                <Text style={st.title}>🔐 Nhập mật khẩu</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                  <TextInput style={[st.input, { flex: 1, marginBottom: 0 }]}
                    placeholder="Mật khẩu" secureTextEntry={!showPw}
                    value={password} onChangeText={setPassword} autoFocus
                    onSubmitEditing={handleLogin}
                  />
                  <TouchableOpacity style={{ padding: 8 }} onPress={() => setShowPw(p=>!p)}>
                    <Text style={{ fontSize: 18 }}>{showPw ? '🙈' : '👁️'}</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity style={[st.btn, loading && st.btnDis]} onPress={handleLogin} disabled={loading}>
                  {loading ? <ActivityIndicator color="#fff"/> : <Text style={st.btnText}>Đăng nhập →</Text>}
                </TouchableOpacity>
              </>
            )}
            {step === 'create' && (
              <>
                <TouchableOpacity onPress={() => { vib(); setStep('input'); setPassword(''); setConfirmPw(''); }}>
                  <Text style={{ color: Colors.primary, fontWeight: '700', marginBottom: 12 }}>← {identifier}</Text>
                </TouchableOpacity>
                <Text style={st.title}>🔑 Tạo mật khẩu đăng nhập</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                  <TextInput style={[st.input, { flex: 1, marginBottom: 0 }]}
                    placeholder="Mật khẩu (tối thiểu 6 ký tự)" secureTextEntry={!showPw}
                    value={password} onChangeText={setPassword} autoFocus
                  />
                  <TouchableOpacity style={{ padding: 8 }} onPress={() => setShowPw(p=>!p)}>
                    <Text style={{ fontSize: 18 }}>{showPw ? '🙈' : '👁️'}</Text>
                  </TouchableOpacity>
                </View>
                <TextInput style={st.input} placeholder="Nhập lại mật khẩu"
                  secureTextEntry={!showPw} value={confirmPw} onChangeText={setConfirmPw}
                  onSubmitEditing={handleSetPassword}
                />
                <TouchableOpacity style={[st.btn, loading && st.btnDis]} onPress={handleSetPassword} disabled={loading}>
                  {loading ? <ActivityIndicator color="#fff"/> : <Text style={st.btnText}>Xác nhận →</Text>}
                </TouchableOpacity>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const st = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.primary },
  scroll: { flexGrow: 1, paddingBottom: 32 },
  header: { alignItems: 'center', paddingVertical: 36, paddingHorizontal: 24 },
  logo: { fontSize: 60 },
  brand: { fontSize: 32, fontWeight: '900', color: '#fff', letterSpacing: 4, marginTop: 6 },
  role: { fontSize: 14, color: 'rgba(255,255,255,0.75)', fontWeight: '700', letterSpacing: 3, marginTop: 2 },
  tagline: { fontSize: 13, color: 'rgba(255,255,255,0.8)', marginTop: 6 },
  card: { backgroundColor: '#fff', borderRadius: 24, marginHorizontal: 16, padding: 24, elevation: 8 },
  title: { fontSize: 18, fontWeight: '800', marginBottom: 16, textAlign: 'center' },
  tabs: { flexDirection: 'row', backgroundColor: '#F5F5F5', borderRadius: 12, padding: 4, marginBottom: 16 },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: '#fff', elevation: 2 },
  tabText: { fontSize: 13, fontWeight: '600', color: '#999' },
  tabTextActive: { color: Colors.primary, fontWeight: '800' },
  input: { borderWidth: 1.5, borderColor: '#EEE', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, marginBottom: 14 },
  btn: { backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  btnDis: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 16 },
  line: { flex: 1, height: 1, backgroundColor: '#EEE' },
  or: { marginHorizontal: 10, color: '#999', fontSize: 12 },
  hint: { textAlign: 'center', color: '#666', fontSize: 13, marginBottom: 10 },
  regBtn: { borderWidth: 1.5, borderColor: Colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  regBtnText: { color: Colors.primary, fontWeight: '700', fontSize: 14 },
});
