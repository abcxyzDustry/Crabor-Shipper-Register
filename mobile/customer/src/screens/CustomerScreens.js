// ============================================================
// CRABOR Customer Screens Bundle
// Orders • Profile • Coco AI Chat (FIXED)
// ============================================================
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, ActivityIndicator, Alert, ScrollView, TextInput,
  Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Spacing, Radius, Shadow, formatCurrency, formatDateTime, ORDER_STATUS } from '../../shared/theme';
import { CustomerAPI } from '../../shared/api';
import { Storage } from '../../shared/storage';

const vib = () => Vibration.vibrate(30);

// ============================================================
// Customer Orders Screen
// ============================================================
export function OrdersScreen({ navigation }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    try {
      const res = await CustomerAPI.getOrders();
      setOrders(res.orders || res || []);
    } catch (e) {
      // Silent fail
    } finally { setLoading(false); setRefreshing(false); }
  };

  const getStatusColor = (status) => ORDER_STATUS[status]?.color || Colors.primary;
  const getStatusLabel = (status) => ORDER_STATUS[status]?.label || status;

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={s.card}
      onPress={() => navigation.navigate('OrderDetail', { orderId: item._id })}
    >
      <View style={s.cardTop}>
        <View style={{ flex: 1 }}>
          <Text style={s.partnerName}>{item.partnerName || 'Nhà hàng'}</Text>
          <Text style={s.items} numberOfLines={1}>{item.items?.map(i => `${i.quantity}x ${i.name}`).join(', ')}</Text>
          <Text style={s.time}>{formatDateTime(item.createdAt)}</Text>
        </View>
        <View>
          <View style={[s.statusBadge, { backgroundColor: getStatusColor(item.status) }]}>
            <Text style={s.statusBadgeText}>{getStatusLabel(item.status)}</Text>
          </View>
          <Text style={s.total}>{formatCurrency(item.total)}</Text>
        </View>
      </View>
      {item.status === 'delivered' && !item.rated && (
        <TouchableOpacity
          style={s.rateBtn}
          onPress={() => navigation.navigate('OrderDetail', { orderId: item._id, openRating: true })}
        >
          <Text style={s.rateBtnText}>⭐ Đánh giá đơn hàng</Text>
        </TouchableOpacity>
      )}
      {['confirmed', 'preparing', 'ready', 'picking_up', 'delivering'].includes(item.status) && (
        <View style={s.trackingBanner}>
          <Text style={s.trackingText}>📍 Theo dõi đơn hàng →</Text>
        </View>
      )}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}><Text style={s.headerTitle}>📦 Đơn hàng</Text></View>
      {loading
        ? <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} />
        : <FlatList
            data={orders}
            keyExtractor={item => item._id}
            renderItem={renderItem}
            contentContainerStyle={{ padding: Spacing.lg }}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => { setRefreshing(true); load(); }}
                tintColor={Colors.primary}
              />
            }
            ListEmptyComponent={
              <View style={s.empty}>
                <Text style={{ fontSize: 48 }}>📭</Text>
                <Text style={s.emptyText}>Bạn chưa có đơn hàng nào{'\n'}Đặt đồ ăn ngay nhé!</Text>
              </View>
            }
          />
      }
    </SafeAreaView>
  );
}

