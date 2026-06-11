// ============================================================
// CRABOR — Settings Screen (Cài đặt ứng dụng)
// Rung, âm thanh, thông báo, địa chỉ, thông tin tài khoản
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Switch, Alert, ActivityIndicator, TextInput, Modal,
  Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { CustomerAPI, api } from '../../shared/api';
import { useAuth } from '../../shared/auth';

const VIB_KEY   = 'crabor_vibration';
const SOUND_KEY = 'crabor_sound';

export function useAppSettings() {
  const [vibrationOn, setVibrationOn] = useState(true);
  const [soundOn, setSoundOn]         = useState(true);

  useEffect(() => {
    AsyncStorage.multiGet([VIB_KEY, SOUND_KEY]).then(([[,v],[,s]]) => {
      if (v !== null) setVibrationOn(v === '1');
      if (s !== null) setSoundOn(s === '1');
    });
  }, []);

  const toggleVibration = async (val) => {
    setVibrationOn(val);
    await AsyncStorage.setItem(VIB_KEY, val ? '1' : '0');
    try { await api.patch('/api/users/settings', { vibrationEnabled: val }); } catch (_) {}
    if (val) Vibration.vibrate(50); // feedback
  };

  const toggleSound = async (val) => {
    setSoundOn(val);
    await AsyncStorage.setItem(SOUND_KEY, val ? '1' : '0');
    try { await api.patch('/api/users/settings', { soundEnabled: val }); } catch (_) {}
  };

  // Smart vibrate — chỉ rung nếu setting bật
  const vibrate = (pattern = 30) => {
    if (vibrationOn) Vibration.vibrate(pattern);
  };

  return { vibrationOn, soundOn, toggleVibration, toggleSound, vibrate };
}

