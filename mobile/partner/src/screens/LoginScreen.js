// ============================================================
// Partner Login Screen — 2 tab: Đăng nhập | Kích hoạt tài khoản
// ============================================================
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
  ActivityIndicator, StatusBar, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Radius, Spacing } from '../../shared/theme';
import { useAuth } from '../../shared/auth';
import { api } from '../../shared/api';
import { Storage, KEYS } from '../../shared/storage';
import { setSocket } from '../../shared/socket';
import { io } from 'socket.io-client';
import { BASE_URL } from '../../shared/api';

const REGISTER_URL = 'https://crabor-shipper-register.onrender.com/register#partner';
const getMsg = (e) => e?.message || e?.data?.message || e?.error || 'Đã có lỗi xảy ra';

const connectSocket = async (sessionId, cookieStr) => {
  const s = io(BASE_URL, {
    withCredentials: true,
    extraHeaders: { Cookie: cookieStr || '', 'X-Session-ID': sessionId || '' },
    reconnection: true, reconnectionDelay: 2000,
    transports: ['websocket'],
  });
  setSocket(s);
};

const saveAndLogin = async (res, setIsLoggedIn) => {
  if (res.sessionId) {
    await Storage.set(KEYS.SESSION, res.sessionId);
    await Storage.set('crabor_cookie', res.cookie || '');
    api.saveSession?.(res.sessionId, res.cookie);
    connectSocket(res.sessionId, res.cookie);
  }
  // Không cần goBack() — PartnerNavigator tự swap sang AuthStack khi isLoggedIn = true
  setIsLoggedIn(true);
};

