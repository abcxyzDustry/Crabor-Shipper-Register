// ============================================================
// CRABOR Admin — React Native App (Full version)
// Dashboard · Wallet · Vouchers · Orders · Users · Settings
// ============================================================
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, ActivityIndicator, TextInput,
  Modal, FlatList, Vibration, StatusBar, Dimensions, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE_URL = 'https://crabor-shipper-register.onrender.com';
const W = Dimensions.get('window').width;
const vib = () => Vibration.vibrate(30);
function fmtMoney(n) { return (n||0).toLocaleString('vi-VN') + 'đ'; }
function fmtDate(d) { return d ? new Date(d).toLocaleString('vi-VN') : '—'; }

// ── API ──────────────────────────────────────────────────────
let _cookie = '';
async function adminFetch(path, method = 'GET', body = null) {
  if (!_cookie) _cookie = await AsyncStorage.getItem('admin_cookie') || '';
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: _cookie },
    ...(body && { body: JSON.stringify(body) }),
    credentials: 'include',
  });
  const sc = res.headers.get('set-cookie');
  if (sc) { _cookie = sc.split(';')[0]; await AsyncStorage.setItem('admin_cookie', _cookie); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw { status: res.status, message: data.message || `HTTP ${res.status}` };
  return data;
}

const Tab = createBottomTabNavigator();
const STATUS_COLOR = { pending:'#F39C12', confirmed:'#3498DB', preparing:'#3498DB', ready:'#9B59B6', picking_up:'#E67E22', delivering:'#E8504A', delivered:'#27AE60', cancelled:'#E74C3C' };