// ============================================================
// Customer Profile Screen
// ============================================================
export function ProfileScreen({ navigation }) {
  const [user, setUser] = useState(null);
  const [loyalty, setLoyalty] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([CustomerAPI.getMe(), CustomerAPI.getLoyalty()])
      .then(([u, l]) => {
        if (u.status === 'fulfilled') setUser(u.value?.user || u.value);
        if (l.status === 'fulfilled') setLoyalty(l.value);
      }).finally(() => setLoading(false));
  }, []);

  const handleLogout = () => {
    Alert.alert('Đăng xuất?', '', [
      { text: 'Huỷ', style: 'cancel' },
      {
        text: 'Đăng xuất', style: 'destructive', onPress: async () => {
          await Storage.clear();
          navigation.replace('Login');
        },
      },
    ]);
  };

  const menuItems = [
    { icon: '💳', label: 'Ví CRABOR', badge: formatCurrency(user?.walletBalance || 0), onPress: () => { vib(); navigation.navigate('Wallet'); } },
    { icon: '💰', label: 'Nạp tiền vào ví', onPress: () => { vib(); navigation.navigate('WalletTopup'); } },
    { icon: '📍', label: 'Địa chỉ giao hàng', onPress: () => { vib(); navigation.navigate('Address'); } },
    { icon: '⭐', label: 'Điểm thưởng', badge: `${loyalty?.points || 0} điểm`, onPress: () => { vib(); navigation.navigate('Loyalty'); } },
    { icon: '🎁', label: 'Voucher của tôi', onPress: () => { vib(); navigation.navigate('Vouchers'); } },
    { icon: '💰', label: 'Kiếm thêm thu nhập', onPress: () => { vib(); navigation.navigate('Sales'); } },
    { icon: '🤖', label: 'Hỏi Coco AI', onPress: () => { vib(); navigation.navigate('Coco'); } },
    { icon: '🎧', label: 'Hỗ trợ khách hàng', onPress: () => { vib(); navigation.navigate('Support'); } },
    { icon: '⚙️', label: 'Cài đặt ứng dụng', onPress: () => { vib(); navigation.navigate('Settings'); } },
  ];

  if (loading) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={Colors.primary} />
    </View>
  );

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}><Text style={s.headerTitle}>👤 Tôi</Text></View>
      <ScrollView>
        <View style={s.profileCard}>
          <View style={s.avatarBig}><Text style={{ fontSize: 44 }}>👤</Text></View>
          <Text style={s.profileName}>{user?.fullName || user?.name || 'Khách hàng'}</Text>
          <Text style={s.profileSub}>{user?.phone || user?.email || ''}</Text>
          {loyalty?.points > 0 && (
            <View style={s.pointsBadge}>
              <Text style={s.pointsBadgeText}>⭐ {loyalty.points} điểm tích luỹ</Text>
            </View>
          )}
        </View>

        {menuItems.map((item, i) => (
          <TouchableOpacity key={i} style={s.menuRow} onPress={item.onPress}>
            <Text style={s.menuIcon}>{item.icon}</Text>
            <Text style={s.menuLabel}>{item.label}</Text>
            {item.badge && <View style={s.menuBadge}><Text style={s.menuBadgeText}>{item.badge}</Text></View>}
            <Text style={s.menuArrow}>›</Text>
          </TouchableOpacity>
        ))}

        <TouchableOpacity style={s.logoutBtn} onPress={handleLogout}>
          <Text style={s.logoutBtnText}>🚪 Đăng xuất</Text>
        </TouchableOpacity>
        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ============================================================
