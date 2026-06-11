// ============================================================
// CRABOR Customer — Login Screen (No OTP)
// Nhập SĐT/email → check account → nhập/tạo password → vào app
// ============================================================
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
  ActivityIndicator, StatusBar, Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Radius, Spacing } from '../../shared/theme';
import { AuthAPI } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { Storage, KEYS } from '../../shared/storage';

export default function LoginScreen({ navigation }) {
  const { login } = useAuth();
  const [via, setVia]             = useState('phone');
  const [identifier, setIdentifier] = useState('');
  const [step, setStep]           = useState('input');  // input | password | create
  const [password, setPassword]   = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [name, setName]           = useState('');
  const [showPw, setShowPw]       = useState(false);
  const [loading, setLoading]     = useState(false);

  const vib = () => Vibration.vibrate(30);

  const handleCheckAccount = async () => {
    vib();
    const val = identifier.trim();
    if (!val) return Alert.alert('Lỗi', via === 'phone' ? 'Nhập số điện thoại' : 'Nhập email');
    if (via === 'phone' && val.replace(/\D/g,'').length < 9)
      return Alert.alert('Lỗi', 'Số điện thoại không hợp lệ');
    if (via === 'email' && !val.includes('@'))
      return Alert.alert('Lỗi', 'Email không hợp lệ');
    setLoading(true);
    try {
      const res = await AuthAPI.checkAccount(val);
      if (res.exists && res.hasPassword) setStep('password');
      else if (res.exists && !res.hasPassword) setStep('create');
      else setStep('create'); // tài khoản mới
    } catch(e) {
      // Nếu endpoint lỗi, mặc định cho tạo tài khoản
      setStep('create');
    } finally { setLoading(false); }
  };

  const handleLogin = async () => {
    vib();
    if (!password) return Alert.alert('Lỗi', 'Nhập mật khẩu');
    setLoading(true);
    try {
      const res = await AuthAPI.loginForm(identifier.trim(), password);
      await login(res.user, res.cookie);
      if (res.cookie) await Storage.set(KEYS.SESSION, res.cookie);
      if (res.user?._id) await Storage.set(KEYS.USER, res.user);
      navigation.replace('Main');
    } catch(e) {
      Alert.alert('Sai mật khẩu', e.message || 'Mật khẩu không đúng');
    } finally { setLoading(false); }
  };

  const handleCreate = async () => {
    vib();
    if (!name.trim()) return Alert.alert('Lỗi', 'Nhập họ tên');
    if (password.length < 6) return Alert.alert('Lỗi', 'Mật khẩu ít nhất 6 ký tự');
    if (password !== confirmPw) return Alert.alert('Lỗi', 'Mật khẩu không khớp');
    setLoading(true);
    try {
      const val = identifier.trim();
      const res = await AuthAPI.register({
        name:     name.trim(),
        phone:    via === 'phone' ? val.replace(/\D/g,'') : undefined,
        email:    via === 'email' ? val.toLowerCase()     : undefined,
        password,
      });
      await login(res.user, res.cookie);
      if (res.cookie) await Storage.set(KEYS.SESSION, res.cookie);
      if (res.user?._id) await Storage.set(KEYS.USER, res.user);
      navigation.replace('Main');
    } catch(e) {
      Alert.alert('Thất bại', e.message);
    } finally { setLoading(false); }
  };

  const reset = () => { vib(); setStep('input'); setPassword(''); setConfirmPw(''); setName(''); };

  return (
    <SafeAreaView style={st.safe}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.primary} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled">

          {/* Header */}
          <View style={st.header}>
            <Text style={st.logo}>🦀</Text>
            <Text style={st.brand}>CRABOR</Text>
            <Text style={st.tagline}>Giao nhanh — Tiện lợi — Uy tín</Text>
          </View>

          <View style={st.card}>
            {/* Step: nhập SĐT/email */}
            {step === 'input' && (
              <>
                <Text style={st.cardTitle}>👋 Xin chào!</Text>
                <Text style={st.cardSub}>Nhập thông tin để đăng nhập hoặc tạo tài khoản</Text>
                <View style={st.tabs}>
                  {[['phone','📱 SĐT'],['email','📧 Email']].map(([v,label]) => (
                    <TouchableOpacity key={v} style={[st.tab, via===v && st.tabActive]}
                      onPress={() => { vib(); setVia(v); setIdentifier(''); }}>
                      <Text style={[st.tabText, via===v && st.tabTextActive]}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput
                  style={st.input}
                  placeholder={via==='phone' ? '0xxxxxxxxx' : 'email@gmail.com'}
                  keyboardType={via==='phone' ? 'phone-pad' : 'email-address'}
                  autoCapitalize="none" autoFocus
                  value={identifier} onChangeText={setIdentifier}
                  onSubmitEditing={handleCheckAccount} returnKeyType="next"
                />
                <TouchableOpacity style={[st.btn, loading && st.btnDis]} onPress={handleCheckAccount} disabled={loading}>
                  {loading ? <ActivityIndicator color="#fff"/> : <Text style={st.btnText}>Tiếp tục →</Text>}
                </TouchableOpacity>
              </>
            )}

            {/* Step: nhập mật khẩu (đăng nhập) */}
            {step === 'password' && (
              <>
                <TouchableOpacity onPress={reset} style={{ marginBottom: 12 }}>
                  <Text style={{ color: Colors.primary, fontWeight: '700' }}>← {identifier}</Text>
                </TouchableOpacity>
                <Text style={st.cardTitle}>🔐 Nhập mật khẩu</Text>
                <View style={st.pwRow}>
                  <TextInput
                    style={[st.input, { flex: 1, marginBottom: 0 }]}
                    placeholder="Mật khẩu" secureTextEntry={!showPw}
                    value={password} onChangeText={setPassword}
                    autoFocus onSubmitEditing={handleLogin}
                  />
                  <TouchableOpacity style={st.eyeBtn} onPress={() => setShowPw(p => !p)}>
                    <Text style={{ fontSize: 18 }}>{showPw ? '🙈' : '👁️'}</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity style={[st.btn, loading && st.btnDis]} onPress={handleLogin} disabled={loading}>
                  {loading ? <ActivityIndicator color="#fff"/> : <Text style={st.btnText}>Đăng nhập →</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={st.forgotBtn} onPress={() => { vib(); setStep('create'); setPassword(''); }}>
                  <Text style={st.forgotText}>Quên mật khẩu? Tạo mật khẩu mới</Text>
                </TouchableOpacity>
              </>
            )}

            {/* Step: tạo mật khẩu (đăng ký / quên mật khẩu) */}
            {step === 'create' && (
              <>
                <TouchableOpacity onPress={reset} style={{ marginBottom: 12 }}>
                  <Text style={{ color: Colors.primary, fontWeight: '700' }}>← {identifier}</Text>
                </TouchableOpacity>
                <Text style={st.cardTitle}>✨ Tạo tài khoản</Text>
                <TextInput
                  style={st.input} placeholder="Họ và tên"
                  value={name} onChangeText={setName}
                  autoCapitalize="words" autoFocus
                />
                <View style={st.pwRow}>
                  <TextInput
                    style={[st.input, { flex: 1, marginBottom: 0 }]}
                    placeholder="Mật khẩu (tối thiểu 6 ký tự)" secureTextEntry={!showPw}
                    value={password} onChangeText={setPassword}
                  />
                  <TouchableOpacity style={st.eyeBtn} onPress={() => setShowPw(p => !p)}>
                    <Text style={{ fontSize: 18 }}>{showPw ? '🙈' : '👁️'}</Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  style={st.input} placeholder="Nhập lại mật khẩu"
                  secureTextEntry={!showPw} value={confirmPw} onChangeText={setConfirmPw}
                  onSubmitEditing={handleCreate}
                />
                <TouchableOpacity style={[st.btn, loading && st.btnDis]} onPress={handleCreate} disabled={loading}>
                  {loading ? <ActivityIndicator color="#fff"/> : <Text style={st.btnText}>Tạo tài khoản →</Text>}
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
  tagline: { fontSize: 13, color: 'rgba(255,255,255,0.8)', marginTop: 6 },
  card: { backgroundColor: '#fff', borderRadius: 24, marginHorizontal: 16, padding: 24, marginBottom: 24, elevation: 8 },
  cardTitle: { fontSize: 20, fontWeight: '800', color: '#1A1A1A', marginBottom: 6, textAlign: 'center' },
  cardSub: { fontSize: 13, color: '#999', textAlign: 'center', marginBottom: 20 },
  tabs: { flexDirection: 'row', backgroundColor: '#F5F5F5', borderRadius: 12, padding: 4, marginBottom: 16 },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: '#fff', elevation: 2 },
  tabText: { fontSize: 13, fontWeight: '600', color: '#999' },
  tabTextActive: { color: Colors.primary, fontWeight: '800' },
  input: { borderWidth: 1.5, borderColor: '#EEE', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, marginBottom: 14 },
  pwRow: { flexDirection: 'row', gap: 8, marginBottom: 14, alignItems: 'center' },
  eyeBtn: { padding: 8 },
  btn: { backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  btnDis: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  forgotBtn: { alignItems: 'center', marginTop: 14 },
  forgotText: { color: Colors.primary, fontSize: 13, fontWeight: '600' },
});
