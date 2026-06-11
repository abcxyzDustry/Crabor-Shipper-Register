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

// Hàm rung an toàn - không gây lỗi nếu Vibration không khả dụng
const safeVibrate = (duration = 30) => {
  try {
    // Dynamic import để tránh lỗi
    const { Vibration } = require('react-native');
    if (Vibration && typeof Vibration.vibrate === 'function') {
      Vibration.vibrate(duration);
    }
  } catch (error) {
    // Bỏ qua lỗi, không làm crash app
    console.log('Vibration not available');
  }
};

const SERVICES = [
  { id: 'food',     icon: '🍜', label: 'Đặt đồ ăn',    tab: 'Food' },
  { id: 'ride',     icon: '🚗', label: 'Đặt xe',        screen: 'Ride' },
  { id: 'laundry',  icon: '👕', label: 'Giặt là',       screen: 'Laundry' },
  { id: 'cleaning', icon: '🧹', label: 'Dọn nhà',       screen: 'Cleaning' },
  { id: 'wallet',   icon: '💳', label: 'Ví CRABOR',     screen: 'Wallet' },
  { id: 'vouchers', icon: '🎁', label: 'Voucher',       screen: 'Vouchers' },
  { id: 'loyalty',  icon: '⭐', label: 'Điểm thưởng',  screen: 'Loyalty' },
  { id: 'sales',    icon: '💰', label: 'Kiếm thêm',    screen: 'Sales' },
  { id: 'coco',     icon: '🤖', label: 'Hỏi Coco AI',  screen: 'Coco' },
  { id: 'support',  icon: '🎧', label: 'Hỗ trợ',       screen: 'Support' },
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
    return () => {
      if (bannerTimer.current) {
        clearInterval(bannerTimer.current);
      }
    };
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      
      const [userData, bannersData, featuredData, flashData, ordersData] = await Promise.allSettled([
        CustomerAPI.getMe(),
        CustomerAPI.getBanners(),
        CustomerAPI.getFeaturedPartners(),
        CustomerAPI.getFlashDeals(),
        CustomerAPI.getOrders(),
      ]);
      
      // Xử lý user data
      if (userData.status === 'fulfilled' && userData.value) {
        setUser(userData.value?.user || userData.value);
      }
      
      // Xử lý banners
      if (bannersData.status === 'fulfilled') {
        let bannersArray = bannersData.value?.banners || bannersData.value || [];
        if (!Array.isArray(bannersArray)) bannersArray = [];
        setBanners(bannersArray);
        
        if (bannersArray.length > 1) {
          if (bannerTimer.current) clearInterval(bannerTimer.current);
          bannerTimer.current = setInterval(() => {
            setBannerIdx(prev => (prev + 1) % bannersArray.length);
          }, 4000);
        }
      }
      
      // Xử lý featured partners
      if (featuredData.status === 'fulfilled') {
        let partners = [];
        const response = featuredData.value;
        
        if (response && response.success === true && response.data) {
          partners = Array.isArray(response.data) ? response.data : [];
        } else if (response?.partners) {
          partners = Array.isArray(response.partners) ? response.partners : [];
        } else if (Array.isArray(response)) {
          partners = response;
        } else {
          partners = [];
        }
        
        setFeatured(partners);
      } else {
        setFeatured([]);
      }
      
      // Xử lý flash deals
      if (flashData.status === 'fulfilled') {
        let deals = [];
        const response = flashData.value;
        
        if (response && response.success === true && response.data) {
          deals = Array.isArray(response.data) ? response.data : [];
        } else if (response?.deals) {
          deals = Array.isArray(response.deals) ? response.deals : [];
        } else if (Array.isArray(response)) {
          deals = response;
        } else {
          deals = [];
        }
        
        setFlashDeals(deals);
      }
      
      // Xử lý orders
      if (ordersData.status === 'fulfilled') {
        let orders = [];
        const response = ordersData.value;
        
        if (response && response.success === true && response.data) {
          orders = Array.isArray(response.data) ? response.data : [];
        } else if (response?.orders) {
          orders = Array.isArray(response.orders) ? response.orders : [];
        } else if (Array.isArray(response)) {
          orders = response;
        } else {
          orders = [];
        }
        
        setRecentOrders(orders.slice(0, 3));
      }
      
    } catch (error) {
      console.error('Load data error:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const handleServicePress = (svc) => {
    if (svc.tab) {
      navigation.getParent()?.navigate(svc.tab);
    } else if (svc.screen) {
      navigation.navigate(svc.screen);
    }
  };

  const handleSearch = () => {
    if (search.trim()) {
      CustomerAPI.addSearchHistory(search).catch(() => {});
      navigation.navigate('Food', { search });
    }
  };

  const handleBannerPress = async (banner) => {
    if (banner?._id) {
      try {
        await CustomerAPI.clickBanner(banner._id);
      } catch (e) {}
    }
    if (banner?.link) {
      navigation.navigate('Food');
    }
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
        refreshControl={
          <RefreshControl 
            refreshing={refreshing} 
            onRefresh={onRefresh} 
            tintColor={Colors.primary} 
          />
        }
      >
        {/* Banner Carousel */}
        {banners.length > 0 && (
          <View style={styles.bannerWrap}>
            <ScrollView
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={(e) => {
                const newIndex = Math.round(e.nativeEvent.contentOffset.x / (W - 32));
                setBannerIdx(newIndex);
              }}
            >
              {banners.map((banner, index) => (
                <TouchableOpacity 
                  key={banner?._id || index} 
                  onPress={() => handleBannerPress(banner)} 
                  activeOpacity={0.9}
                >
                  <View style={styles.banner}>
                    {banner?.imageUrl ? (
                      <Image 
                        source={{ uri: banner.imageUrl }} 
                        style={styles.bannerImg} 
                        resizeMode="cover" 
                      />
                    ) : (
                      <View style={[styles.bannerImg, { backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' }]}>
                        <Text style={{ fontSize: 48 }}>🦀</Text>
                        <Text style={{ color: '#fff', fontWeight: '800', fontSize: 18 }}>
                          {banner?.title || 'CRABOR'}
                        </Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={styles.dots}>
              {banners.map((_, index) => (
                <View 
                  key={index} 
                  style={[styles.dot, index === bannerIdx && styles.dotActive]} 
                />
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
              {flashDeals.map((deal, index) => (
                <TouchableOpacity
                  key={deal?._id || index}
                  style={styles.flashCard}
                  onPress={() => navigation.navigate('RestaurantMenu', { partner: deal?.partner })}
                >
                  <View style={styles.flashBadge}>
                    <Text style={styles.flashBadgeText}>-{deal?.discount || 0}%</Text>
                  </View>
                  <Text style={styles.flashName} numberOfLines={1}>
                    {deal?.name || 'Sản phẩm'}
                  </Text>
                  <Text style={styles.flashPrice}>
                    {formatCurrency(deal?.discountedPrice || 0)}
                  </Text>
                  <Text style={styles.flashOriginal}>
                    {formatCurrency(deal?.originalPrice || 0)}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Categories */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🍽️ Danh mục</Text>
          <View style={styles.categories}>
            {CATEGORIES.map((category) => (
              <TouchableOpacity
                key={category.id}
                style={styles.catItem}
                onPress={() => navigation.navigate('Food', { category: category.id })}
              >
                <View style={styles.catIcon}>
                  <Text style={{ fontSize: 26 }}>{category.icon}</Text>
                </View>
                <Text style={styles.catLabel}>{category.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Services */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🚀 Dịch vụ CRABOR</Text>
          <View style={styles.servicesGrid}>
            {SERVICES.map((service) => (
              <TouchableOpacity
                key={service.id}
                style={styles.svcCard}
                onPress={() => {
                  safeVibrate(30);
                  handleServicePress(service);
                }}
                activeOpacity={0.75}
              >
                <View style={styles.svcIconWrap}>
                  <Text style={styles.svcIcon}>{service.icon}</Text>
                </View>
                <Text style={styles.svcLabel} numberOfLines={1}>
                  {service.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
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
            featured.map((partner, index) => (
              <TouchableOpacity
                key={partner?._id || index}
                style={styles.restaurantCard}
                onPress={() => navigation.navigate('RestaurantMenu', { partner })}
              >
                <View style={styles.restaurantImg}>
                  {partner?.logo ? (
                    <Image 
                      source={{ uri: partner.logo }} 
                      style={{ width: '100%', height: '100%', borderRadius: 12 }} 
                    />
                  ) : (
                    <Text style={{ fontSize: 36 }}>🍽️</Text>
                  )}
                </View>
                <View style={styles.restaurantInfo}>
                  <Text style={styles.restaurantName} numberOfLines={1}>
                    {partner?.name || 'Nhà hàng'}
                  </Text>
                  <Text style={styles.restaurantSub} numberOfLines={1}>
                    {partner?.address || 'CRABOR Partner'}
                  </Text>
                  <View style={styles.restaurantMeta}>
                    <Text style={styles.metaBadge}>⭐ {partner?.rating || '5.0'}</Text>
                    <Text style={styles.metaBadge}>🕐 {partner?.deliveryTime || '25'} phút</Text>
                    {partner?.minOrder && (
                      <Text style={styles.metaBadge}>Từ {formatCurrency(partner.minOrder)}</Text>
                    )}
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
            {recentOrders.map((order, index) => (
              <TouchableOpacity
                key={order?._id || index}
                style={styles.orderCard}
                onPress={() => navigation.navigate('OrderDetail', { orderId: order?._id })}
              >
                <Text style={styles.orderPartner}>{order?.partnerName || 'Nhà hàng'}</Text>
                <Text style={styles.orderItems} numberOfLines={1}>
                  {order?.items?.map(item => item.name).join(', ') || ''}
                </Text>
                <View style={styles.orderFooter}>
                  <Text style={styles.orderTotal}>{formatCurrency(order?.total || 0)}</Text>
                  <View style={[styles.statusBadge, { backgroundColor: order?.status === 'delivered' ? Colors.success : Colors.primary }]}>
                    <Text style={styles.statusText}>
                      {order?.status === 'delivered' ? 'Đã giao' : 'Đang xử lý'}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={{ height: 20 }} />

        {/* New User Banner */}
        {(!user?.totalOrders || user.totalOrders < 3) && (
          <TouchableOpacity
            style={styles.newUserBanner}
            onPress={() => {
              safeVibrate(30);
              navigation.navigate('Vouchers');
            }}
            activeOpacity={0.85}
          >
            <View style={styles.newUserBannerLeft}>
              <Text style={styles.newUserBannerBadge}>🎉 ƯU ĐÃI MỚI</Text>
              <Text style={styles.newUserBannerTitle}>Giảm 50% đơn đầu tiên!</Text>
              <Text style={styles.newUserBannerSub}>
                Dùng mã <Text style={{ fontWeight: '900', color: '#FFD84D' }}>CRABOR50</Text> khi thanh toán
              </Text>
            </View>
            <View style={styles.newUserBannerRight}>
              <Text style={{ fontSize: 52 }}>🦀</Text>
              <Text style={styles.newUserBannerClaim}>Nhận ngay →</Text>
            </View>
          </TouchableOpacity>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.primary,
  },
  newUserBanner: {
    marginHorizontal: Spacing.md,
    marginBottom: 12,
    backgroundColor: Colors.primaryDark,
    borderRadius: Radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    overflow: 'hidden',
    ...Shadow.lg,
  },
  newUserBannerLeft: {
    flex: 1,
  },
  newUserBannerBadge: {
    backgroundColor: '#FFD84D',
    color: '#000',
    fontSize: 10,
    fontWeight: '900',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
    marginBottom: 6,
  },
  newUserBannerTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#fff',
    marginBottom: 4,
  },
  newUserBannerSub: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.85)',
    lineHeight: 18,
  },
  newUserBannerRight: {
    alignItems: 'center',
    gap: 4,
  },
  newUserBannerClaim: {
    fontSize: 11,
    color: '#FFD84D',
    fontWeight: '800',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
  },
  greeting: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 12,
  },
  userName: {
    color: Colors.white,
    fontWeight: '800',
    fontSize: 16,
  },
  topRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  notiBtn: {
    padding: 4,
  },
  notiIcon: {
    fontSize: 22,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchWrap: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  searchInput: {
    backgroundColor: Colors.white,
    borderRadius: Radius.full,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    ...Shadow.sm,
  },
  section: {
    backgroundColor: Colors.white,
    marginTop: 8,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: Colors.text,
  },
  seeAll: {
    fontSize: 12,
    color: Colors.primary,
    fontWeight: '700',
  },
  bannerWrap: {
    backgroundColor: Colors.white,
    paddingTop: 8,
    marginTop: 8,
  },
  banner: {
    width: W - 32,
    marginHorizontal: 16,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  bannerImg: {
    width: '100%',
    height: 160,
    borderRadius: Radius.lg,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginVertical: 8,
    gap: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.gray3,
  },
  dotActive: {
    backgroundColor: Colors.primary,
    width: 18,
  },
  categories: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  catItem: {
    width: (W - 32 - 28) / 4,
    alignItems: 'center',
    paddingVertical: 8,
  },
  catIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: Colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  catLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.text,
    textAlign: 'center',
  },
  servicesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  svcCard: {
    width: '22%',
    alignItems: 'center',
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderRadius: 12,
    ...Shadow.sm,
  },
  svcIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  svcIcon: {
    fontSize: 22,
  },
  svcLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: Colors.text,
    textAlign: 'center',
    paddingHorizontal: 2,
  },
  flashCard: {
    width: 130,
    marginRight: 12,
    backgroundColor: Colors.cream,
    borderRadius: Radius.md,
    padding: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  flashBadge: {
    backgroundColor: Colors.danger,
    borderRadius: Radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  flashBadgeText: {
    color: Colors.white,
    fontSize: 10,
    fontWeight: '800',
  },
  flashName: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: 4,
  },
  flashPrice: {
    fontSize: 14,
    fontWeight: '800',
    color: Colors.primary,
  },
  flashOriginal: {
    fontSize: 11,
    color: Colors.gray4,
    textDecorationLine: 'line-through',
  },
  restaurantCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: Radius.md,
    marginBottom: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  restaurantImg: {
    width: 72,
    height: 72,
    borderRadius: 12,
    backgroundColor: Colors.gray1,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  restaurantInfo: {
    flex: 1,
  },
  restaurantName: {
    fontSize: 15,
    fontWeight: '800',
    color: Colors.text,
  },
  restaurantSub: {
    fontSize: 12,
    color: Colors.textSub,
    marginTop: 2,
  },
  restaurantMeta: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 6,
    flexWrap: 'wrap',
  },
  metaBadge: {
    backgroundColor: Colors.gray1,
    borderRadius: Radius.full,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 11,
    fontWeight: '600',
    color: Colors.gray5,
  },
  empty: {
    textAlign: 'center',
    color: Colors.gray4,
    paddingVertical: 20,
  },
  orderCard: {
    backgroundColor: Colors.gray1,
    borderRadius: Radius.md,
    padding: 14,
    marginBottom: 10,
  },
  orderPartner: {
    fontWeight: '800',
    fontSize: 14,
    color: Colors.text,
  },
  orderItems: {
    fontSize: 12,
    color: Colors.textSub,
    marginTop: 2,
  },
  orderFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  orderTotal: {
    fontWeight: '800',
    color: Colors.primary,
    fontSize: 14,
  },
  statusBadge: {
    borderRadius: Radius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusText: {
    color: Colors.white,
    fontSize: 11,
    fontWeight: '700',
  },
});