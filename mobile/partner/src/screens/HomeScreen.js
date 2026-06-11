// ============================================================
// Customer Home Screen
// ============================================================
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  FlatList, Image, RefreshControl, TextInput, Alert,
  Dimensions, ActivityIndicator, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Typography, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { CustomerAPI } from '../../shared/api';
import { Storage, KEYS } from '../../shared/storage';

const { width: W } = Dimensions.get('window');

const SERVICES = [
  { id: 'food', icon: '🍜', label: 'Đặt đồ ăn', tab: 'Food' },
  { id: 'vouchers', icon: '🎁', label: 'Voucher', screen: 'Vouchers' },
  { id: 'wallet', icon: '💳', label: 'Ví CRABOR', tab: 'Wallet' },
  { id: 'loyalty', icon: '⭐', label: 'Điểm thưởng', screen: 'Loyalty' },
  { id: 'sales', icon: '💰', label: 'Kiếm thêm', screen: 'Sales' },
  { id: 'coco', icon: '🤖', label: 'Hỏi Coco AI', screen: 'Coco' },
  { id: 'support', icon: '🎧', label: 'Hỗ trợ', screen: 'Support' },
];

const CATEGORIES = [
  { id: 'com', icon: '🍚', label: 'Cơm' },
  { id: 'pho', icon: '🍜', label: 'Phở' },
  { id: 'bun', icon: '🥣', label: 'Bún' },
  { id: 'banh', icon: '🥖', label: 'Bánh mì' },
  { id: 'cafe', icon: '☕', label: 'Cà phê' },
  { id: 'nuoc', icon: '🥤', label: 'Đồ uống' },
  { id: 'trangmieng', icon: '🍰', label: 'Tráng miệng' },
  { id: 'keto', icon: '🥗', label: 'Healthy' },
];

