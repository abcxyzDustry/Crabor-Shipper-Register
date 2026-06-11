// ============================================================
// Partner Menu Screen — Quản lý thực đơn
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Modal, TextInput, Alert, Switch, ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { PartnerAPI } from '../../shared/api';

// Helper: lấy message từ mọi kiểu lỗi
const getMsg = (e) => e?.message || e?.data?.message || e?.error || 'Đã có lỗi xảy ra';

const EMPTY_ITEM = { name: '', description: '', price: '', category: '', available: true, image: '' };

export default function MenuScreen() {
  const [items, setItems]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal]       = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm]         = useState(EMPTY_ITEM);
  const [saving, setSaving]     = useState(false);
  const [search, setSearch]     = useState('');

  useEffect(() => { loadMenu(); }, []);

  const loadMenu = async () => {
    try {
      const res = await PartnerAPI.getMenu();
      setItems(res.items || res || []);
    } catch (e) {}
    finally { setLoading(false); setRefreshing(false); }
  };

  const openAdd = () => {
    setEditItem(null);
    setForm(EMPTY_ITEM);
    setModal(true);
  };

  const openEdit = (item) => {
    setEditItem(item);
    setForm({
      name: item.name || '',
      description: item.description || '',
      price: String(item.price || ''),
      category: item.category || '',
      available: item.available !== false,
      image: item.image || '',
    });
    setModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return Alert.alert('Lỗi', 'Nhập tên món ăn');
    if (!form.price || isNaN(Number(form.price))) return Alert.alert('Lỗi', 'Nhập giá hợp lệ');
    setSaving(true);
    try {
      const payload = { ...form, price: Number(form.price) };
      if (editItem) {
        await PartnerAPI.updateItem(editItem._id, payload);
        setItems(prev => prev.map(i => i._id === editItem._id ? { ...i, ...payload } : i));
      } else {
        const res = await PartnerAPI.addItem(payload);
        setItems(prev => [...prev, res.item || res]);
      }
      setModal(false);
    } catch (e) {
      Alert.alert('Lỗi', getMsg(e));
    } finally { setSaving(false); }
  };

  const handleDelete = (item) => {
    Alert.alert('Xoá món?', `"${item.name}" sẽ bị xoá khỏi thực đơn.`, [
      { text: 'Huỷ', style: 'cancel' },
      {
        text: 'Xoá', style: 'destructive', onPress: async () => {
          try {
            await PartnerAPI.deleteItem(item._id);
            setItems(prev => prev.filter(i => i._id !== item._id));
          } catch (e) { Alert.alert('Lỗi', getMsg(e)); }
        }
      }
    ]);
  };

  const handleToggleAvail = async (item) => {
    try {
      await PartnerAPI.updateItem(item._id, { available: !item.available });
      setItems(prev => prev.map(i => i._id === item._id ? { ...i, available: !i.available } : i));
    } catch (e) {
      Alert.alert('Lỗi', getMsg(e));
    }
  };

  const filtered = items.filter(i =>
    !search || i.name?.toLowerCase().includes(search.toLowerCase()) || i.category?.toLowerCase().includes(search.toLowerCase())
  );

  const renderItem = ({ item }) => (
    <View style={s.itemCard}>
      <View style={s.itemLeft}>
        <View style={s.itemEmoji}>
          <Text style={{ fontSize: 28 }}>{item.emoji || '🍽️'}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.itemName}>{item.name}</Text>
          {item.description ? <Text style={s.itemDesc} numberOfLines={1}>{item.description}</Text> : null}
          <Text style={s.itemPrice}>{formatCurrency(item.price)}</Text>
          {item.category ? <Text style={s.itemCategory}>{item.category}</Text> : null}
        </View>
      </View>
      <View style={s.itemRight}>
        <Switch
          value={item.available !== false}
          onValueChange={() => handleToggleAvail(item)}
          trackColor={{ false: Colors.gray3, true: Colors.success }}
          thumbColor="#fff"
          style={{ marginBottom: 6 }}
        />
        <TouchableOpacity style={s.editBtn} onPress={() => openEdit(item)}>
          <Text style={s.editBtnText}>✏️</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.deleteBtn} onPress={() => handleDelete(item)}>
          <Text style={s.deleteBtnText}>🗑️</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Text style={s.headerTitle}>🍽️ Thực đơn</Text>
        <TouchableOpacity style={s.addBtn} onPress={openAdd}>
          <Text style={s.addBtnText}>+ Thêm món</Text>
        </TouchableOpacity>
      </View>

      <View style={s.searchWrap}>
        <TextInput
          style={s.searchInput}
          placeholder="🔍 Tìm món ăn..."
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {loading ? (
        <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item._id || String(Math.random())}
          renderItem={renderItem}
          contentContainerStyle={{ padding: Spacing.lg }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadMenu(); }} tintColor={Colors.primary} />}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={{ fontSize: 48 }}>🍽️</Text>
              <Text style={s.emptyText}>{search ? 'Không tìm thấy món' : 'Chưa có món ăn nào\nNhấn "+ Thêm món" để bắt đầu'}</Text>
            </View>
          }
        />
      )}

      <Modal visible={modal} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>{editItem ? '✏️ Sửa món ăn' : '➕ Thêm món mới'}</Text>

            {[
              { k: 'name', label: 'Tên món *', ph: 'VD: Phở bò đặc biệt' },
              { k: 'price', label: 'Giá (đ) *', ph: 'VD: 65000', keyType: 'numeric' },
              { k: 'category', label: 'Danh mục', ph: 'VD: Phở, Cơm, Nước...' },
              { k: 'description', label: 'Mô tả', ph: 'Mô tả ngắn về món...' },
            ].map(f => (
              <View key={f.k} style={{ marginBottom: 10 }}>
                <Text style={s.fieldLabel}>{f.label}</Text>
                <TextInput
                  style={s.fieldInput}
                  placeholder={f.ph}
                  keyboardType={f.keyType || 'default'}
                  value={form[f.k]}
                  onChangeText={v => setForm(p => ({ ...p, [f.k]: v }))}
                />
              </View>
            ))}

            <View style={s.availRow}>
              <Text style={s.fieldLabel}>Đang bán</Text>
              <Switch
                value={form.available}
                onValueChange={v => setForm(p => ({ ...p, available: v }))}
                trackColor={{ false: Colors.gray3, true: Colors.success }}
                thumbColor="#fff"
              />
            </View>

            <TouchableOpacity style={s.saveBtn} onPress={handleSave} disabled={saving}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.saveBtnText}>{editItem ? 'Lưu thay đổi' : 'Thêm món'}</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setModal(false)}>
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
  header: { backgroundColor: Colors.primary, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.lg },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#fff' },
  addBtn: { backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: Radius.md, paddingVertical: 8, paddingHorizontal: 14 },
  addBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  searchWrap: { backgroundColor: '#fff', padding: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border },
  searchInput: { backgroundColor: Colors.gray1, borderRadius: Radius.full, paddingHorizontal: 14, paddingVertical: 9, fontSize: 14 },
  itemCard: { backgroundColor: '#fff', borderRadius: Radius.md, padding: 12, marginBottom: 10, flexDirection: 'row', alignItems: 'center', ...Shadow.sm },
  itemLeft: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  itemEmoji: { width: 52, height: 52, borderRadius: 12, backgroundColor: Colors.cream, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  itemName: { fontWeight: '800', fontSize: 14, color: Colors.text },
  itemDesc: { fontSize: 11, color: Colors.textSub, marginTop: 2 },
  itemPrice: { fontSize: 14, fontWeight: '800', color: Colors.primary, marginTop: 4 },
  itemCategory: { fontSize: 11, backgroundColor: Colors.gray1, color: Colors.textSub, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start', marginTop: 4 },
  itemRight: { alignItems: 'center', gap: 4 },
  editBtn: { width: 34, height: 34, borderRadius: 8, backgroundColor: Colors.gray1, alignItems: 'center', justifyContent: 'center' },
  editBtnText: { fontSize: 16 },
  deleteBtn: { width: 34, height: 34, borderRadius: 8, backgroundColor: '#FFF0F0', alignItems: 'center', justifyContent: 'center' },
  deleteBtnText: { fontSize: 16 },
  empty: { alignItems: 'center', paddingVertical: 60 },
  emptyText: { fontSize: 14, color: Colors.gray4, textAlign: 'center', marginTop: 12, lineHeight: 22 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '90%' },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: 16 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: Colors.gray5, marginBottom: 4 },
  fieldInput: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  availRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  saveBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12 },
  cancelBtnText: { color: Colors.gray4 },
});
