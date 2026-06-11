// ============================================================
// CRABOR Partner — Mode Switch (Food ↔ Laundry)
// Đặt ở màn hình Settings hoặc header partner
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Colors, Radius, Shadow } from '../../shared/theme';

const MODE_KEY = 'crabor_partner_mode';

export const PARTNER_MODES = {
  food:    { id: 'food',    icon: '🍜', label: 'Nhà hàng / Đồ ăn',   desc: 'Quản lý thực đơn và đơn đồ ăn' },
  laundry: { id: 'laundry', icon: '👕', label: 'Giặt là',             desc: 'Quản lý gói giặt và đơn giặt' },
};

export function usePartnerMode() {
  const [mode, setModeState] = useState('food');

  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY).then(m => { if (m) setModeState(m); });
  }, []);

  const setMode = async (newMode) => {
    await AsyncStorage.setItem(MODE_KEY, newMode);
    setModeState(newMode);
  };

  return { mode, setMode };
}

export default function PartnerModeSwitch({ currentMode, onSwitch }) {
  const [modal, setModal] = useState(false);

  const handleSwitch = (mode) => {
    if (mode === currentMode) { setModal(false); return; }
    Alert.alert(
      `Chuyển sang ${PARTNER_MODES[mode].label}?`,
      'Bạn sẽ chuyển sang chế độ quản lý khác. Các đơn hiện tại không bị ảnh hưởng.',
      [
        { text: 'Huỷ', style: 'cancel' },
        { text: 'Chuyển', onPress: () => { setModal(false); onSwitch(mode); } },
      ]
    );
  };

  const current = PARTNER_MODES[currentMode] || PARTNER_MODES.food;

  return (
    <>
      <TouchableOpacity style={s.switchBtn} onPress={() => setModal(true)}>
        <Text style={s.switchIcon}>{current.icon}</Text>
        <Text style={s.switchLabel}>{current.label}</Text>
        <Text style={s.switchArrow}>⇄</Text>
      </TouchableOpacity>

      <Modal visible={modal} transparent animationType="fade">
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setModal(false)}>
          <View style={s.card}>
            <Text style={s.cardTitle}>Chọn chế độ Partner</Text>
            {Object.values(PARTNER_MODES).map(m => (
              <TouchableOpacity
                key={m.id}
                style={[s.modeOption, currentMode === m.id && s.modeOptionActive]}
                onPress={() => handleSwitch(m.id)}
              >
                <Text style={s.modeIcon}>{m.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.modeName}>{m.label}</Text>
                  <Text style={s.modeDesc}>{m.desc}</Text>
                </View>
                {currentMode === m.id && <Text style={{ color: Colors.primary, fontWeight: '800' }}>✓</Text>}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  switchBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: Radius.full,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  switchIcon: { fontSize: 16 },
  switchLabel: { color: '#fff', fontWeight: '700', fontSize: 12 },
  switchArrow: { color: 'rgba(255,255,255,0.8)', fontSize: 14 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 20 },
  cardTitle: { fontSize: 16, fontWeight: '800', marginBottom: 16, textAlign: 'center', color: Colors.text },
  modeOption: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, borderRadius: Radius.md, marginBottom: 8,
    borderWidth: 1.5, borderColor: Colors.border,
  },
  modeOptionActive: { borderColor: Colors.primary, backgroundColor: '#FFF5F4' },
  modeIcon: { fontSize: 28 },
  modeName: { fontWeight: '800', fontSize: 14, color: Colors.text },
  modeDesc: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
});