export default function HomeScreen({ navigation }) {
  const [user, setUser] = useState(null);
  const [banners, setBanners] = useState([]);
  const [featured, setFeatured] = useState([]);
  const [recentOrders, setRecentOrders] = useState([]);
  const [flashDeals, setFlashDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [bannerIdx, setBannerIdx] = useState(0);
  const [search, setSearch] = useState('');
  const bannerTimer = useRef(null);

  useEffect(() => {
    loadData();
    return () => clearInterval(bannerTimer.current);
  }, []);

  const loadData = async () => {
    try {
      const [userData, bannersData, featuredData, flashData, ordersData] = await Promise.allSettled([
        CustomerAPI.getMe(),
        CustomerAPI.getBanners(),
        CustomerAPI.getFeaturedPartners(),
        CustomerAPI.getFlashDeals(),
        CustomerAPI.getOrders(),
      ]);
      if (userData.status === 'fulfilled') setUser(userData.value?.user || userData.value);
      if (bannersData.status === 'fulfilled') {
        const b = bannersData.value?.banners || bannersData.value || [];
        setBanners(b);
        if (b.length > 1) {
          bannerTimer.current = setInterval(() => {
            setBannerIdx(i => (i + 1) % b.length);
          }, 4000);
        }
      }
      if (featuredData.status === 'fulfilled') setFeatured(featuredData.value?.partners || featuredData.value || []);
      if (flashData.status === 'fulfilled') setFlashDeals(flashData.value?.deals || flashData.value || []);
      if (ordersData.status === 'fulfilled') {
        const orders = ordersData.value?.orders || ordersData.value || [];
        setRecentOrders(orders.slice(0, 3));
      }
    } catch (e) {
      console.warn(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => { setRefreshing(true); loadData(); };

  const handleServicePress = (svc) => {
    if (svc.tab) navigation.getParent()?.navigate(svc.tab);
    else if (svc.screen) navigation.navigate(svc.screen);
  };

  const handleSearch = () => {
    if (search.trim()) {
      CustomerAPI.addSearchHistory(search).catch(() => {});
      navigation.navigate('Food', { search });
    }
  };

  const handleBannerPress = async (banner) => {
    if (banner._id) CustomerAPI.clickBanner(banner._id).catch(() => {});
    if (banner.link) navigation.navigate('Food');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.primary} />

      {/* Top bar */}
      <View style={styles.topBar}>
        <View>
          <Text style={styles.greeting}>Xin chào! 👋</Text>
          <Text style={styles.userName}>{user?.name || 'Khách hàng'}</Text>
        </View>
        <View style={styles.topRight}>
          <TouchableOpacity style={styles.notiBtn} onPress={() => navigation.navigate('Orders')}>
            <Text style={styles.notiIcon}>🔔</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => navigation.getParent()?.navigate('Profile')}>
            <View style={styles.avatar}>
              <Text style={{ fontSize: 18 }}>👤</Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* Search Bar */}
      <View style={styles.searchWrap}>
        <TextInput
          style={styles.searchInput}
          placeholder="🔍 Tìm món ăn, nhà hàng..."
          placeholderTextColor={Colors.gray4}
          value={search}
          onChangeText={setSearch}
          onSubmitEditing={handleSearch}
          returnKeyType="search"
        />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
      >
        {/* Banner Carousel */}
        {banners.length > 0 && (
          <View style={styles.bannerWrap}>
            <ScrollView
              horizontal pagingEnabled showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={e => setBannerIdx(Math.round(e.nativeEvent.contentOffset.x / (W - 32)))}
            >
              {banners.map((b, i) => (
                <TouchableOpacity key={i} onPress={() => handleBannerPress(b)} activeOpacity={0.9}>
                  <View style={styles.banner}>
                    {b.imageUrl
                      ? <Image source={{ uri: b.imageUrl }} style={styles.bannerImg} resizeMode="cover" />
                      : <View style={[styles.bannerImg, { backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' }]}>
                          <Text style={{ fontSize: 48 }}>🦀</Text>
                          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 18 }}>{b.title || 'CRABOR'}</Text>
                        </View>
                    }
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={styles.dots}>
              {banners.map((_, i) => (
                <View key={i} style={[styles.dot, i === bannerIdx && styles.dotActive]} />
              ))}
            </View>
          </View>
        )}

        {/* Flash Deals */}
        {flashDeals.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>⚡ Flash Deal</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Food', { flash: true })}>
                <Text style={styles.seeAll}>Xem tất cả</Text>
              </TouchableOpacity>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {flashDeals.map((d, i) => (
                <TouchableOpacity key={i} style={styles.flashCard} onPress={() => navigation.navigate('RestaurantMenu', { partner: d.partner })}>
                  <View style={styles.flashBadge}><Text style={styles.flashBadgeText}>-{d.discount}%</Text></View>
                  <Text style={styles.flashName} numberOfLines={1}>{d.name}</Text>
                  <Text style={styles.flashPrice}>{formatCurrency(d.discountedPrice)}</Text>
                  <Text style={styles.flashOriginal}>{formatCurrency(d.originalPrice)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Categories */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🍽️ Danh mục</Text>
          <View style={styles.categories}>
            {CATEGORIES.map(cat => (
              <TouchableOpacity
                key={cat.id}
                style={styles.catItem}
                onPress={() => navigation.navigate('Food', { category: cat.id })}
              >
                <View style={styles.catIcon}>
                  <Text style={{ fontSize: 26 }}>{cat.icon}</Text>
                </View>
                <Text style={styles.catLabel}>{cat.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Services */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🚀 Dịch vụ CRABOR</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {SERVICES.map(svc => (
              <TouchableOpacity key={svc.id} style={styles.svcCard} onPress={() => handleServicePress(svc)}>
                <Text style={styles.svcIcon}>{svc.icon}</Text>
                <Text style={styles.svcLabel}>{svc.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Featured Restaurants */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>🔥 Nổi bật hôm nay</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Food')}>
              <Text style={styles.seeAll}>Xem tất cả</Text>
            </TouchableOpacity>
          </View>
          {loading ? (
            <ActivityIndicator color={Colors.primary} style={{ marginVertical: 20 }} />
          ) : featured.length === 0 ? (
            <Text style={styles.empty}>Chưa có nhà hàng nào</Text>
          ) : (
            featured.map((p, i) => (
              <TouchableOpacity
                key={i} style={styles.restaurantCard}
                onPress={() => navigation.navigate('RestaurantMenu', { partner: p })}
              >
                <View style={styles.restaurantImg}>
                  {p.logo
                    ? <Image source={{ uri: p.logo }} style={{ width: '100%', height: '100%', borderRadius: 12 }} />
                    : <Text style={{ fontSize: 36 }}>🍽️</Text>
                  }
                </View>
                <View style={styles.restaurantInfo}>
                  <Text style={styles.restaurantName} numberOfLines={1}>{p.name}</Text>
                  <Text style={styles.restaurantSub} numberOfLines={1}>{p.address || 'CRABOR Partner'}</Text>
                  <View style={styles.restaurantMeta}>
                    <Text style={styles.metaBadge}>⭐ {p.rating || '5.0'}</Text>
                    <Text style={styles.metaBadge}>🕐 {p.deliveryTime || '25'} phút</Text>
                    {p.minOrder && <Text style={styles.metaBadge}>Từ {formatCurrency(p.minOrder)}</Text>}
                  </View>
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* Recent Orders */}
        {recentOrders.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>🕐 Đơn gần đây</Text>
              <TouchableOpacity onPress={() => navigation.getParent()?.navigate('Orders')}>
                <Text style={styles.seeAll}>Tất cả đơn</Text>
              </TouchableOpacity>
            </View>
            {recentOrders.map((o, i) => (
              <TouchableOpacity
                key={i} style={styles.orderCard}
                onPress={() => navigation.navigate('OrderDetail', { orderId: o._id })}
              >
                <Text style={styles.orderPartner}>{o.partnerName || 'Nhà hàng'}</Text>
                <Text style={styles.orderItems} numberOfLines={1}>
                  {o.items?.map(it => it.name).join(', ')}
                </Text>
                <View style={styles.orderFooter}>
                  <Text style={styles.orderTotal}>{formatCurrency(o.total)}</Text>
                  <View style={[styles.statusBadge, { backgroundColor: o.status === 'delivered' ? Colors.success : Colors.primary }]}>
                    <Text style={styles.statusText}>
                      {o.status === 'delivered' ? 'Đã giao' : 'Đang xử lý'}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.primary },
  topBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: Spacing.md,
  },
  greeting: { color: 'rgba(255,255,255,0.8)', fontSize: 12 },
  userName: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  notiBtn: { padding: 4 },
  notiIcon: { fontSize: 22 },
  avatar: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  searchWrap: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md },
  searchInput: {
    backgroundColor: Colors.white, borderRadius: Radius.full,
    paddingHorizontal: 16, paddingVertical: 10, fontSize: 14,
    ...Shadow.sm,
  },
  // Main scroll bg
  section: {
    backgroundColor: Colors.white, marginTop: 8, paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
  },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { fontSize: 15, fontWeight: '800', color: Colors.text },
  seeAll: { fontSize: 12, color: Colors.primary, fontWeight: '700' },
  // Banner
  bannerWrap: { backgroundColor: Colors.white, paddingTop: 8, marginTop: 8 },
  banner: { width: W - 32, marginHorizontal: 16, borderRadius: Radius.lg, overflow: 'hidden' },
  bannerImg: { width: '100%', height: 160, borderRadius: Radius.lg },
  dots: { flexDirection: 'row', justifyContent: 'center', marginVertical: 8, gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.gray3 },
  dotActive: { backgroundColor: Colors.primary, width: 18 },
  // Categories
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  catItem: { width: (W - 32 - 28) / 4, alignItems: 'center', paddingVertical: 8 },
  catIcon: {
    width: 52, height: 52, borderRadius: 16, backgroundColor: Colors.cream,
    alignItems: 'center', justifyContent: 'center', marginBottom: 6,
  },
  catLabel: { fontSize: 11, fontWeight: '600', color: Colors.text, textAlign: 'center' },
  // Services
  svcCard: {
    width: 80, alignItems: 'center', marginRight: 12,
    backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 12,
  },
  svcIcon: { fontSize: 26, marginBottom: 4 },
  svcLabel: { fontSize: 10, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  // Flash deals
  flashCard: {
    width: 130, marginRight: 12, backgroundColor: Colors.cream,
    borderRadius: Radius.md, padding: 12, borderWidth: 1, borderColor: Colors.border,
  },
  flashBadge: { backgroundColor: Colors.danger, borderRadius: Radius.sm, paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start', marginBottom: 8 },
  flashBadgeText: { color: Colors.white, fontSize: 10, fontWeight: '800' },
  flashName: { fontSize: 13, fontWeight: '700', color: Colors.text, marginBottom: 4 },
  flashPrice: { fontSize: 14, fontWeight: '800', color: Colors.primary },
  flashOriginal: { fontSize: 11, color: Colors.gray4, textDecorationLine: 'line-through' },
  // Restaurants
  restaurantCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.white, borderRadius: Radius.md,
    marginBottom: 12, padding: 12,
    borderWidth: 1, borderColor: Colors.border,
  },
  restaurantImg: {
    width: 72, height: 72, borderRadius: 12, backgroundColor: Colors.gray1,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  restaurantInfo: { flex: 1 },
  restaurantName: { fontSize: 15, fontWeight: '800', color: Colors.text },
  restaurantSub: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
  restaurantMeta: { flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' },
  metaBadge: {
    backgroundColor: Colors.gray1, borderRadius: Radius.full,
    paddingHorizontal: 8, paddingVertical: 3, fontSize: 11, fontWeight: '600', color: Colors.gray5,
  },
  empty: { textAlign: 'center', color: Colors.gray4, paddingVertical: 20 },
  // Orders
  orderCard: {
    backgroundColor: Colors.gray1, borderRadius: Radius.md,
    padding: 14, marginBottom: 10,
  },
  orderPartner: { fontWeight: '800', fontSize: 14, color: Colors.text },
  orderItems: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
  orderFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  orderTotal: { fontWeight: '800', color: Colors.primary, fontSize: 14 },
  statusBadge: { borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  statusText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
});