export default function LoginScreen({ navigation }) {
  const { setIsLoggedIn } = useAuth();
  const [tab, setTab] = useState('login'); // 'login' | 'activate'

  // ── Đăng nhập state ─────────────────────────────────────────
  const [loginVia, setLoginVia] = useState('phone');
  const [loginId, setLoginId]   = useState('');
  const [loginPw, setLoginPw]   = useState('');
  const [showLPw, setShowLPw]   = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);

  // ── Kích hoạt state ──────────────────────────────────────────
  const [actVia, setActVia]     = useState('phone');
  const [actId, setActId]       = useState('');
  const [actPw, setActPw]       = useState('');
  const [actPw2, setActPw2]     = useState('');
  const [showAPw, setShowAPw]   = useState(false);
  const [actStep, setActStep]   = useState(1); // 1: nhập SĐT/email, 2: tạo mật khẩu
  const [actLoading, setActLoading] = useState(false);

  // ── Đăng nhập ────────────────────────────────────────────────
  const handleLogin = async () => {
    const id = loginVia === 'phone' ? loginId.replace(/\D/g, '') : loginId.trim();
    if (!id) return Alert.alert('Lỗi', 'Nhập số điện thoại hoặc email');
    if (!loginPw) return Alert.alert('Lỗi', 'Nhập mật khẩu');
    setLoginLoading(true);
    try {
      const res = await api.post('/api/partner/login', {
        password: loginPw,
        [loginVia === 'phone' ? 'phone' : 'email']: id,
      });
      await saveAndLogin(res, setIsLoggedIn);
    } catch (e) {
      Alert.alert('Đăng nhập thất bại', getMsg(e));
      setLoginPw('');
    } finally { setLoginLoading(false); }
  };

  // ── Kích hoạt tài khoản ──────────────────────────────────────
  const handleActNext = async () => {
    const id = actVia === 'phone' ? actId.replace(/\D/g, '') : actId.trim();
    if (!id) return Alert.alert('Lỗi', 'Nhập số điện thoại hoặc email');
    setActLoading(true);
    try {
      const res = await api.post('/api/partner/check-account', {
        [actVia === 'phone' ? 'phone' : 'email']: id,
      });
      if (res.hasPassword) {
        Alert.alert('Đã có tài khoản', 'Tài khoản này đã kích hoạt. Chuyển sang tab Đăng nhập.', [
          { text: 'OK', onPress: () => { setTab('login'); setLoginVia(actVia); setLoginId(actId); } }
        ]);
      } else {
        setActStep(2);
      }
    } catch (e) {
      if (e.status === 404) Alert.alert('Không tìm thấy', 'SĐT/email này chưa đăng ký đối tác. Đăng ký tại website!');
      else setActStep(2); // Cho thử tạo mật khẩu
    } finally { setActLoading(false); }
  };

  const handleActivate = async () => {
    const id = actVia === 'phone' ? actId.replace(/\D/g, '') : actId.trim();
    if (actPw.length < 6) return Alert.alert('Lỗi', 'Mật khẩu tối thiểu 6 ký tự');
    if (actPw !== actPw2) return Alert.alert('Lỗi', 'Mật khẩu xác nhận không khớp');
    setActLoading(true);
    try {
      const res = await api.post('/api/partner/set-password', {
        password: actPw,
        [actVia === 'phone' ? 'phone' : 'email']: id,
      });
      await saveAndLogin(res, setIsLoggedIn);
    } catch (e) { Alert.alert('Lỗi', getMsg(e)); }
    finally { setActLoading(false); }
  };

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.primary} />
      {navigation.canGoBack() && (
        <TouchableOpacity style={s.closeBtn} onPress={() => navigation.goBack()}>
          <Text style={s.closeBtnText}>✕</Text>
        </TouchableOpacity>
      )}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

          {/* Header */}
          <View style={s.header}>
            <Text style={s.logo}>🦀</Text>
            <Text style={s.brand}>CRABOR</Text>
            <Text style={s.role}>Partner</Text>
          </View>

          {/* Main tab switcher */}
          <View style={s.mainTabs}>
            <TouchableOpacity style={[s.mainTab, tab === 'login' && s.mainTabOn]}
              onPress={() => setTab('login')}>
              <Text style={[s.mainTabTxt, tab === 'login' && s.mainTabTxtOn]}>🔑 Đăng nhập</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.mainTab, tab === 'activate' && s.mainTabOn]}
              onPress={() => setTab('activate')}>
              <Text style={[s.mainTabTxt, tab === 'activate' && s.mainTabTxtOn]}>✨ Kích hoạt TK</Text>
            </TouchableOpacity>
          </View>

          {/* ══ TAB: ĐĂNG NHẬP ══ */}
          {tab === 'login' && (
            <View style={s.card}>
              <Text style={s.cardTitle}>Chào mừng trở lại!</Text>
              <Text style={s.cardSub}>Đăng nhập để quản lý cửa hàng</Text>

              {/* Via tabs */}
              <View style={s.viaTabs}>
                {['phone','email'].map(v => (
                  <TouchableOpacity key={v} style={[s.viaTab, loginVia===v && s.viaTabOn]}
                    onPress={() => { setLoginVia(v); setLoginId(''); }}>
                    <Text style={[s.viaTxt, loginVia===v && s.viaTxtOn]}>
                      {v==='phone' ? '📱 SĐT' : '📧 Email'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={s.label}>{loginVia==='phone' ? 'Số điện thoại' : 'Email'}</Text>
              <TextInput style={s.input}
                placeholder={loginVia==='phone' ? '0901 234 567' : 'email@gmail.com'}
                keyboardType={loginVia==='phone' ? 'phone-pad' : 'email-address'}
                autoCapitalize="none" value={loginId} onChangeText={setLoginId} />

              <Text style={s.label}>Mật khẩu</Text>
              <View style={s.pwRow}>
                <TextInput style={[s.input,{flex:1,marginBottom:0}]}
                  placeholder="••••••••" secureTextEntry={!showLPw}
                  value={loginPw} onChangeText={setLoginPw} />
                <TouchableOpacity style={s.eyeBtn} onPress={() => setShowLPw(v=>!v)}>
                  <Text>{showLPw?'🙈':'👁️'}</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={[s.btn, loginLoading&&s.btnDis]} onPress={handleLogin} disabled={loginLoading}>
                {loginLoading ? <ActivityIndicator color="#fff"/>
                  : <Text style={s.btnTxt}>Đăng nhập →</Text>}
              </TouchableOpacity>

              <TouchableOpacity style={s.forgotBtn}
                onPress={() => Alert.alert('🚧 Sắp ra mắt', 'Tính năng quên mật khẩu đang phát triển.')}>
                <Text style={s.forgotTxt}>Quên mật khẩu?</Text>
              </TouchableOpacity>

              {/* Google — Coming Soon */}
              <View style={s.divRow}>
                <View style={s.divLine}/><Text style={s.divTxt}>hoặc</Text><View style={s.divLine}/>
              </View>
              <TouchableOpacity style={s.googleBtn}
                onPress={() => Alert.alert('🚧 Sắp ra mắt', 'Đăng nhập Google đang được tích hợp.')}>
                <Text style={s.googleIco}>🟢</Text>
                <Text style={s.googleTxt}>Đăng nhập với Google</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ══ TAB: KÍCH HOẠT TÀI KHOẢN ══ */}
          {tab === 'activate' && (
            <View style={s.card}>
              <Text style={s.cardTitle}>Kích hoạt tài khoản</Text>
              <Text style={s.cardSub}>Dành cho đối tác vừa đăng ký trên website</Text>

              {actStep === 1 && (
                <>
                  <View style={s.viaTabs}>
                    {['phone','email'].map(v => (
                      <TouchableOpacity key={v} style={[s.viaTab, actVia===v && s.viaTabOn]}
                        onPress={() => { setActVia(v); setActId(''); }}>
                        <Text style={[s.viaTxt, actVia===v && s.viaTxtOn]}>
                          {v==='phone' ? '📱 SĐT' : '📧 Email'}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={s.label}>{actVia==='phone' ? 'SĐT đã đăng ký trên web' : 'Email đã đăng ký'}</Text>
                  <TextInput style={s.input}
                    placeholder={actVia==='phone' ? '0901 234 567' : 'email@gmail.com'}
                    keyboardType={actVia==='phone' ? 'phone-pad' : 'email-address'}
                    autoCapitalize="none" autoFocus value={actId} onChangeText={setActId} />
                  <TouchableOpacity style={[s.btn, actLoading&&s.btnDis]} onPress={handleActNext} disabled={actLoading}>
                    {actLoading ? <ActivityIndicator color="#fff"/>
                      : <Text style={s.btnTxt}>Tiếp theo →</Text>}
                  </TouchableOpacity>
                </>
              )}

              {actStep === 2 && (
                <>
                  <View style={s.identBadge}>
                    <Text style={s.identTxt}>{actVia==='phone'?'📱':'📧'} {actId}</Text>
                    <TouchableOpacity onPress={() => { setActStep(1); setActPw(''); setActPw2(''); }}>
                      <Text style={s.changeTxt}>Đổi</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={s.label}>Tạo mật khẩu (tối thiểu 6 ký tự)</Text>
                  <View style={s.pwRow}>
                    <TextInput style={[s.input,{flex:1,marginBottom:0}]}
                      placeholder="••••••••" secureTextEntry={!showAPw} autoFocus
                      value={actPw} onChangeText={setActPw} />
                    <TouchableOpacity style={s.eyeBtn} onPress={() => setShowAPw(v=>!v)}>
                      <Text>{showAPw?'🙈':'👁️'}</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={[s.label,{marginTop:12}]}>Xác nhận mật khẩu</Text>
                  <TextInput style={s.input} placeholder="••••••••"
                    secureTextEntry={!showAPw} value={actPw2} onChangeText={setActPw2} />
                  <TouchableOpacity style={[s.btn, actLoading&&s.btnDis]} onPress={handleActivate} disabled={actLoading}>
                    {actLoading ? <ActivityIndicator color="#fff"/>
                      : <Text style={s.btnTxt}>✓ Kích hoạt & Đăng nhập</Text>}
                  </TouchableOpacity>
                </>
              )}

              <View style={s.registerHint}>
                <Text style={s.registerHintTxt}>Chưa đăng ký? </Text>
                <TouchableOpacity onPress={() => Linking.openURL(REGISTER_URL)}>
                  <Text style={s.registerLink}>Đăng ký tại website →</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Benefits */}
          <View style={s.benefitCard}>
            {[
              {icon:'📦', txt:'Nhận đơn realtime, không bỏ lỡ khách'},
              {icon:'💰', txt:'Thanh toán tự động, rút tiền mọi lúc'},
              {icon:'📊', txt:'Thống kê doanh thu chi tiết'},
              {icon:'🚀', txt:'Tiếp cận hàng nghìn khách trong khu vực'},
            ].map((b,i) => (
              <View key={i} style={s.benefitRow}>
                <Text style={s.benefitIco}>{b.icon}</Text>
                <Text style={s.benefitTxt}>{b.txt}</Text>
              </View>
            ))}
          </View>
          <View style={{height:32}}/>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex:1, backgroundColor: Colors.primary },
  scroll: { flexGrow:1, padding: Spacing.lg },
  closeBtn: { position:'absolute', top:52, right:20, zIndex:10, padding:8 },
  closeBtnText: { color:'#fff', fontSize:22, fontWeight:'700' },
  header: { alignItems:'center', paddingVertical:24 },
  logo: { fontSize:48 },
  brand: { fontSize:28, fontWeight:'900', color:'#fff', letterSpacing:4, marginTop:4 },
  role: { fontSize:14, color:'rgba(255,255,255,0.7)', fontWeight:'700', letterSpacing:3 },
  // Main tabs
  mainTabs: { flexDirection:'row', backgroundColor:'rgba(255,255,255,0.15)', borderRadius:Radius.lg, padding:4, marginBottom:16 },
  mainTab: { flex:1, paddingVertical:12, alignItems:'center', borderRadius:Radius.md },
  mainTabOn: { backgroundColor:'#fff' },
  mainTabTxt: { fontSize:13, fontWeight:'700', color:'rgba(255,255,255,0.75)' },
  mainTabTxtOn: { color: Colors.primary, fontWeight:'900' },
  // Card
  card: { backgroundColor:'#fff', borderRadius:20, padding:20, elevation:8, marginBottom:4 },
  cardTitle: { fontSize:18, fontWeight:'900', color: Colors.text, marginBottom:4 },
  cardSub: { fontSize:13, color: Colors.textSub, marginBottom:20 },
  // Via tabs
  viaTabs: { flexDirection:'row', backgroundColor: Colors.gray1, borderRadius:Radius.md, padding:4, marginBottom:16 },
  viaTab: { flex:1, paddingVertical:9, alignItems:'center', borderRadius:Radius.sm },
  viaTabOn: { backgroundColor:'#fff', elevation:2 },
  viaTxt: { fontSize:13, fontWeight:'600', color: Colors.gray4 },
  viaTxtOn: { color: Colors.primary, fontWeight:'800' },
  // Form
  label: { fontSize:12, fontWeight:'700', color: Colors.gray5, marginBottom:6 },
  input: { borderWidth:1.5, borderColor: Colors.border, borderRadius:Radius.md, paddingHorizontal:14, paddingVertical:12, fontSize:15, marginBottom:14, color: Colors.text },
  pwRow: { flexDirection:'row', alignItems:'center', borderWidth:1.5, borderColor: Colors.border, borderRadius:Radius.md, marginBottom:14, paddingRight:10, overflow:'hidden' },
  eyeBtn: { padding:8 },
  btn: { backgroundColor: Colors.primary, borderRadius:Radius.md, paddingVertical:14, alignItems:'center', marginTop:4 },
  btnDis: { opacity:0.6 },
  btnTxt: { color:'#fff', fontWeight:'900', fontSize:15 },
  forgotBtn: { alignItems:'center', marginTop:12 },
  forgotTxt: { color: Colors.gray4, fontSize:13, fontWeight:'600' },
  // Google
  divRow: { flexDirection:'row', alignItems:'center', marginVertical:16, gap:10 },
  divLine: { flex:1, height:1, backgroundColor: Colors.border },
  divTxt: { color: Colors.gray4, fontSize:12, fontWeight:'700' },
  googleBtn: { flexDirection:'row', alignItems:'center', justifyContent:'center', gap:10, borderWidth:1.5, borderColor: Colors.border, borderRadius:Radius.md, paddingVertical:13 },
  googleIco: { fontSize:18 },
  googleTxt: { fontSize:14, fontWeight:'800', color: Colors.text },
  // Activate
  identBadge: { flexDirection:'row', alignItems:'center', justifyContent:'space-between', backgroundColor: Colors.gray1, borderRadius:Radius.md, paddingHorizontal:14, paddingVertical:10, marginBottom:18 },
  identTxt: { fontSize:14, fontWeight:'700', color: Colors.text },
  changeTxt: { fontSize:13, fontWeight:'800', color: Colors.primary },
  registerHint: { flexDirection:'row', alignItems:'center', justifyContent:'center', marginTop:16 },
  registerHintTxt: { fontSize:13, color: Colors.gray4 },
  registerLink: { fontSize:13, fontWeight:'800', color: Colors.primary },
  // Benefits
  benefitCard: { backgroundColor:'rgba(255,255,255,0.12)', borderRadius:16, padding:16, marginTop:12 },
  benefitRow: { flexDirection:'row', alignItems:'center', marginBottom:10, gap:10 },
  benefitIco: { fontSize:18, width:28 },
  benefitTxt: { fontSize:13, color:'rgba(255,255,255,0.9)', flex:1, lineHeight:20 },
});