export default function SettingsScreen({ navigation }) {
  const { user, logout } = useAuth();
  const { vibrationOn, soundOn, toggleVibration, toggleSound, vibrate } = useAppSettings();

  const [addresses, setAddresses] = useState([]);
  const [addrLoading, setAddrLoading] = useState(true);
  const [addrModal, setAddrModal]   = useState(false);
  const [addrForm, setAddrForm]     = useState({ label: '', address: '', icon: '📍' });
  const [savingAddr, setSavingAddr] = useState(false);
  const [deleteAddr, setDeleteAddr] = useState(null);

  useEffect(() => { loadAddresses(); }, []);

  const loadAddresses = async () => {
    try {
      const res = await CustomerAPI.getAddresses();
      setAddresses(res.addresses || []);
    } catch (_) {}
    finally { setAddrLoading(false); }
  };

  const saveAddress = async () => {
    vibrate(30);
    if (!addrForm.address.trim()) return Alert.alert('Lỗi', 'Nhập địa chỉ');
    setSavingAddr(true);
    try {
      const res = await CustomerAPI.addAddress({
        label:   addrForm.label.trim() || addrForm.address.slice(0, 20),
        address: addrForm.address.trim(),
        icon:    addrForm.icon || '📍',
      });
      setAddresses(res.addresses || []);
      setAddrModal(false);
      setAddrForm({ label: '', address: '', icon: '📍' });
      Alert.alert('✅ Đã lưu địa chỉ');
    } catch (e) {
      Alert.alert('Lỗi', e.message);
    } finally { setSavingAddr(false); }
  };

  const removeAddress = async (label) => {
    vibrate(30);
    Alert.alert('Xoá địa chỉ?', label, [
      { text: 'Huỷ', style: 'cancel' },
      { text: 'Xoá', style: 'destructive', onPress: async () => {
        try {
          await CustomerAPI.deleteAddress(label);
          setAddresses(prev => prev.filter(a => a.label !== label));
        } catch (e) { Alert.alert('Lỗi', e.message); }
      }}
    ]);
  };

  const handleLogout = () => {
    vibrate(30);
    Alert.alert('Đăng xuất?', '', [
      { text: 'Huỷ', style: 'cancel' },
      { text: 'Đăng xuất', style: 'destructive', onPress: logout }
    ]);
  };

  const ICONS = ['🏠', '💼', '❤️', '🏋️', '📍', '🏪', '🏫', '🏥'];

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => { vibrate(30); navigation.goBack(); }}>
          <Text style={s.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>⚙️ Cài đặt</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>

        {/* Account info */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>👤 Tài khoản</Text>
          <View style={s.infoRow}>
            <View style={s.avatar}><Text style={{ fontSize: 28 }}>👤</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={s.userName}>{user?.fullName || 'Khách hàng'}</Text>
              <Text style={s.userSub}>{user?.phone || user?.email || '—'}</Text>
            </View>
            <View style={s.balanceBadge}>
              <Text style={s.balanceBadgeText}>{formatCurrency(user?.walletBalance || 0)}</Text>
            </View>
          </View>
          <TouchableOpacity style={s.menuItem} onPress={() => { vibrate(30); navigation.navigate('Wallet'); }}>
            <Text style={s.menuIcon}>💳</Text>
            <Text style={s.menuLabel}>Ví CRABOR</Text>
            <Text style={s.menuArrow}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.menuItem} onPress={() => { vibrate(30); navigation.navigate('WalletTopup'); }}>
            <Text style={s.menuIcon}>💰</Text>
            <Text style={s.menuLabel}>Nạp tiền vào ví</Text>
            <Text style={s.menuArrow}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.menuItem} onPress={() => { vibrate(30); navigation.navigate('Loyalty'); }}>
            <Text style={s.menuIcon}>⭐</Text>
            <Text style={s.menuLabel}>Điểm thưởng ({user?.loyaltyPts || 0} pts)</Text>
            <Text style={s.menuArrow}>›</Text>
          </TouchableOpacity>
        </View>

        {/* Addresses */}
        <View style={s.section}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={s.sectionTitle}>📍 Địa chỉ đã lưu</Text>
            <TouchableOpacity style={s.addBtn} onPress={() => { vibrate(30); setAddrModal(true); }}>
              <Text style={s.addBtnText}>+ Thêm</Text>
            </TouchableOpacity>
          </View>

          {addrLoading ? <ActivityIndicator color={Colors.primary} /> :
            addresses.length === 0 ? (
              <TouchableOpacity style={s.emptyAddr} onPress={() => { vibrate(30); setAddrModal(true); }}>
                <Text style={{ fontSize: 28 }}>📍</Text>
                <Text style={s.emptyAddrText}>Chưa có địa chỉ nào{'\n'}Nhấn để thêm mới</Text>
              </TouchableOpacity>
            ) : (
              addresses.map((addr) => (
                <View key={addr.label} style={s.addrCard}>
                  <Text style={{ fontSize: 22 }}>{addr.icon || '📍'}</Text>
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={s.addrLabel}>{addr.label}</Text>
                    <Text style={s.addrValue} numberOfLines={1}>{addr.address}</Text>
                  </View>
                  <TouchableOpacity onPress={() => removeAddress(addr.label)} style={{ padding: 6 }}>
                    <Text style={{ fontSize: 16 }}>🗑️</Text>
                  </TouchableOpacity>
                </View>
              ))
            )
          }
        </View>

        {/* App settings */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>🔔 Thông báo & Rung</Text>
          <View style={s.settingRow}>
            <Text style={s.menuIcon}>📳</Text>
            <Text style={s.settingLabel}>Rung khi có thông báo</Text>
            <Switch
              value={vibrationOn}
              onValueChange={toggleVibration}
              trackColor={{ false: Colors.gray3, true: Colors.primary }}
              thumbColor="#fff"
            />
          </View>
          <View style={[s.settingRow, { borderBottomWidth: 0 }]}>
            <Text style={s.menuIcon}>🔊</Text>
            <Text style={s.settingLabel}>Âm thanh thông báo</Text>
            <Switch
              value={soundOn}
              onValueChange={toggleSound}
              trackColor={{ false: Colors.gray3, true: Colors.primary }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* Links */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>📋 Khác</Text>
          {[
            { icon: '🎁', label: 'Voucher của tôi', screen: 'Vouchers' },
            { icon: '📦', label: 'Lịch sử đơn hàng', screen: 'Orders' },
            { icon: '🎧', label: 'Hỗ trợ khách hàng', screen: 'Support' },
            { icon: '🤖', label: 'Hỏi Coco AI', screen: 'Coco' },
          ].map(item => (
            <TouchableOpacity key={item.screen} style={s.menuItem}
              onPress={() => { vibrate(30); navigation.navigate(item.screen); }}>
              <Text style={s.menuIcon}>{item.icon}</Text>
              <Text style={s.menuLabel}>{item.label}</Text>
              <Text style={s.menuArrow}>›</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Logout */}
        <TouchableOpacity style={s.logoutBtn} onPress={handleLogout}>
          <Text style={s.logoutBtnText}>🚪 Đăng xuất</Text>
        </TouchableOpacity>
        <Text style={{ textAlign: 'center', fontSize: 11, color: Colors.gray4, marginTop: 12 }}>
          CRABOR v1.0.0 · crabor.vn
        </Text>
      </ScrollView>

      {/* Add Address Modal */}
      <Modal visible={addrModal} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>📍 Thêm địa chỉ mới</Text>

            {/* Icon picker */}
            <Text style={s.fieldLabel}>Biểu tượng</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              {ICONS.map(ic => (
                <TouchableOpacity key={ic} style={[s.iconChip, addrForm.icon === ic && s.iconChipActive]}
                  onPress={() => { vibrate(30); setAddrForm(p => ({ ...p, icon: ic })); }}>
                  <Text style={{ fontSize: 22 }}>{ic}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={s.fieldLabel}>Tên địa chỉ (VD: Nhà, Cơ quan)</Text>
            <TextInput style={s.modalInput} placeholder="Nhà, Cơ quan, Phòng gym..."
              value={addrForm.label} onChangeText={v => setAddrForm(p => ({ ...p, label: v }))} />

            <Text style={s.fieldLabel}>Địa chỉ đầy đủ *</Text>
            <TextInput style={[s.modalInput, { height: 72, textAlignVertical: 'top' }]}
              placeholder="Số nhà, đường, phường, quận, thành phố..."
              value={addrForm.address} onChangeText={v => setAddrForm(p => ({ ...p, address: v }))}
              multiline />

            <TouchableOpacity style={[s.saveBtn, savingAddr && { opacity: 0.6 }]}
              onPress={saveAddress} disabled={savingAddr}>
              {savingAddr ? <ActivityIndicator color="#fff" /> : <Text style={s.saveBtnText}>✅ Lưu địa chỉ</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={s.cancelBtn} onPress={() => { vibrate(30); setAddrModal(false); }}>
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
  header: { backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.md },
  backBtn: { color: '#fff', fontSize: 24, fontWeight: '700' },
  headerTitle: { color: '#fff', fontWeight: '800', fontSize: 16 },
  section: { backgroundColor: '#fff', margin: Spacing.md, marginBottom: 0, borderRadius: Radius.lg, padding: Spacing.md, ...Shadow.sm },
  sectionTitle: { fontWeight: '800', fontSize: 14, color: Colors.text, marginBottom: 12 },
  infoRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 10 },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: Colors.cream, alignItems: 'center', justifyContent: 'center' },
  userName: { fontWeight: '800', fontSize: 15 },
  userSub: { fontSize: 12, color: Colors.textSub },
  balanceBadge: { backgroundColor: Colors.primary, borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  balanceBadgeText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderTopWidth: 1, borderTopColor: Colors.border },
  menuIcon: { fontSize: 20, width: 32 },
  menuLabel: { flex: 1, fontSize: 14, color: Colors.text },
  menuArrow: { fontSize: 18, color: Colors.gray4 },
  settingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderTopWidth: 1, borderTopColor: Colors.border },
  settingLabel: { flex: 1, fontSize: 14, color: Colors.text },
  addBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 6, paddingHorizontal: 12 },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  emptyAddr: { alignItems: 'center', padding: 20, gap: 8 },
  emptyAddrText: { fontSize: 13, color: Colors.gray4, textAlign: 'center' },
  addrCard: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: Colors.border },
  addrLabel: { fontWeight: '700', fontSize: 13 },
  addrValue: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
  logoutBtn: { margin: Spacing.md, borderWidth: 1.5, borderColor: Colors.danger, borderRadius: Radius.lg, paddingVertical: 14, alignItems: 'center' },
  logoutBtnText: { color: Colors.danger, fontWeight: '800', fontSize: 15 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle: { fontSize: 17, fontWeight: '800', marginBottom: 16 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: Colors.gray5, marginBottom: 6 },
  iconChip: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.gray1, alignItems: 'center', justifyContent: 'center', marginRight: 8, borderWidth: 2, borderColor: 'transparent' },
  iconChipActive: { borderColor: Colors.primary, backgroundColor: Colors.cream },
  modalInput: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, padding: 12, fontSize: 14, marginBottom: 12 },
  saveBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12 },
  cancelBtnText: { color: Colors.gray4 },
});
