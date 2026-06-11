// ============================================================
// Restaurant Menu Screen — Xem menu & thêm vào giỏ
// ============================================================
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Image, ActivityIndicator, TextInput, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { CustomerAPI } from '../../shared/api';

export default function RestaurantMenuScreen({ navigation, route }) {
  const partner = route.params?.partner || {};
  const [menu, setMenu]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [cart, setCart]     = useState({});   // { itemId: quantity }
  const [note, setNote]     = useState('');
  const [voucher, setVoucher] = useState('');
  const [voucherData, setVoucherData] = useState(null);
  const [checkingV, setCheckingV] = useState(false);

  useEffect(() => {
    CustomerAPI.getPartnerMenu(partner._id)
      .then(res => setMenu(res.items || res || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const addItem = (id) => setCart(c => ({ ...c, [id]: (c[id] || 0) + 1 }));
  const removeItem = (id) => setCart(c => {
    const n = { ...c };
    if (n[id] > 1) n[id]--;
    else delete n[id];
    return n;
  });

  const cartItems = menu.filter(i => cart[i._id] > 0).map(i => ({ ...i, quantity: cart[i._id] }));
  const subtotal = cartItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const discount = voucherData?.discount || 0;
  const total = Math.max(0, subtotal - discount);
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);

  const checkVoucher = async () => {
    if (!voucher.trim()) return;
    setCheckingV(true);
    try {
      const res = await CustomerAPI.validateVoucher(voucher.trim().toUpperCase());
      setVoucherData(res.voucher || res);
      Alert.alert('✅ Voucher hợp lệ!', `Giảm ${formatCurrency(res.voucher?.discount || res.discount || 0)}`);
    } catch (e) {
      setVoucherData(null);
      Alert.alert('❌ Voucher không hợp lệ', e.message);
    } finally { setCheckingV(false); }
  };

  const goCheckout = () => {
    if (!cartItems.length) return Alert.alert('Giỏ trống', 'Thêm ít nhất một món nhé!');
    navigation.navigate('Checkout', {
      partner, cartItems, note, voucher: voucherData, subtotal, total,
    });
  };

  // Group menu by category
  const grouped = menu.reduce((acc, item) => {
    const key = item.category || 'Khác';
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  return (
    <SafeAreaView style={s.safe}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
          <Text style={s.backIcon}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={s.headerName} numberOfLines={1}>{partner.name}</Text>
          <Text style={s.headerSub} numberOfLines={1}>{partner.address || 'CRABOR Partner'}</Text>
        </View>
      </View>

      {/* Partner banner */}
      {partner.coverImage && (
        <Image source={{ uri: partner.coverImage }} style={s.banner} resizeMode="cover" />
      )}

      {/* Meta row */}
      <View style={s.metaRow}>
        <Text style={s.metaTag}>⭐ {partner.rating || '5.0'}</Text>
        <Text style={s.metaTag}>🕐 {partner.deliveryTime || '25'} phút</Text>
        {partner.deliveryFee === 0 && <Text style={[s.metaTag, { color: Colors.success }]}>🚚 Free ship</Text>}
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        {loading ? (
          <ActivityIndicator color={Colors.primary} style={{ marginVertical: 40 }} />
        ) : (
          Object.entries(grouped).map(([cat, items]) => (
            <View key={cat}>
              <Text style={s.catHeader}>{cat}</Text>
              {items.filter(i => i.available !== false).map(item => (
                <View key={item._id} style={s.menuItem}>
                  <View style={{ flex: 1, paddingRight: 10 }}>
                    <Text style={s.menuName}>{item.name}</Text>
                    {item.description ? <Text style={s.menuDesc} numberOfLines={2}>{item.description}</Text> : null}
                    <Text style={s.menuPrice}>{formatCurrency(item.price)}</Text>
                  </View>
                  <View style={s.menuRight}>
                    {item.image
                      ? <Image source={{ uri: item.image }} style={s.menuImg} />
                      : <View style={[s.menuImg, s.menuImgPlaceholder]}><Text style={{ fontSize: 32 }}>🍽️</Text></View>
                    }
                    <View style={s.qtyRow}>
                      {cart[item._id] > 0 && (
                        <TouchableOpacity style={s.qtyBtn} onPress={() => removeItem(item._id)}>
                          <Text style={s.qtyBtnText}>−</Text>
                        </TouchableOpacity>
                      )}
                      {cart[item._id] > 0 && (
                        <Text style={s.qtyNum}>{cart[item._id]}</Text>
                      )}
                      <TouchableOpacity style={[s.qtyBtn, s.qtyBtnAdd]} onPress={() => addItem(item._id)}>
                        <Text style={[s.qtyBtnText, { color: '#fff' }]}>+</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          ))
        )}

        {/* Note & Voucher */}
        <View style={s.extras}>
          <Text style={s.extrasTitle}>Ghi chú</Text>
          <TextInput
            style={s.noteInput}
            placeholder="Ghi chú cho nhà hàng (không hành, ít cay...)"
            value={note}
            onChangeText={setNote}
            multiline
          />
          <Text style={s.extrasTitle}>Mã voucher</Text>
          <View style={s.voucherRow}>
            <TextInput
              style={s.voucherInput}
              placeholder="Nhập mã voucher..."
              value={voucher}
              onChangeText={setVoucher}
              autoCapitalize="characters"
            />
            <TouchableOpacity style={s.voucherBtn} onPress={checkVoucher} disabled={checkingV}>
              <Text style={s.voucherBtnText}>{checkingV ? '...' : 'Áp dụng'}</Text>
            </TouchableOpacity>
          </View>
          {voucherData && <Text style={s.voucherOk}>✅ Giảm {formatCurrency(voucherData.discount)}</Text>}
        </View>

        {/* Order summary */}
        {cartItems.length > 0 && (
          <View style={s.summary}>
            <Text style={s.summaryTitle}>Tóm tắt đơn hàng</Text>
            {cartItems.map(i => (
              <View key={i._id} style={s.summaryRow}>
                <Text style={s.summaryItem}>{i.quantity}× {i.name}</Text>
                <Text style={s.summaryPrice}>{formatCurrency(i.price * i.quantity)}</Text>
              </View>
            ))}
            {discount > 0 && (
              <View style={s.summaryRow}>
                <Text style={[s.summaryItem, { color: Colors.success }]}>Voucher</Text>
                <Text style={[s.summaryPrice, { color: Colors.success }]}>-{formatCurrency(discount)}</Text>
              </View>
            )}
            <View style={[s.summaryRow, { borderTopWidth: 1, borderTopColor: Colors.border, marginTop: 8, paddingTop: 8 }]}>
              <Text style={s.totalLabel}>Tổng cộng</Text>
              <Text style={s.totalAmount}>{formatCurrency(total)}</Text>
            </View>
          </View>
        )}
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Checkout FAB */}
      {cartCount > 0 && (
        <View style={s.checkoutBar}>
          <View style={s.cartBadge}><Text style={s.cartBadgeText}>{cartCount}</Text></View>
          <Text style={s.checkoutLabel}>Xem giỏ hàng</Text>
          <Text style={s.checkoutTotal}>{formatCurrency(total)}</Text>
          <TouchableOpacity style={s.checkoutBtn} onPress={goCheckout}>
            <Text style={s.checkoutBtnText}>Đặt hàng →</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', padding: Spacing.md },
  backBtn: { padding: 4 },
  backIcon: { color: '#fff', fontSize: 24, fontWeight: '700' },
  headerName: { color: '#fff', fontWeight: '800', fontSize: 16 },
  headerSub: { color: 'rgba(255,255,255,0.75)', fontSize: 11 },
  banner: { width: '100%', height: 160 },
  metaRow: { flexDirection: 'row', gap: 8, padding: Spacing.md, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: Colors.border },
  metaTag: { backgroundColor: Colors.gray1, borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4, fontSize: 12, fontWeight: '600', color: Colors.gray5 },
  catHeader: { backgroundColor: Colors.gray1, paddingHorizontal: Spacing.md, paddingVertical: 8, fontWeight: '800', fontSize: 14, color: Colors.gray5 },
  menuItem: { flexDirection: 'row', backgroundColor: '#fff', padding: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border },
  menuName: { fontWeight: '800', fontSize: 14, color: Colors.text },
  menuDesc: { fontSize: 12, color: Colors.textSub, marginTop: 2, lineHeight: 18 },
  menuPrice: { fontSize: 14, fontWeight: '800', color: Colors.primary, marginTop: 6 },
  menuRight: { alignItems: 'center' },
  menuImg: { width: 80, height: 80, borderRadius: 12, marginBottom: 8 },
  menuImgPlaceholder: { backgroundColor: Colors.cream, alignItems: 'center', justifyContent: 'center' },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qtyBtn: { width: 30, height: 30, borderRadius: 15, borderWidth: 1.5, borderColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  qtyBtnAdd: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  qtyBtnText: { color: Colors.primary, fontWeight: '800', fontSize: 18, lineHeight: 22 },
  qtyNum: { fontWeight: '800', fontSize: 16, color: Colors.text, minWidth: 20, textAlign: 'center' },
  extras: { backgroundColor: '#fff', padding: Spacing.md, marginTop: 8 },
  extrasTitle: { fontWeight: '800', fontSize: 13, color: Colors.gray5, marginBottom: 6, marginTop: 12 },
  noteInput: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, padding: 10, fontSize: 14, minHeight: 64, textAlignVertical: 'top' },
  voucherRow: { flexDirection: 'row', gap: 8 },
  voucherInput: { flex: 1, borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, padding: 10, fontSize: 14 },
  voucherBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingHorizontal: 14, justifyContent: 'center' },
  voucherBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  voucherOk: { color: Colors.success, fontWeight: '700', marginTop: 6, fontSize: 13 },
  summary: { backgroundColor: '#fff', padding: Spacing.md, marginTop: 8 },
  summaryTitle: { fontWeight: '800', fontSize: 14, marginBottom: 10 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  summaryItem: { fontSize: 13, color: Colors.text },
  summaryPrice: { fontSize: 13, fontWeight: '700', color: Colors.text },
  totalLabel: { fontWeight: '800', fontSize: 15, color: Colors.text },
  totalAmount: { fontWeight: '900', fontSize: 16, color: Colors.primary },
  checkoutBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center',
    padding: Spacing.md, gap: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 12,
  },
  cartBadge: { backgroundColor: '#fff', borderRadius: 12, width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  cartBadgeText: { color: Colors.primary, fontWeight: '800', fontSize: 13 },
  checkoutLabel: { flex: 1, color: '#fff', fontWeight: '700', fontSize: 14 },
  checkoutTotal: { color: '#fff', fontWeight: '800', fontSize: 14 },
  checkoutBtn: { backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: Radius.md, paddingHorizontal: 14, paddingVertical: 8 },
  checkoutBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