// ── Login ─────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);

  const doLogin = async () => {
    vib();
    if (!username || !password) return Alert.alert('Lỗi', 'Nhập đầy đủ thông tin');
    setLoading(true);
    try {
      await adminFetch('/api/admin/login', 'POST', { username, password });
      await AsyncStorage.setItem('admin_logged', '1');
      onLogin();
    } catch(e) { Alert.alert('Sai thông tin', e.message || 'Kiểm tra lại username/password'); }
    finally { setLoading(false); }
  };

  return (
    <SafeAreaView style={st.loginSafe}>
      <StatusBar barStyle="light-content" backgroundColor="#E8504A"/>
      <View style={st.loginHeader}>
        <Text style={{fontSize:72}}>🦀</Text>
        <Text style={st.loginBrand}>CRABOR Admin</Text>
        <Text style={{color:'rgba(255,255,255,0.7)',fontSize:13,marginTop:4}}>Dashboard quản trị</Text>
      </View>
      <View style={st.loginCard}>
        <TextInput style={st.inp} placeholder="Username" value={username} onChangeText={setUsername} autoCapitalize="none" autoFocus/>
        <TextInput style={st.inp} placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry onSubmitEditing={doLogin}/>
        <TouchableOpacity style={[st.btn,loading&&{opacity:0.6}]} onPress={doLogin} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff"/> : <Text style={st.btnTxt}>Đăng nhập →</Text>}
        </TouchableOpacity>
        <View style={{backgroundColor:'#FFF9E6',borderRadius:10,padding:12,marginTop:16}}>
          <Text style={{fontSize:12,fontWeight:'800',color:'#856404',marginBottom:4}}>🔑 Thông tin đăng nhập mặc định</Text>
          <Text style={{fontSize:12,color:'#666'}}>Username: admin{'\n'}Password: admin123</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ── Dashboard ─────────────────────────────────────────────────
function DashboardTab({ onLogout }) {
  const [stats, setStats]       = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const [s, wq] = await Promise.allSettled([
        adminFetch('/api/admin/stats'),
        adminFetch('/api/admin/wallet-queue/stats'),
      ]);
      const sd = s.status==='fulfilled' ? s.value : {};
      const wd = wq.status==='fulfilled' ? wq.value : {};
      setStats({ ...sd, ...wd });
      setPendingCount(wd.pending || 0);
    } catch(e) { Alert.alert('Lỗi', e.message); }
    finally { setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, []);

  const cards = stats ? [
    { icon:'📦', label:'Đơn hôm nay',       value: stats.ordersToday || 0,            color:'#3498DB' },
    { icon:'💰', label:'Doanh thu hôm nay',  value: fmtMoney(stats.revenueToday),      color:'#27AE60' },
    { icon:'👤', label:'Khách hàng',          value: stats.totalCustomers || 0,         color:'#9B59B6' },
    { icon:'🛵', label:'Shipper đang online', value: stats.shippersOnline || 0,         color:'#E67E22' },
    { icon:'🏪', label:'Partner đang mở',    value: stats.partnersAccepting || 0,      color:'#1ABC9C' },
    { icon:'⏳', label:'Ví chờ duyệt',        value: pendingCount,                      color:'#F39C12' },
    { icon:'💵', label:'Tổng chờ duyệt',      value: fmtMoney(stats.totalPendingAmount),color:'#E8504A' },
    { icon:'🏦', label:'Ví customer',         value: fmtMoney(stats.totalCustomerWallet),color:'#6495ED' },
  ] : [];

  return (
    <SafeAreaView style={st.safe}>
      <View style={st.pageHeader}>
        <Text style={st.pageTitle}>📊 Dashboard</Text>
        <TouchableOpacity onPress={() => { vib(); onLogout(); }} style={{padding:6}}>
          <Text style={{color:'rgba(255,255,255,0.8)',fontSize:12,fontWeight:'700'}}>Đăng xuất</Text>
        </TouchableOpacity>
      </View>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => {setRefreshing(true);load();}} tintColor="#E8504A"/>}
        contentContainerStyle={{padding:12,paddingBottom:32}}
      >
        <View style={{flexDirection:'row',flexWrap:'wrap',gap:10}}>
          {cards.map((c,i) => (
            <View key={i} style={[st.statCard,{borderTopColor:c.color}]}>
              <Text style={{fontSize:22,marginBottom:4}}>{c.icon}</Text>
              <Text style={[st.statVal,{color:c.color}]}>{c.value}</Text>
              <Text style={st.statLbl}>{c.label}</Text>
            </View>
          ))}
        </View>
        {!stats && <ActivityIndicator color="#E8504A" style={{marginTop:40}}/>}

        {/* Quick links */}
        <Text style={{fontWeight:'800',fontSize:14,marginTop:20,marginBottom:10}}>⚡ Tác vụ nhanh</Text>
        {pendingCount > 0 && (
          <View style={st.alertCard}>
            <Text style={{color:'#856404',fontWeight:'800',fontSize:14}}>
              ⚠️ Có {pendingCount} mục ví đang chờ duyệt!
            </Text>
            <Text style={{color:'#666',fontSize:12,marginTop:4}}>Chuyển sang tab "Duyệt ví" để xử lý</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Wallet Queue ──────────────────────────────────────────────
function WalletTab() {
  const [queue, setQueue]     = useState([]);
  const [status, setStatus]   = useState('pending');
  const [type, setType]       = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRef]  = useState(false);
  const [processing, setProc] = useState({});
  const [stats, setStats]     = useState(null);

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.allSettled([
        adminFetch(`/api/admin/wallet-queue?status=${status}&limit=30${type?`&recipientType=${type}`:''}`),
        adminFetch('/api/admin/wallet-queue/stats'),
      ]);
      if (r.status==='fulfilled') setQueue(r.value.queue || []);
      if (s.status==='fulfilled') setStats(s.value);
    } catch(e) { Alert.alert('Lỗi', e.message); }
    finally { setLoading(false); setRef(false); }
  }, [status, type]);

  useEffect(() => { setLoading(true); load(); }, [status, type]);

  const approve = async (id) => {
    vib();
    setProc(p=>({...p,[id]:true}));
    try {
      const r = await adminFetch(`/api/admin/wallet-queue/${id}/approve`, 'POST');
      if(r.success) { load(); }
    } catch(e) { Alert.alert('Lỗi', e.message); }
    finally { setProc(p=>({...p,[id]:false})); }
  };

  const reject = (id) => {
    vib();
    Alert.prompt('Lý do từ chối','',async reason => {
      if(!reason) return;
      try { await adminFetch(`/api/admin/wallet-queue/${id}/reject`,'POST',{reason}); load(); }
      catch(e) { Alert.alert('Lỗi',e.message); }
    });
  };

  const approveAll = () => {
    vib();
    Alert.alert(`Duyệt tất cả ${queue.filter(i=>i.status==='pending').length} mục?`,'',[ 
      {text:'Huỷ',style:'cancel'},
      {text:'Duyệt tất cả',onPress:async()=>{
        try {
          const r = await adminFetch('/api/admin/wallet-queue/approve-all','POST');
          Alert.alert('✅ Xong',`Đã duyệt ${r.approved} — ${fmtMoney(r.totalAmount)}`);
          load();
        } catch(e) { Alert.alert('Lỗi',e.message); }
      }}
    ]);
  };

  return (
    <SafeAreaView style={st.safe}>
      <View style={st.pageHeader}>
        <Text style={st.pageTitle}>💰 Duyệt ví</Text>
        {status==='pending' && queue.length>0 && (
          <TouchableOpacity onPress={approveAll} style={st.headerBtn}>
            <Text style={{color:'#fff',fontWeight:'800',fontSize:12}}>✅ Duyệt tất cả</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Stats mini */}
      {stats && (
        <View style={{flexDirection:'row',backgroundColor:'#fff',padding:10,gap:6,borderBottomWidth:1,borderBottomColor:'#EEE'}}>
          {[['⏳',stats.pending,'Chờ','#F39C12'],['✅',stats.approvedToday,'Hôm nay','#27AE60'],['🏦',fmtMoney(stats.totalCustomerWallet),'Ví CU','#6495ED'],['🏪',fmtMoney(stats.totalPartnerWallet),'Ví PT','#E8504A']].map(([ico,val,lbl,c],i) => (
            <View key={i} style={{flex:1,alignItems:'center'}}>
              <Text style={{fontSize:11,fontWeight:'900',color:c}}>{ico} {val}</Text>
              <Text style={{fontSize:9,color:'#999'}}>{lbl}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Filters */}
      <View style={{flexDirection:'row',backgroundColor:'#fff',borderBottomWidth:1,borderBottomColor:'#EEE'}}>
        {['pending','approved','rejected'].map(s=>(
          <TouchableOpacity key={s} style={[{flex:1,paddingVertical:9,alignItems:'center',borderBottomWidth:2,borderBottomColor:'transparent'},status===s&&{borderBottomColor:'#E8504A'}]}
            onPress={()=>{vib();setStatus(s);}}>
            <Text style={[{fontSize:11,fontWeight:'700',color:'#999'},status===s&&{color:'#E8504A'}]}>
              {s==='pending'?'⏳ Chờ':s==='approved'?'✅ Duyệt':'❌ Từ chối'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {/* Type filter */}
      <View style={{flexDirection:'row',backgroundColor:'#F9F9F9',padding:8,gap:6}}>
        {[['','Tất cả'],['shipper','🛵 Shipper'],['partner','🏪 Partner']].map(([v,l])=>(
          <TouchableOpacity key={v} style={[{paddingHorizontal:10,paddingVertical:5,borderRadius:20,borderWidth:1.5,borderColor:'#EEE',backgroundColor:'#fff'},type===v&&{borderColor:'#E8504A',backgroundColor:'#FFF5F4'}]}
            onPress={()=>{vib();setType(v);}}>
            <Text style={[{fontSize:11,fontWeight:'700',color:'#999'},type===v&&{color:'#E8504A'}]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? <ActivityIndicator color="#E8504A" style={{flex:1}}/> : (
        <FlatList
          data={queue}
          keyExtractor={i=>i._id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={()=>{setRef(true);load();}} tintColor="#E8504A"/>}
          contentContainerStyle={{padding:10}}
          ListEmptyComponent={<View style={{alignItems:'center',paddingVertical:48}}><Text style={{fontSize:40}}>📭</Text><Text style={{color:'#999',marginTop:8}}>Không có mục nào</Text></View>}
          renderItem={({item:it})=>(
            <View style={[st.qCard,{borderLeftColor:it.status==='approved'?'#27AE60':it.status==='rejected'?'#E74C3C':'#F39C12'}]}>
              <View style={{flexDirection:'row',justifyContent:'space-between',marginBottom:4}}>
                <Text style={{fontFamily:'monospace',fontSize:12,color:'#E8504A',fontWeight:'700'}}>#{it.orderId?.slice(-8)||'—'}</Text>
                <Text style={{fontSize:11,color:'#666'}}>{it.recipientType==='shipper'?'🛵':'🏪'} {it.recipientType}</Text>
              </View>
              <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                <Text style={{fontSize:12,color:'#555',flex:1}} numberOfLines={1}>{it.note?.slice(0,36)||'—'}</Text>
                <Text style={{fontSize:17,fontWeight:'900',color:it.status==='approved'?'#27AE60':'#FFD700'}}>{fmtMoney(it.amount)}</Text>
              </View>
              <Text style={{fontSize:10,color:'#aaa',marginBottom:it.status==='pending'?8:0}}>
                {it.paymentMethod||'—'} · {fmtDate(it.createdAt)}
                {it.releaseAt ? ` · Auto ${fmtDate(it.releaseAt)}` : ''}
                {it.approvedBy ? ` · By: ${it.approvedBy}` : ''}
              </Text>
              {it.status==='pending' && (
                <View style={{flexDirection:'row',gap:6}}>
                  <TouchableOpacity style={[st.actionBtn,{borderColor:'#27AE60',flex:2}]} onPress={()=>approve(it._id)} disabled={processing[it._id]}>
                    {processing[it._id] ? <ActivityIndicator color="#27AE60" size="small"/> : <Text style={{color:'#27AE60',fontWeight:'800',fontSize:12}}>✅ Duyệt</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity style={[st.actionBtn,{borderColor:'#E74C3C',flex:1}]} onPress={()=>reject(it._id)}>
                    <Text style={{color:'#E74C3C',fontWeight:'800',fontSize:12}}>❌</Text>
                  </TouchableOpacity>
                </View>
              )}
              {it.status==='rejected' && it.rejectedReason && (
                <Text style={{fontSize:11,color:'#E74C3C',marginTop:2}}>Lý do: {it.rejectedReason}</Text>
              )}
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

// ── Vouchers ──────────────────────────────────────────────────
function VouchersTab() {
  const [vouchers, setVouchers] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [modal, setModal]       = useState(false);
  const [saving, setSaving]     = useState(false);
  const [form, setForm]         = useState({
    code:'', type:'fixed', value:'', minOrder:'0',
    maxDiscount:'', description:'', module:'all',
    expiresAt: new Date(Date.now()+30*86400000).toISOString().split('T')[0],
  });

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/api/vouchers');
      setVouchers(r.data || []);
    } catch(_) {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, []);

  const create = async () => {
    vib();
    if (!form.code.trim() || !form.value) return Alert.alert('Lỗi','Nhập mã và giá trị');
    setSaving(true);
    try {
      const payload = {
        code:        form.code.toUpperCase().trim(),
        type:        form.type,
        value:       Number(form.value),
        minOrder:    Number(form.minOrder)||0,
        ...(form.maxDiscount && { maxDiscount: Number(form.maxDiscount) }),
        description: form.description,
        module:      form.module,
        active:      true,
        expiresAt:   form.expiresAt || new Date(Date.now()+30*86400000).toISOString(),
      };
      await adminFetch('/api/vouchers','POST',payload);
      setModal(false);
      load();
      Alert.alert('✅ Đã tạo & broadcast!',`Voucher ${payload.code} sẽ xuất hiện ngay trên app khách hàng.`);
    } catch(e) { Alert.alert('Lỗi',e.message); }
    finally { setSaving(false); }
  };

  const toggleActive = async (v) => {
    vib();
    try {
      await adminFetch(`/api/admin/vouchers/${v._id}`,'PATCH',{ active: !v.active });
      load();
    } catch(e) { Alert.alert('Lỗi',e.message); }
  };

  const del = (v) => {
    vib();
    Alert.alert('Xoá voucher?',v.code,[
      {text:'Huỷ',style:'cancel'},
      {text:'Xoá',style:'destructive',onPress:async()=>{
        try { await adminFetch(`/api/admin/vouchers/${v._id}`,'DELETE'); load(); }
        catch(e) { Alert.alert('Lỗi',e.message); }
      }}
    ]);
  };

  return (
    <SafeAreaView style={st.safe}>
      <View style={st.pageHeader}>
        <Text style={st.pageTitle}>🎁 Vouchers</Text>
        <TouchableOpacity onPress={()=>{vib();setModal(true);}} style={st.headerBtn}>
          <Text style={{color:'#fff',fontWeight:'800',fontSize:13}}>+ Tạo mới</Text>
        </TouchableOpacity>
      </View>

      {loading ? <ActivityIndicator color="#E8504A" style={{flex:1}}/> : (
        <FlatList
          data={vouchers}
          keyExtractor={v=>v._id}
          contentContainerStyle={{padding:10}}
          ListEmptyComponent={<View style={{alignItems:'center',paddingVertical:48}}><Text style={{fontSize:40}}>🎁</Text><Text style={{color:'#999',marginTop:8}}>Chưa có voucher</Text></View>}
          renderItem={({item:v})=>(
            <View style={[st.qCard,{borderLeftColor:v.active?'#27AE60':'#999'}]}>
              <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}>
                <Text style={{fontWeight:'900',fontSize:16,color:'#E8504A',letterSpacing:1}}>{v.code}</Text>
                <View style={{flexDirection:'row',gap:10,alignItems:'center'}}>
                  <Switch value={!!v.active} onValueChange={()=>toggleActive(v)}
                    trackColor={{false:'#ccc',true:'#27AE60'}} thumbColor="#fff"
                    style={{transform:[{scaleX:0.8},{scaleY:0.8}]}}
                  />
                  <TouchableOpacity onPress={()=>del(v)} style={{padding:4}}>
                    <Text style={{fontSize:16}}>🗑️</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <Text style={{fontSize:13,fontWeight:'700',color:'#27AE60',marginTop:4}}>
                {v.type==='percent'?`Giảm ${v.value}%`:`Giảm ${fmtMoney(v.value)}`}
                {v.maxDiscount?` (tối đa ${fmtMoney(v.maxDiscount)})`:''}
              </Text>
              {v.description && <Text style={{fontSize:12,color:'#666',marginTop:2}}>{v.description}</Text>}
              <Text style={{fontSize:10,color:'#aaa',marginTop:4}}>
                {v.module} · Đơn min: {fmtMoney(v.minOrder||0)} · HSD: {v.expiresAt?new Date(v.expiresAt).toLocaleDateString('vi-VN'):'—'}
              </Text>
            </View>
          )}
        />
      )}

      <Modal visible={modal} transparent animationType="slide">
        <View style={st.modalOverlay}>
          <View style={st.modalCard}>
            <Text style={{fontSize:17,fontWeight:'800',marginBottom:14}}>🎁 Tạo voucher mới</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              {[
                {k:'code',l:'Mã *',ph:'VD: CRABOR20',caps:true},
                {k:'value',l:'Giá trị *',ph:'VD: 20000 hoặc 20',num:true},
                {k:'minOrder',l:'Đơn tối thiểu',ph:'0',num:true},
                {k:'maxDiscount',l:'Giảm tối đa (% mode)',ph:'Bỏ trống = không giới hạn',num:true},
                {k:'description',l:'Mô tả',ph:'Mô tả ngắn...'},
                {k:'expiresAt',l:'Hết hạn (YYYY-MM-DD)',ph:'2025-12-31'},
              ].map(f=>(
                <View key={f.k} style={{marginBottom:10}}>
                  <Text style={{fontSize:11,fontWeight:'700',color:'#666',marginBottom:4}}>{f.l}</Text>
                  <TextInput style={st.formInp} placeholder={f.ph}
                    keyboardType={f.num?'numeric':'default'} autoCapitalize={f.caps?'characters':'none'}
                    value={form[f.k]} onChangeText={v=>setForm(p=>({...p,[f.k]:v}))}
                  />
                </View>
              ))}
              <Text style={{fontSize:11,fontWeight:'700',color:'#666',marginBottom:6}}>Loại</Text>
              <View style={{flexDirection:'row',gap:8,marginBottom:12}}>
                {[['fixed','💵 Cố định'],['percent','📊 Phần trăm']].map(([v,l])=>(
                  <TouchableOpacity key={v} style={[{flex:1,padding:10,borderRadius:10,borderWidth:1.5,borderColor:'#EEE',alignItems:'center'},form.type===v&&{borderColor:'#E8504A',backgroundColor:'#FFF5F4'}]}
                    onPress={()=>{vib();setForm(p=>({...p,type:v}));}}>
                    <Text style={[{fontSize:12,fontWeight:'700',color:'#999'},form.type===v&&{color:'#E8504A'}]}>{l}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={{fontSize:11,fontWeight:'700',color:'#666',marginBottom:6}}>Áp dụng cho</Text>
              <View style={{flexDirection:'row',flexWrap:'wrap',gap:6,marginBottom:14}}>
                {['all','food','laundry','cleaning','ride'].map(m=>(
                  <TouchableOpacity key={m} style={[{paddingHorizontal:10,paddingVertical:5,borderRadius:20,borderWidth:1.5,borderColor:'#EEE'},form.module===m&&{borderColor:'#E8504A',backgroundColor:'#FFF5F4'}]}
                    onPress={()=>{vib();setForm(p=>({...p,module:m}));}}>
                    <Text style={[{fontSize:11,fontWeight:'700',color:'#999'},form.module===m&&{color:'#E8504A'}]}>{m}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity style={[{backgroundColor:'#E8504A',borderRadius:12,paddingVertical:14,alignItems:'center'},saving&&{opacity:0.6}]}
                onPress={create} disabled={saving}>
                {saving?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'800',fontSize:15}}>✅ Tạo & broadcast ngay</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={{alignItems:'center',paddingVertical:12}} onPress={()=>{vib();setModal(false);}}>
                <Text style={{color:'#999'}}>Huỷ</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ── Orders ────────────────────────────────────────────────────
function OrdersTab() {
  const [orders, setOrders]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRef]    = useState(false);
  const [filter, setFilter]     = useState('');

  const load = useCallback(async () => {
    try {
      const r = await adminFetch(`/api/admin/orders?limit=50${filter?`&status=${filter}`:''}`);
      setOrders(r.orders || []);
    } catch(_) {}
    finally { setLoading(false); setRef(false); }
  }, [filter]);

  useEffect(() => { setLoading(true); load(); }, [filter]);

  const STATUS_FILTERS = ['','pending','confirmed','delivering','delivered','cancelled'];
  const STATUS_LABELS  = {'':'Tất cả','pending':'⏳','confirmed':'✅','delivering':'🛵','delivered':'🎉','cancelled':'❌'};

  return (
    <SafeAreaView style={st.safe}>
      <View style={st.pageHeader}><Text style={st.pageTitle}>📦 Đơn hàng</Text></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{maxHeight:44,backgroundColor:'#fff',borderBottomWidth:1,borderBottomColor:'#EEE'}}>
        {STATUS_FILTERS.map(s=>(
          <TouchableOpacity key={s} style={[{paddingHorizontal:14,paddingVertical:10,borderBottomWidth:2,borderBottomColor:'transparent'},filter===s&&{borderBottomColor:'#E8504A'}]}
            onPress={()=>{vib();setFilter(s);}}>
            <Text style={[{fontSize:12,fontWeight:'700',color:'#999'},filter===s&&{color:'#E8504A'}]}>{STATUS_LABELS[s]} {s||'Tất cả'}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      {loading?<ActivityIndicator color="#E8504A" style={{flex:1}}/>:(
        <FlatList
          data={orders}
          keyExtractor={o=>o._id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={()=>{setRef(true);load();}} tintColor="#E8504A"/>}
          contentContainerStyle={{padding:10}}
          ListEmptyComponent={<View style={{alignItems:'center',paddingVertical:48}}><Text style={{fontSize:40}}>📭</Text><Text style={{color:'#999',marginTop:8}}>Không có đơn</Text></View>}
          renderItem={({item:o})=>(
            <View style={[st.qCard,{borderLeftColor:STATUS_COLOR[o.status]||'#999'}]}>
              <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                <Text style={{fontWeight:'800',color:'#E8504A',fontFamily:'monospace'}}>#{o.orderId?.slice(-6)||o._id?.slice(-6)}</Text>
                <View style={[{borderRadius:20,paddingHorizontal:8,paddingVertical:3},{backgroundColor:STATUS_COLOR[o.status]||'#999'}]}>
                  <Text style={{color:'#fff',fontSize:10,fontWeight:'700'}}>{o.status}</Text>
                </View>
              </View>
              <Text style={{fontSize:13,color:'#333',marginBottom:2}}>{o.customerName||'KH'} · {o.module||'food'}</Text>
              <Text style={{fontSize:14,fontWeight:'800',color:'#E8504A',marginBottom:2}}>{fmtMoney(o.finalTotal||o.total)}</Text>
              <Text style={{fontSize:10,color:'#aaa'}}>{fmtDate(o.createdAt)} · {o.paymentMethod||'—'}</Text>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

// ── Users ─────────────────────────────────────────────────────
function UsersTab() {
  const [users, setUsers]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [refreshing, setRef]  = useState(false);

  const load = useCallback(async (q = '') => {
    try {
      const r = await adminFetch(`/api/admin/users?limit=40${q?`&search=${encodeURIComponent(q)}`:''}`);
      setUsers(r.users || []);
    } catch(_) {}
    finally { setLoading(false); setRef(false); }
  }, []);

  useEffect(() => { load(); }, []);

  return (
    <SafeAreaView style={st.safe}>
      <View style={st.pageHeader}><Text style={st.pageTitle}>👤 Khách hàng</Text></View>
      <View style={{backgroundColor:'#fff',padding:8,borderBottomWidth:1,borderBottomColor:'#EEE'}}>
        <TextInput style={[st.formInp,{margin:0}]} placeholder="🔍 Tìm theo SĐT, tên..."
          value={search} onChangeText={setSearch}
          onSubmitEditing={()=>load(search)} returnKeyType="search"
        />
      </View>
      {loading?<ActivityIndicator color="#E8504A" style={{flex:1}}/>:(
        <FlatList
          data={users}
          keyExtractor={u=>u._id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={()=>{setRef(true);load(search);}} tintColor="#E8504A"/>}
          contentContainerStyle={{padding:10}}
          ListEmptyComponent={<View style={{alignItems:'center',paddingVertical:48}}><Text style={{fontSize:40}}>👤</Text><Text style={{color:'#999',marginTop:8}}>Không có user</Text></View>}
          renderItem={({item:u})=>(
            <View style={[st.qCard,{borderLeftColor:u.isAdmin?'#E8504A':'#3498DB'}]}>
              <View style={{flexDirection:'row',justifyContent:'space-between',marginBottom:4}}>
                <Text style={{fontWeight:'800',fontSize:14}}>{u.fullName||'—'}</Text>
                {u.isAdmin && <View style={{backgroundColor:'#E8504A',borderRadius:10,paddingHorizontal:8,paddingVertical:2}}><Text style={{color:'#fff',fontSize:10,fontWeight:'800'}}>ADMIN</Text></View>}
              </View>
              <Text style={{fontSize:12,color:'#666',marginBottom:2}}>{u.phone||'—'} · {u.email||'—'}</Text>
              <View style={{flexDirection:'row',gap:16}}>
                <Text style={{fontSize:11,color:'#999'}}>📦 {u.totalOrders||0} đơn</Text>
                <Text style={{fontSize:11,color:'#27AE60'}}>💰 {fmtMoney(u.walletBalance||0)}</Text>
                <Text style={{fontSize:11,color:'#999'}}>⭐ {u.loyaltyPts||0} pts</Text>
              </View>
              <Text style={{fontSize:10,color:'#aaa',marginTop:2}}>Tham gia: {fmtDate(u.createdAt)}</Text>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

// ── Root ──────────────────────────────────────────────────────
export default function AdminApp() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem('admin_logged').then(v => {
      setLoggedIn(v === '1');
      setChecking(false);
    });
  }, []);

  const handleLogout = async () => {
    vib();
    Alert.alert('Đăng xuất?','',[
      {text:'Huỷ',style:'cancel'},
      {text:'Đăng xuất',style:'destructive',onPress:async()=>{
        await AsyncStorage.multiRemove(['admin_logged','admin_cookie']);
        _cookie = '';
        setLoggedIn(false);
      }}
    ]);
  };

  if (checking) return (
    <View style={{flex:1,backgroundColor:'#E8504A',alignItems:'center',justifyContent:'center'}}>
      <Text style={{fontSize:64}}>🦀</Text>
      <ActivityIndicator color="#fff" style={{marginTop:20}}/>
    </View>
  );

  if (!loggedIn) return <LoginScreen onLogin={()=>setLoggedIn(true)}/>;

  return (
    <NavigationContainer>
      <Tab.Navigator screenOptions={{
        headerShown: false,
        tabBarStyle: { height:62, paddingBottom:8, paddingTop:6, backgroundColor:'#fff', borderTopWidth:1, borderTopColor:'#EEE', elevation:12 },
        tabBarLabelStyle: { fontSize:9, fontWeight:'700' },
        tabBarActiveTintColor: '#E8504A',
        tabBarInactiveTintColor: '#999',
      }}>
        <Tab.Screen name="Home"     options={{tabBarLabel:'Dashboard', tabBarIcon:({f})=><Text style={{fontSize:20,opacity:f?1:0.5}}>📊</Text>}}>
          {()=><DashboardTab onLogout={handleLogout}/>}
        </Tab.Screen>
        <Tab.Screen name="Wallet"   component={WalletTab}   options={{tabBarLabel:'Duyệt ví',  tabBarIcon:({focused})=><Text style={{fontSize:20,opacity:focused?1:0.5}}>💰</Text>}}/>
        <Tab.Screen name="Vouchers" component={VouchersTab} options={{tabBarLabel:'Vouchers',  tabBarIcon:({focused})=><Text style={{fontSize:20,opacity:focused?1:0.5}}>🎁</Text>}}/>
        <Tab.Screen name="Orders"   component={OrdersTab}   options={{tabBarLabel:'Đơn hàng', tabBarIcon:({focused})=><Text style={{fontSize:20,opacity:focused?1:0.5}}>📦</Text>}}/>
        <Tab.Screen name="Users"    component={UsersTab}    options={{tabBarLabel:'Khách hàng',tabBarIcon:({focused})=><Text style={{fontSize:20,opacity:focused?1:0.5}}>👤</Text>}}/>
      </Tab.Navigator>
    </NavigationContainer>
  );
}

const st = StyleSheet.create({
  safe: { flex:1, backgroundColor:'#F5F5F5' },
  loginSafe: { flex:1, backgroundColor:'#E8504A' },
  loginHeader: { alignItems:'center', paddingVertical:40 },
  loginBrand: { fontSize:28, fontWeight:'900', color:'#fff', letterSpacing:3, marginTop:8 },
  loginCard: { backgroundColor:'#fff', borderRadius:24, margin:16, padding:24, elevation:8 },
  inp: { borderWidth:1.5, borderColor:'#EEE', borderRadius:12, paddingHorizontal:14, paddingVertical:12, fontSize:16, marginBottom:12 },
  btn: { backgroundColor:'#E8504A', borderRadius:12, paddingVertical:14, alignItems:'center' },
  btnTxt: { color:'#fff', fontWeight:'800', fontSize:16 },
  pageHeader: { backgroundColor:'#E8504A', flexDirection:'row', justifyContent:'space-between', alignItems:'center', padding:14 },
  pageTitle: { color:'#fff', fontWeight:'800', fontSize:17 },
  headerBtn: { backgroundColor:'rgba(255,255,255,0.25)', borderRadius:8, paddingHorizontal:10, paddingVertical:5 },
  statCard: { width:(W-34)/2, backgroundColor:'#fff', borderRadius:14, padding:12, borderTopWidth:4, elevation:2 },
  statVal: { fontSize:18, fontWeight:'900', marginBottom:3 },
  statLbl: { fontSize:10, color:'#999', fontWeight:'600' },
  alertCard: { backgroundColor:'#FFF9E6', borderRadius:12, padding:14, borderLeftWidth:4, borderLeftColor:'#F39C12' },
  qCard: { backgroundColor:'#fff', borderRadius:12, padding:13, marginBottom:8, borderLeftWidth:4, elevation:2 },
  actionBtn: { flex:1, borderWidth:1.5, borderRadius:8, paddingVertical:9, alignItems:'center' },
  modalOverlay: { flex:1, backgroundColor:'rgba(0,0,0,0.5)', justifyContent:'flex-end' },
  modalCard: { backgroundColor:'#fff', borderTopLeftRadius:24, borderTopRightRadius:24, padding:20, maxHeight:'85%' },
  formInp: { borderWidth:1.5, borderColor:'#EEE', borderRadius:10, paddingHorizontal:12, paddingVertical:9, fontSize:14 },
});
