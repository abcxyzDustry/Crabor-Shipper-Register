// ============================================================
// Customer Food Screen — Danh sách nhà hàng
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, RefreshControl, ActivityIndicator, Image, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { CustomerAPI } from '../../shared/api';

const CATS = [
  { id: '', label: 'Tất cả', icon: '🍽️' },
  { id: 'com', label: 'Cơm', icon: '🍚' },
  { id: 'pho', label: 'Phở', icon: '🍜' },
  { id: 'bun', label: 'Bún', icon: '🥣' },
  { id: 'banh', label: 'Bánh mì', icon: '🥖' },
  { id: 'cafe', label: 'Cà phê', icon: '☕' },
  { id: 'nuoc', label: 'Đồ uống', icon: '🥤' },
  { id: 'tra', label: 'Trà sữa', icon: '🧋' },
];
const SORTS = [
  { id: 'rating', label: '⭐ Đánh giá' },
  { id: 'time', label: '🕐 Nhanh nhất' },
  { id: 'price', label: '💰 Giá thấp' },
];

export default function FoodScreen({ navigation, route }) {
  const [partners, setPartners] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch]     = useState(route?.params?.search || '');
  const [cat, setCat]           = useState(route?.params?.category || '');
  const [sort, setSort]         = useState('rating');

  useEffect(() => { load(); }, [cat, sort]);

  const load = async () => {
    try {
      const q = [cat && `category=${cat}`, sort && `sort=${sort}`].filter(Boolean).join('&');
      const res = await CustomerAPI.getFoodPartners(q ? `?${q}` : '');
      setPartners(res.partners || res || []);
    } catch {}
    finally { setLoading(false); setRefreshing(false); }
  };

  const filtered = search.trim()
    ? partners.filter(p => p.name?.toLowerCase().includes(search.toLowerCase()))
    : partners;

  const renderItem = ({ item: p }) => (
    <TouchableOpacity style={s.card} onPress={() => navigation.navigate('RestaurantMenu', { partner: p })} activeOpacity={0.88}>
      <View style={s.cover}>
        {p.coverImage
          ? <Image source={{ uri: p.coverImage }} style={s.coverImg} resizeMode="cover" />
          : <View style={[s.coverImg, { backgroundColor: Colors.cream, alignItems: 'center', justifyContent: 'center' }]}><Text style={{ fontSize: 52 }}>🍽️</Text></View>
        }
        {p.isOpen === false && <View style={s.closedOverlay}><Text style={s.closedText}>Đóng cửa</Text></View>}
        {p.promoted && <View style={s.badge}><Text style={s.badgeText}>⚡ Nổi bật</Text></View>}
      </View>
      <View style={s.infoRow}>
        <View style={s.logoBox}>
          {p.logo ? <Image source={{ uri: p.logo }} style={{ width: '100%', height: '100%', borderRadius: 10 }} /> : <Text style={{ fontSize: 22 }}>🏪</Text>}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.name} numberOfLines={1}>{p.name}</Text>
          <Text style={s.addr} numberOfLines={1}>{p.address || ''}</Text>
          <View style={s.tags}>
            <Text style={s.tag}>⭐ {p.rating || '5.0'}</Text>
            <Text style={s.tag}>🕐 {p.deliveryTime || '25'} phút</Text>
            {p.deliveryFee === 0 ? <Text style={[s.tag, { color: Colors.success }]}>🚚 Free ship</Text> : null}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.topBar}>
        <TextInput style={s.searchInput} placeholder="🔍 Tìm nhà hàng, món ăn..." value={search} onChangeText={setSearch} returnKeyType="search" />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.catScroll} contentContainerStyle={s.catContent}>
        {CATS.map(c => (
          <TouchableOpacity key={c.id} style={[s.catChip, cat === c.id && s.catChipOn]} onPress={() => setCat(c.id)}>
            <Text style={s.catIcon}>{c.icon}</Text>
            <Text style={[s.catLabel, cat === c.id && s.catLabelOn]}>{c.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.sortRow} contentContainerStyle={{ paddingHorizontal: 12, gap: 8, alignItems: 'center' }}>
        {SORTS.map(so => (
          <TouchableOpacity key={so.id} style={[s.sortChip, sort === so.id && s.sortChipOn]} onPress={() => setSort(so.id)}>
            <Text style={[s.sortText, sort === so.id && s.sortTextOn]}>{so.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <Text style={s.count}>{filtered.length} nhà hàng</Text>
      {loading
        ? <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} />
        : <FlatList
            data={filtered} keyExtractor={i => i._id || `${Math.random()}`}
            renderItem={renderItem}
            contentContainerStyle={{ padding: Spacing.md, paddingTop: 0 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={Colors.primary} />}
            ListEmptyComponent={<View style={s.empty}><Text style={{ fontSize: 48 }}>🍽️</Text><Text style={s.emptyText}>Không tìm thấy nhà hàng nào</Text></View>}
          />
      }
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  topBar: { backgroundColor: Colors.primary, padding: Spacing.md },
  searchInput: { backgroundColor: '#fff', borderRadius: Radius.full, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14 },
  catScroll: { backgroundColor: '#fff', maxHeight: 54 },
  catContent: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  catChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.gray1, borderRadius: Radius.full, paddingHorizontal: 12, paddingVertical: 6, gap: 4 },
  catChipOn: { backgroundColor: Colors.primary },
  catIcon: { fontSize: 16 },
  catLabel: { fontSize: 12, fontWeight: '700', color: Colors.gray5 },
  catLabelOn: { color: '#fff' },
  sortRow: { backgroundColor: '#fff', maxHeight: 46, borderBottomWidth: 1, borderBottomColor: Colors.border },
  sortChip: { borderRadius: Radius.full, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: Colors.border },
  sortChipOn: { borderColor: Colors.primary, backgroundColor: Colors.primary + '18' },
  sortText: { fontSize: 12, fontWeight: '700', color: Colors.gray5 },
  sortTextOn: { color: Colors.primary },
  count: { paddingHorizontal: Spacing.md, paddingVertical: 6, fontSize: 12, color: Colors.textSub, fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: Radius.lg, marginBottom: 12, overflow: 'hidden', ...Shadow.sm },
  cover: { position: 'relative' },
  coverImg: { width: '100%', height: 140 },
  closedOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  closedText: { color: '#fff', fontWeight: '800', fontSize: 18 },
  badge: { position: 'absolute', top: 10, left: 10, backgroundColor: Colors.primary, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { color: '#fff', fontWeight: '700', fontSize: 11 },
  infoRow: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 },
  logoBox: { width: 44, height: 44, borderRadius: 10, backgroundColor: Colors.gray1, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 15, fontWeight: '800', color: Colors.text },
  addr: { fontSize: 11, color: Colors.textSub, marginTop: 2 },
  tags: { flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' },
  tag: { backgroundColor: Colors.gray1, borderRadius: Radius.full, paddingHorizontal: 8, paddingVertical: 3, fontSize: 11, fontWeight: '600', color: Colors.gray5 },
  empty: { alignItems: 'center', paddingVertical: 60 },
  emptyText: { fontSize: 14, color: Colors.gray4, marginTop: 12 },
});