// Customer Coco AI Chat Screen - FIXED
// ============================================================
export function CocoScreen({ navigation }) {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Xin chào! Tôi là Coco 🦀 Trợ lý AI của CRABOR. Tôi có thể giúp bạn đặt đồ ăn, kiểm tra đơn hàng, và nhiều hơn nữa! 😊' },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const listRef = React.useRef(null);
  // Tạo sessionId duy nhất cho cuộc trò chuyện
  const sessionIdRef = React.useRef(Date.now().toString());

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: 'user', content: input.trim() };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    const question = input.trim();
    setInput('');
    setLoading(true);
    
    try {
      // ✅ Gửi đúng format: text + sessionId
      const res = await CustomerAPI.cocoChat(question, sessionIdRef.current);
      const reply = res.message || res.text || res.reply || 'Xin lỗi, tôi chưa hiểu ý bạn 😅';
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (e) {
      console.error('Coco error:', e);
      setMessages(prev => [...prev, { role: 'assistant', content: '❌ Lỗi kết nối. Thử lại nhé!' }]);
    } finally { 
      setLoading(false); 
    }
  };

  const QUICK_REPLIES = ['🍜 Gợi ý món ăn', '📦 Kiểm tra đơn hàng', '💰 Hỏi về ví tiền', '🎁 Xem voucher'];

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.chatHeader}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={{ color: '#fff', fontSize: 24 }}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 16 }}>🦀 Coco AI</Text>
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11 }}>Luôn sẵn sàng hỗ trợ bạn</Text>
        </View>
      </View>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: Spacing.md }}
        renderItem={({ item }) => (
          <View style={[s.bubble, item.role === 'user' ? s.bubbleUser : s.bubbleBot]}>
            {item.role === 'assistant' && <Text style={{ fontSize: 18, marginBottom: 4 }}>🦀</Text>}
            <View style={[s.bubbleInner, item.role === 'user' ? s.bubbleInnerUser : s.bubbleInnerBot]}>
              <Text style={[s.bubbleText, item.role === 'user' ? s.bubbleTextUser : s.bubbleTextBot]}>
                {item.content}
              </Text>
            </View>
          </View>
        )}
        ListFooterComponent={
          loading
            ? <View style={s.bubbleBot}><View style={s.bubbleInnerBot}><Text style={s.bubbleTextBot}>⌛ Đang trả lời...</Text></View></View>
            : null
        }
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.quickRepliesScroll}
        contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}
      >
        {QUICK_REPLIES.map((q, i) => (
          <TouchableOpacity key={i} style={s.quickReply} onPress={() => setInput(q)}>
            <Text style={s.quickReplyText}>{q}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <View style={s.inputBar}>
        <TextInput
          style={s.chatInput}
          placeholder="Nhập tin nhắn..."
          value={input}
          onChangeText={setInput}
          onSubmitEditing={send}
          returnKeyType="send"
          multiline
        />
        <TouchableOpacity
          style={[s.sendBtn, (!input.trim() || loading) && s.sendBtnDis]}
          onPress={send}
          disabled={!input.trim() || loading}
        >
          <Text style={s.sendBtnText}>➤</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ============================================================
// Styles
// ============================================================
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, padding: Spacing.lg },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#fff' },
  // Orders
  card: { backgroundColor: '#fff', borderRadius: Radius.lg, padding: 14, marginBottom: 12, ...Shadow.sm },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start' },
  partnerName: { fontWeight: '800', fontSize: 14 },
  items: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
  time: { fontSize: 11, color: Colors.textLight, marginTop: 4 },
  statusBadge: { borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-end', marginBottom: 4 },
  statusBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  total: { fontWeight: '800', color: Colors.primary, fontSize: 14, textAlign: 'right' },
  rateBtn: { marginTop: 10, backgroundColor: Colors.cream, borderRadius: Radius.md, paddingVertical: 8, alignItems: 'center' },
  rateBtnText: { color: Colors.primary, fontWeight: '700', fontSize: 13 },
  trackingBanner: { marginTop: 8, backgroundColor: Colors.primary + '15', borderRadius: Radius.md, paddingVertical: 8, paddingHorizontal: 12 },
  trackingText: { color: Colors.primary, fontWeight: '700', fontSize: 12 },
  empty: { alignItems: 'center', paddingVertical: 60 },
  emptyText: { fontSize: 14, color: Colors.gray4, textAlign: 'center', marginTop: 12, lineHeight: 22 },
  // Profile
  profileCard: { backgroundColor: '#fff', margin: Spacing.md, borderRadius: Radius.lg, padding: 24, alignItems: 'center', ...Shadow.sm },
  avatarBig: { width: 80, height: 80, borderRadius: 40, backgroundColor: Colors.cream, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  profileName: { fontSize: 20, fontWeight: '900', color: Colors.text },
  profileSub: { fontSize: 13, color: Colors.textSub, marginTop: 4 },
  pointsBadge: { backgroundColor: Colors.cream, borderRadius: Radius.full, paddingHorizontal: 14, paddingVertical: 6, marginTop: 10 },
  pointsBadgeText: { color: Colors.primary, fontWeight: '700', fontSize: 13 },
  menuRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', marginHorizontal: Spacing.md, marginBottom: 6, borderRadius: Radius.md, padding: 16, ...Shadow.sm },
  menuIcon: { fontSize: 20, width: 32 },
  menuLabel: { flex: 1, fontSize: 14, fontWeight: '600', color: Colors.text },
  menuBadge: { backgroundColor: Colors.primary + '20', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginRight: 6 },
  menuBadgeText: { color: Colors.primary, fontSize: 12, fontWeight: '700' },
  menuArrow: { fontSize: 22, color: Colors.gray3, fontWeight: '700' },
  logoutBtn: { margin: Spacing.md, marginTop: 16, borderWidth: 1.5, borderColor: Colors.danger, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center' },
  logoutBtnText: { color: Colors.danger, fontWeight: '800', fontSize: 15 },
  // Coco chat
  chatHeader: { backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', padding: Spacing.lg },
  bubble: { marginBottom: 12 },
  bubbleUser: { alignItems: 'flex-end' },
  bubbleBot: { alignItems: 'flex-start', flexDirection: 'row', gap: 6 },
  bubbleInner: { maxWidth: '80%', borderRadius: 16, padding: 12 },
  bubbleInnerUser: { backgroundColor: Colors.primary, borderBottomRightRadius: 4 },
  bubbleInnerBot: { backgroundColor: '#fff', borderBottomLeftRadius: 4, ...Shadow.sm },
  bubbleText: { fontSize: 14, lineHeight: 20 },
  bubbleTextUser: { color: '#fff' },
  bubbleTextBot: { color: Colors.text },
  quickRepliesScroll: { backgroundColor: '#fff', maxHeight: 52, borderTopWidth: 1, borderTopColor: Colors.border },
  quickReply: { backgroundColor: Colors.cream, borderRadius: Radius.full, paddingHorizontal: 14, paddingVertical: 8, height: 36 },
  quickReplyText: { color: Colors.primary, fontWeight: '700', fontSize: 12 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: '#fff', padding: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border, gap: 8 },
  chatInput: { flex: 1, backgroundColor: Colors.gray1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, maxHeight: 100 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  sendBtnDis: { backgroundColor: Colors.gray3 },
  sendBtnText: { color: '#fff', fontSize: 18, fontWeight: '800' },
});