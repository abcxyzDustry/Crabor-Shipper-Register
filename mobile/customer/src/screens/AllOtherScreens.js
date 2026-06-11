// ============================================================
// CRABOR Customer — Remaining Screens Bundle
// ============================================================

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, FlatList, Modal, Linking,
  RefreshControl, Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const vib = () => Vibration.vibrate(30);

import { Colors, Spacing, Radius, Shadow, formatCurrency, formatDateTime, ORDER_STATUS } from '../../shared/theme';
import { CustomerAPI } from '../../shared/api';
import { Storage, KEYS } from '../../shared/storage';

// ─── CHECKOUT ────────────────────────────────────────────────
export function CheckoutScreen({ navigation, route }) {
  const { partner, cartItems = [], note, voucher, subtotal = 0, total = 0 } = route.params || {};
  const [addresses, setAddresses] = useState([]);
  const [selectedAddr, setSelectedAddr] = useState(null);
  const [payMethod, setPayMethod] = useState('cod');
  const [useBNPL, setUseBNPL] = useState(false);
  const [loading, setLoading] = useState(false);
  const [addrLoading, setAddrLoading] = useState(true);

  useEffect(() => {
    CustomerAPI.getAddresses()
      .then(res => {
        const list = res.addresses || res || [];
        setAddresses(list);
        if (list.length) setSelectedAddr(list[0]);
      })
      .catch(() => {})
      .finally(() => setAddrLoading(false));
  }, []);

  const handleOrder = async () => {
    if (!selectedAddr) return Alert.alert('Chưa có địa chỉ', 'Thêm địa chỉ giao hàng để tiếp tục.');
    setLoading(true);
    try {
      const res = await CustomerAPI.createOrder({
        partnerId: partner._id,
        items: cartItems.map(i => ({ itemId: i._id, name: i.name, quantity: i.quantity, price: i.price })),
        deliveryAddress: selectedAddr,
        note,
        voucherCode: voucher?.code,
        paymentMethod: useBNPL ? 'bnpl' : payMethod,
        total,
      });
      Alert.alert('🎉 Đặt hàng thành công!', 'Nhà hàng đang xác nhận đơn của bạn.', [
        { text: 'Xem đơn hàng', onPress: () => navigation.replace('OrderDetail', { orderId: res.orderId || res.order?._id }) },
      ]);
    } catch (e) { Alert.alert('Đặt hàng thất bại', e.message); }
    finally { setLoading(false); }
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.backIcon}>←</Text></TouchableOpacity>
        <Text style={s.headerTitle}>✅ Xác nhận đơn</Text>
      </View>
      <ScrollView>
        {/* Address */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>📍 Địa chỉ giao hàng</Text>
          {addrLoading ? <ActivityIndicator color={Colors.primary} /> : addresses.length === 0 ? (
            <TouchableOpacity style={s.addAddrBtn} onPress={() => navigation.navigate('Address')}>
              <Text style={s.addAddrText}>+ Thêm địa chỉ</Text>
            </TouchableOpacity>
          ) : (
            addresses.map((a, i) => (
              <TouchableOpacity key={i} style={[s.addrCard, selectedAddr === a && s.addrCardActive]} onPress={() => setSelectedAddr(a)}>
                <Text style={s.addrLabel}>{a.label || 'Địa chỉ'}</Text>
                <Text style={s.addrText}>{a.address}</Text>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* Items */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>🍽️ {partner?.name}</Text>
          {cartItems.map((i, idx) => (
            <View key={idx} style={s.itemRow}>
              <Text style={s.itemQty}>{i.quantity}×</Text>
              <Text style={s.itemName}>{i.name}</Text>
              <Text style={s.itemPrice}>{formatCurrency(i.price * i.quantity)}</Text>
            </View>
          ))}
          {note ? <Text style={s.noteDisplay}>📝 {note}</Text> : null}
        </View>

        {/* Payment */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>💳 Thanh toán</Text>
          {[
            { id: 'cod',           label: '💵 Tiền mặt khi nhận hàng' },
            { id: 'bank_transfer', label: '📲 Chuyển khoản SePay (QR)' },
            { id: 'wallet',        label: '💳 Ví CRABOR' },
          ].map(p => (
            <TouchableOpacity key={p.id} style={[s.payRow, payMethod === p.id && s.payRowActive]} onPress={() => setPayMethod(p.id)}>
              <View style={[s.radio, payMethod === p.id && s.radioActive]} />
              <Text style={s.payLabel}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Summary */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>📊 Tổng đơn</Text>
          <View style={s.summaryRow}><Text style={s.summaryKey}>Tạm tính</Text><Text style={s.summaryVal}>{formatCurrency(subtotal)}</Text></View>
          {voucher && <View style={s.summaryRow}><Text style={[s.summaryKey, { color: Colors.success }]}>Voucher</Text><Text style={[s.summaryVal, { color: Colors.success }]}>-{formatCurrency(voucher.discount)}</Text></View>}
          <View style={[s.summaryRow, { borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 8, marginTop: 4 }]}>
            <Text style={[s.summaryKey, { fontWeight: '800', fontSize: 15 }]}>Tổng cộng</Text>
            <Text style={[s.summaryVal, { fontWeight: '900', fontSize: 16, color: Colors.primary }]}>{formatCurrency(total)}</Text>
          </View>
        </View>
        <View style={{ height: 100 }} />
      </ScrollView>

      <View style={s.orderBar}>
        <View>
          <Text style={s.orderBarTotal}>{formatCurrency(total)}</Text>
          <Text style={s.orderBarSub}>{cartItems.length} món</Text>
        </View>
        <TouchableOpacity style={[s.orderBtn, loading && { opacity: 0.6 }]} onPress={handleOrder} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.orderBtnText}>🛵 Đặt hàng ngay</Text>}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ─── ORDER DETAIL ─────────────────────────────────────────────
export function OrderDetailScreen({ navigation, route }) {
  const { orderId, openRating } = route.params || {};
  const [order, setOrder]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [rating, setRating] = useState(5);
  const [ratingModal, setRatingModal] = useState(false);
  const [ratingNote, setRatingNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    load();
    // Poll every 15s for live status
    timer.current = setInterval(load, 15000);
    if (openRating) setTimeout(() => setRatingModal(true), 800);
    return () => clearInterval(timer.current);
  }, []);

  const load = async () => {
    try {
      const res = await CustomerAPI.getOrderDetail(orderId);
      setOrder(res.order || res);
      if (['delivered', 'cancelled'].includes(res.order?.status || res.status)) {
        clearInterval(timer.current);
      }
    } catch {} finally { setLoading(false); }
  };

  const handleRate = async () => {
    setSubmitting(true);
    try {
      await CustomerAPI.rateOrder(orderId, { rating, note: ratingNote });
      setRatingModal(false);
      Alert.alert('⭐ Cảm ơn!', 'Đánh giá của bạn đã được ghi nhận.');
      setOrder(o => ({ ...o, rated: true }));
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setSubmitting(false); }
  };

  if (loading) return <SafeAreaView style={s.safe}><ActivityIndicator color={Colors.primary} style={{ flex: 1 }} /></SafeAreaView>;
  if (!order) return <SafeAreaView style={s.safe}><View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text>Không tìm thấy đơn hàng</Text></View></SafeAreaView>;

  const status = ORDER_STATUS[order.status] || { label: order.status, color: Colors.primary };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.backIcon}>←</Text></TouchableOpacity>
        <Text style={s.headerTitle}>#{orderId?.slice(-6)} — Chi tiết đơn</Text>
      </View>
      <ScrollView>
        {/* Status */}
        <View style={[s.statusBanner, { backgroundColor: status.color }]}>
          <Text style={s.statusBannerText}>{status.label}</Text>
          {['confirmed', 'preparing', 'ready', 'picking_up', 'delivering'].includes(order.status) && (
            <ActivityIndicator color="rgba(255,255,255,0.7)" size="small" style={{ marginLeft: 8 }} />
          )}
        </View>

        {/* Info */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>{order.partnerName}</Text>
          {(order.items || []).map((i, idx) => (
            <View key={idx} style={s.itemRow}>
              <Text style={s.itemQty}>{i.quantity}×</Text>
              <Text style={s.itemName}>{i.name}</Text>
              <Text style={s.itemPrice}>{formatCurrency(i.price * i.quantity)}</Text>
            </View>
          ))}
        </View>

        {/* Address & Shipper */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>📍 Địa chỉ giao</Text>
          <Text style={s.infoText}>{order.deliveryAddress?.address}</Text>
          {order.shipperName && <>
            <Text style={[s.sectionTitle, { marginTop: 12 }]}>🛵 Shipper</Text>
            <Text style={s.infoText}>{order.shipperName}</Text>
            {order.shipperPhone && (
              <TouchableOpacity onPress={() => Linking.openURL(`tel:${order.shipperPhone}`)}>
                <Text style={s.callLink}>📞 {order.shipperPhone}</Text>
              </TouchableOpacity>
            )}
          </>}
        </View>

        {/* Payment */}
        <View style={s.section}>
          <View style={s.summaryRow}><Text style={s.summaryKey}>Tạm tính</Text><Text style={s.summaryVal}>{formatCurrency(order.subtotal || 0)}</Text></View>
          {order.discount > 0 && <View style={s.summaryRow}><Text style={[s.summaryKey, { color: Colors.success }]}>Giảm giá</Text><Text style={[s.summaryVal, { color: Colors.success }]}>-{formatCurrency(order.discount)}</Text></View>}
          <View style={[s.summaryRow, { borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 8 }]}>
            <Text style={[s.summaryKey, { fontWeight: '800' }]}>Tổng cộng</Text>
            <Text style={[s.summaryVal, { fontWeight: '900', color: Colors.primary }]}>{formatCurrency(order.total)}</Text>
          </View>
          <Text style={s.payMethod}>Thanh toán: {order.paymentMethod === 'cod' ? '💵 Tiền mặt' : order.paymentMethod === 'wallet' ? '💳 Ví CRABOR' : order.paymentMethod === 'bank_transfer' ? '📲 Chuyển khoản SePay' : '🏦 Chuyển khoản'}</Text>
        </View>

        {order.status === 'delivered' && !order.rated && (
          <TouchableOpacity style={s.rateBtn} onPress={() => setRatingModal(true)}>
            <Text style={s.rateBtnText}>⭐ Đánh giá đơn hàng này</Text>
          </TouchableOpacity>
        )}
        {order.status === 'delivered' && (
          <TouchableOpacity style={s.reorderBtn} onPress={async () => {
            try { await CustomerAPI.reorder(orderId); Alert.alert('✅', 'Đơn mới đã được tạo!'); }
            catch (e) { Alert.alert('Lỗi', e.message); }
          }}>
            <Text style={s.reorderBtnText}>🔄 Đặt lại đơn này</Text>
          </TouchableOpacity>
        )}
        <View style={{ height: 32 }} />
      </ScrollView>

      {/* Rating Modal */}
      <Modal visible={ratingModal} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>⭐ Đánh giá đơn hàng</Text>
            <View style={s.starsRow}>
              {[1,2,3,4,5].map(star => (
                <TouchableOpacity key={star} onPress={() => setRating(star)}>
                  <Text style={[s.star, star <= rating && s.starActive]}>★</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput style={s.ratingInput} placeholder="Nhận xét (tuỳ chọn)..." value={ratingNote} onChangeText={setRatingNote} multiline />
            <TouchableOpacity style={s.confirmBtn} onPress={handleRate} disabled={submitting}>
              {submitting ? <ActivityIndicator color="#fff" /> : <Text style={s.confirmBtnText}>Gửi đánh giá</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setRatingModal(false)}>
              <Text style={s.cancelBtnText}>Để sau</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── COMPLETE PROFILE ─────────────────────────────────────────
export function CompleteProfileScreen({ navigation }) {
  const [form, setForm] = useState({ name: '', email: '' });
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    if (!form.name.trim()) return Alert.alert('Lỗi', 'Nhập tên của bạn');
    setLoading(true);
    try {
      await CustomerAPI.completeProfile(form);
      navigation.replace('Main');
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setLoading(false); }
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={[s.header, { justifyContent: 'center' }]}><Text style={s.headerTitle}>👋 Hoàn thiện hồ sơ</Text></View>
      <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
        <Text style={s.welcomeText}>Chào mừng bạn đến với CRABOR! 🦀{'\n'}Cho chúng mình biết thêm về bạn nhé.</Text>
        {[
          { k: 'name', label: 'Họ và tên *', ph: 'Nguyễn Văn A' },
          { k: 'email', label: 'Email (tuỳ chọn)', ph: 'example@gmail.com', keyType: 'email-address' },
        ].map(f => (
          <View key={f.k} style={{ marginBottom: 16 }}>
            <Text style={s.fieldLabel}>{f.label}</Text>
            <TextInput
              style={s.fieldInput}
              placeholder={f.ph}
              keyboardType={f.keyType || 'default'}
              value={form[f.k]}
              onChangeText={v => setForm(p => ({ ...p, [f.k]: v }))}
              autoCapitalize={f.k === 'email' ? 'none' : 'words'}
            />
          </View>
        ))}
        <TouchableOpacity style={[s.confirmBtn, { marginTop: 8 }]} onPress={handleSave} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.confirmBtnText}>Bắt đầu đặt đồ ăn 🍜</Text>}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── ADDRESS ─────────────────────────────────────────────────
export function AddressScreen({ navigation }) {
  const [addresses, setAddresses] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [modal, setModal]         = useState(false);
  const [form, setForm]           = useState({ label: 'Nhà', address: '' });
  const [saving, setSaving]       = useState(false);

  useEffect(() => {
    CustomerAPI.getAddresses().then(r => setAddresses(r.addresses || r || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleAdd = async () => {
    if (!form.address.trim()) return Alert.alert('Lỗi', 'Nhập địa chỉ');
    setSaving(true);
    try {
      await CustomerAPI.addAddress(form);
      setAddresses(p => [...p, form]);
      setModal(false);
      setForm({ label: 'Nhà', address: '' });
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = (addr) => {
    Alert.alert('Xoá địa chỉ?', addr.address, [
      { text: 'Huỷ', style: 'cancel' },
      { text: 'Xoá', style: 'destructive', onPress: async () => {
        try { await CustomerAPI.deleteAddress(addr.label); setAddresses(p => p.filter(a => a !== addr)); }
        catch (e) { Alert.alert('Lỗi', e.message); }
      }}
    ]);
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.backIcon}>←</Text></TouchableOpacity>
        <Text style={s.headerTitle}>📍 Địa chỉ của tôi</Text>
        <TouchableOpacity onPress={() => setModal(true)}><Text style={{ color: '#fff', fontWeight: '700' }}>+ Thêm</Text></TouchableOpacity>
      </View>
      {loading ? <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} /> : (
        <FlatList
          data={addresses}
          keyExtractor={(_, i) => String(i)}
          contentContainerStyle={{ padding: Spacing.md }}
          renderItem={({ item }) => (
            <View style={s.addrCard}>
              <Text style={s.addrLabel}>{item.label}</Text>
              <Text style={s.addrText}>{item.address}</Text>
              <TouchableOpacity style={s.deleteAddrBtn} onPress={() => handleDelete(item)}>
                <Text style={{ color: Colors.danger, fontWeight: '700', fontSize: 12 }}>Xoá</Text>
              </TouchableOpacity>
            </View>
          )}
          ListEmptyComponent={<View style={s.empty}><Text style={{ fontSize: 48 }}>📍</Text><Text style={s.emptyText}>Chưa có địa chỉ nào</Text></View>}
        />
      )}
      <Modal visible={modal} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>📍 Thêm địa chỉ</Text>
            <Text style={s.fieldLabel}>Nhãn (Nhà, Công ty...)</Text>
            <TextInput style={s.fieldInput} value={form.label} onChangeText={v => setForm(p => ({ ...p, label: v }))} />
            <Text style={[s.fieldLabel, { marginTop: 10 }]}>Địa chỉ cụ thể</Text>
            <TextInput style={[s.fieldInput, { height: 80, textAlignVertical: 'top' }]} placeholder="Số nhà, đường, phường, quận..." value={form.address} onChangeText={v => setForm(p => ({ ...p, address: v }))} multiline />
            <TouchableOpacity style={s.confirmBtn} onPress={handleAdd} disabled={saving}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.confirmBtnText}>Lưu địa chỉ</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setModal(false)}><Text style={s.cancelBtnText}>Huỷ</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── LOYALTY ─────────────────────────────────────────────────
export function LoyaltyScreen({ navigation }) {
  const [data, setData]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [redeeming, setRedeeming] = useState(false);

  useEffect(() => { CustomerAPI.getLoyalty().then(r => setData(r)).catch(() => {}).finally(() => setLoading(false)); }, []);

  const handleRedeem = () => {
    Alert.alert('Đổi điểm?', `Đổi ${data?.points} điểm thành voucher giảm giá?`, [
      { text: 'Huỷ', style: 'cancel' },
      { text: 'Đổi', onPress: async () => {
        setRedeeming(true);
        try { await CustomerAPI.redeemLoyalty(data.points); Alert.alert('✅', 'Đổi điểm thành công!'); }
        catch (e) { Alert.alert('Lỗi', e.message); }
        finally { setRedeeming(false); }
      }}
    ]);
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.backIcon}>←</Text></TouchableOpacity>
        <Text style={s.headerTitle}>⭐ Điểm thưởng</Text>
      </View>
      {loading ? <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} /> : (
        <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
          <View style={s.loyaltyCard}>
            <Text style={{ fontSize: 52 }}>⭐</Text>
            <Text style={s.loyaltyPoints}>{data?.points || 0}</Text>
            <Text style={s.loyaltyLabel}>Điểm tích luỹ</Text>
            <Text style={s.loyaltySub}>1 đơn hàng = 10 điểm{'\n'}100 điểm = 10,000đ voucher</Text>
            <TouchableOpacity style={[s.confirmBtn, { marginTop: 16, width: '100%' }]} onPress={handleRedeem} disabled={!data?.points || redeeming}>
              {redeeming ? <ActivityIndicator color="#fff" /> : <Text style={s.confirmBtnText}>🎁 Đổi điểm lấy voucher</Text>}
            </TouchableOpacity>
          </View>
          {data?.history?.length > 0 && (
            <>
              <Text style={[s.sectionTitle, { marginTop: 20 }]}>Lịch sử tích điểm</Text>
              {data.history.map((h, i) => (
                <View key={i} style={s.histRow}>
                  <View style={{ flex: 1 }}><Text style={s.histDesc}>{h.description}</Text><Text style={s.histDate}>{formatDateTime(h.createdAt)}</Text></View>
                  <Text style={[s.histPoints, { color: h.points > 0 ? Colors.success : Colors.danger }]}>{h.points > 0 ? '+' : ''}{h.points} điểm</Text>
                </View>
              ))}
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── SUPPORT ─────────────────────────────────────────────────
export function SupportScreen({ navigation }) {
  const [form, setForm] = useState({ subject: '', message: '' });
  const [loading, setLoading] = useState(false);
  const FAQ = [
    { q: '🕐 Đơn hàng bao lâu mới tới?', a: 'Thường 20-40 phút tuỳ khoảng cách và nhà hàng.' },
    { q: '❌ Tôi muốn huỷ đơn?', a: 'Liên hệ hỗ trợ ngay sau khi đặt. Sau khi nhà hàng xác nhận có thể không huỷ được.' },
    { q: '💰 Hoàn tiền như thế nào?', a: 'Hoàn tiền về ví CRABOR trong 1-3 ngày làm việc.' },
    { q: '🎁 Voucher không áp dụng được?', a: 'Kiểm tra điều kiện voucher (giá trị đơn tối thiểu, thời hạn).' },
  ];

  const handleSubmit = async () => {
    if (!form.subject || !form.message) return Alert.alert('Lỗi', 'Điền đầy đủ thông tin');
    setLoading(true);
    try {
      await CustomerAPI.submitSupport(form);
      Alert.alert('✅ Đã gửi', 'Chúng tôi sẽ phản hồi trong vòng 24h.');
      setForm({ subject: '', message: '' });
    } catch (e) { Alert.alert('Lỗi', e.message); }
    finally { setLoading(false); }
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.backIcon}>←</Text></TouchableOpacity>
        <Text style={s.headerTitle}>🎧 Hỗ trợ khách hàng</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
        <Text style={[s.sectionTitle, { marginBottom: 12 }]}>Câu hỏi thường gặp</Text>
        {FAQ.map((f, i) => <View key={i} style={s.faqCard}><Text style={s.faqQ}>{f.q}</Text><Text style={s.faqA}>{f.a}</Text></View>)}
        <Text style={[s.sectionTitle, { marginTop: 20, marginBottom: 12 }]}>Gửi yêu cầu hỗ trợ</Text>
        <Text style={s.fieldLabel}>Tiêu đề</Text>
        <TextInput style={s.fieldInput} placeholder="Mô tả vấn đề ngắn gọn" value={form.subject} onChangeText={v => setForm(p => ({ ...p, subject: v }))} />
        <Text style={[s.fieldLabel, { marginTop: 10 }]}>Chi tiết</Text>
        <TextInput style={[s.fieldInput, { height: 100, textAlignVertical: 'top', marginBottom: 16 }]} placeholder="Mô tả chi tiết vấn đề..." value={form.message} onChangeText={v => setForm(p => ({ ...p, message: v }))} multiline />
        <TouchableOpacity style={s.confirmBtn} onPress={handleSubmit} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.confirmBtnText}>📤 Gửi yêu cầu</Text>}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── VOUCHERS ─────────────────────────────────────────────────
export function VouchersScreen({ navigation }) {
  const [vouchers, setVouchers]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [code, setCode]             = useState('');
  const [checking, setChecking]     = useState(false);
  const [result, setResult]         = useState(null);

  useEffect(() => {
    loadVouchers();
    try {
      const appSocket = require('../../../App').socket;
      if (appSocket) {
        appSocket.on('new_voucher', (voucher) => {
          setVouchers(prev => prev.find(v => v._id === voucher._id) ? prev : [{ ...voucher, isNew: true }, ...prev]);
        });
        return () => appSocket.off('new_voucher');
      }
    } catch(_) {}
  }, []);

  const loadVouchers = async () => {
    try {
      const res = await CustomerAPI.getVouchers();
      setVouchers(res.vouchers || res || []);
    } catch (_) {
      try {
        const res2 = await CustomerAPI.getEarlybird(); // fallback
        setVouchers([]);
      } catch (__) {}
    } finally { setLoading(false); setRefreshing(false); }
  };

  const check = async () => {
    if (!code.trim()) return;
    setChecking(true); setResult(null);
    try {
      const res = await CustomerAPI.validateVoucher(code.trim().toUpperCase());
      setResult({ ok: true, data: res.voucher || res });
    } catch (e) { setResult({ ok: false, msg: e.message }); }
    finally { setChecking(false); }
  };

  const fmtVoucher = (v) => {
    if (!v) return '';
    if (v.type === 'percent') return `Giảm ${v.value}%${v.maxDiscount ? ` (tối đa ${formatCurrency(v.maxDiscount)})` : ''}`;
    return `Giảm ${formatCurrency(v.discount || v.value || 0)}`;
  };

  const isExpired = (v) => v.expiresAt && new Date(v.expiresAt) < new Date();
  const active    = vouchers.filter(v => v.active !== false && !isExpired(v));
  const expired   = vouchers.filter(v => v.active === false || isExpired(v));

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.backIcon}>←</Text></TouchableOpacity>
        <Text style={s.headerTitle}>🎁 Voucher & Ưu đãi</Text>
        <View style={{ width: 32 }} />
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadVouchers(); }} tintColor={Colors.primary} />}
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: 32 }}
      >
        {/* Check thủ công */}
        <View style={{ backgroundColor: '#fff', borderRadius: Radius.lg, padding: Spacing.md, marginBottom: 16, ...Shadow.sm }}>
          <Text style={{ fontWeight: '800', fontSize: 14, marginBottom: 10 }}>🔍 Kiểm tra mã voucher</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              style={[s.fieldInput, { flex: 1, marginBottom: 0 }]}
              placeholder="Nhập mã voucher..."
              value={code} onChangeText={setCode}
              autoCapitalize="characters"
              onSubmitEditing={check}
            />
            <TouchableOpacity style={[s.confirmBtn, { paddingHorizontal: 16, marginTop: 0 }]} onPress={check} disabled={checking}>
              {checking ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.confirmBtnText}>Kiểm tra</Text>}
            </TouchableOpacity>
          </View>
          {result && (
            result.ok
              ? <View style={{ marginTop: 10, backgroundColor: '#F0FFF4', borderRadius: Radius.md, padding: 10 }}>
                  <Text style={{ color: Colors.success, fontWeight: '700' }}>✅ Hợp lệ! {fmtVoucher(result.data)}</Text>
                  {result.data?.minOrder > 0 && <Text style={{ fontSize: 12, color: Colors.textSub, marginTop: 2 }}>Đơn tối thiểu {formatCurrency(result.data.minOrder)}</Text>}
                </View>
              : <View style={{ marginTop: 10, backgroundColor: '#FFF0F0', borderRadius: Radius.md, padding: 10 }}>
                  <Text style={{ color: Colors.danger, fontWeight: '700' }}>❌ {result.msg}</Text>
                </View>
          )}
        </View>

        {/* Danh sách */}
        <Text style={{ fontWeight: '800', fontSize: 14, marginBottom: 10, color: Colors.text }}>
          🎟️ Voucher đang có ({active.length})
        </Text>
        {loading ? <ActivityIndicator color={Colors.primary} style={{ marginTop: 24 }} /> : (
          active.length === 0
            ? <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <Text style={{ fontSize: 40 }}>🎁</Text>
                <Text style={{ color: Colors.gray4, marginTop: 12, textAlign: 'center' }}>Chưa có voucher nào{'\n'}Kéo xuống để cập nhật</Text>
              </View>
            : active.map(v => (
                <View key={v._id} style={{
                  backgroundColor: '#fff', borderRadius: Radius.lg, padding: Spacing.md, marginBottom: 10,
                  borderLeftWidth: 4, borderLeftColor: Colors.primary,
                  borderWidth: v.isNew ? 2 : 0, borderColor: Colors.primary,
                  ...Shadow.sm,
                }}>
                  {v.isNew && <View style={{ backgroundColor: Colors.primary, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start', marginBottom: 6 }}>
                    <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>🆕 Mới</Text>
                  </View>}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <Text style={{ fontSize: 18, fontWeight: '900', color: Colors.primary, letterSpacing: 1 }}>{v.code}</Text>
                    <Text style={{ fontSize: 15, fontWeight: '800', color: Colors.success }}>{fmtVoucher(v)}</Text>
                  </View>
                  {v.description ? <Text style={{ fontSize: 12, color: Colors.textSub, marginTop: 4 }}>{v.description}</Text> : null}
                  <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    {v.minOrder > 0 && <Text style={{ fontSize: 11, backgroundColor: Colors.gray1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, color: Colors.gray5 }}>Đơn tối thiểu {formatCurrency(v.minOrder)}</Text>}
                    {v.module && v.module !== 'all' && <Text style={{ fontSize: 11, backgroundColor: Colors.cream, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, color: Colors.primary }}>{v.module === 'food' ? '🍜 Đồ ăn' : '👕 Giặt là'}</Text>}
                    <Text style={{ fontSize: 11, backgroundColor: Colors.gray1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, color: Colors.gray5 }}>⏰ HSD: {new Date(v.expiresAt).toLocaleDateString('vi-VN')}</Text>
                  </View>
                  <TouchableOpacity
                    style={{ backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 8, alignItems: 'center', marginTop: 10 }}
                    onPress={() => { setCode(v.code); check(); }}
                  >
                    <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>Dùng mã này →</Text>
                  </TouchableOpacity>
                </View>
              ))
        )}

        {expired.length > 0 && (
          <>
            <Text style={{ fontWeight: '800', fontSize: 13, color: Colors.gray4, marginTop: 16, marginBottom: 8 }}>⏰ Đã hết hạn</Text>
            {expired.slice(0, 3).map(v => (
              <View key={v._id} style={{ backgroundColor: Colors.gray2, borderRadius: Radius.md, padding: 12, marginBottom: 6, opacity: 0.6 }}>
                <Text style={{ fontWeight: '800', color: Colors.gray4 }}>{v.code}</Text>
                <Text style={{ fontSize: 12, color: Colors.gray4 }}>Hết hạn {new Date(v.expiresAt).toLocaleDateString('vi-VN')}</Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', padding: Spacing.md, gap: 10 },
  backIcon: { color: '#fff', fontSize: 24, fontWeight: '700' },
  headerTitle: { flex: 1, color: '#fff', fontWeight: '800', fontSize: 16 },
  section: { backgroundColor: '#fff', margin: Spacing.md, marginBottom: 0, borderRadius: Radius.lg, padding: Spacing.md },
  sectionTitle: { fontWeight: '800', fontSize: 14, marginBottom: 8 },
  addrCard: { backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 12, marginBottom: 8, borderWidth: 1.5, borderColor: Colors.border },
  addrCardActive: { borderColor: Colors.primary, backgroundColor: Colors.cream },
  addrLabel: { fontWeight: '800', fontSize: 12, color: Colors.primary },
  addrText: { fontSize: 13, color: Colors.text, marginTop: 2 },
  addAddrBtn: { borderWidth: 1.5, borderColor: Colors.primary, borderRadius: Radius.md, padding: 12, alignItems: 'center', borderStyle: 'dashed' },
  addAddrText: { color: Colors.primary, fontWeight: '700' },
  deleteAddrBtn: { alignSelf: 'flex-end', marginTop: 6 },
  itemRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  itemQty: { fontWeight: '800', color: Colors.primary, width: 28, fontSize: 13 },
  itemName: { flex: 1, fontSize: 13 },
  itemPrice: { fontWeight: '700', fontSize: 13 },
  noteDisplay: { fontSize: 12, color: Colors.textSub, marginTop: 8, fontStyle: 'italic' },
  payRow: { flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: Radius.md, marginBottom: 6, borderWidth: 1.5, borderColor: Colors.border },
  payRowActive: { borderColor: Colors.primary, backgroundColor: Colors.cream },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: Colors.gray3, marginRight: 10 },
  radioActive: { borderColor: Colors.primary, backgroundColor: Colors.primary },
  payLabel: { fontSize: 14, fontWeight: '600' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  summaryKey: { fontSize: 13, color: Colors.text },
  summaryVal: { fontSize: 13, fontWeight: '700' },
  payMethod: { fontSize: 12, color: Colors.textSub, marginTop: 8 },
  orderBar: { backgroundColor: '#fff', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.md, borderTopWidth: 1, borderTopColor: Colors.border, elevation: 8 },
  orderBarTotal: { fontWeight: '900', fontSize: 18, color: Colors.primary },
  orderBarSub: { fontSize: 11, color: Colors.textSub },
  orderBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, paddingHorizontal: 24 },
  orderBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  statusBanner: { padding: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
  statusBannerText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  infoText: { fontSize: 14, color: Colors.text, lineHeight: 22 },
  callLink: { color: Colors.primary, fontWeight: '700', fontSize: 14, marginTop: 4 },
  rateBtn: { margin: Spacing.md, backgroundColor: Colors.cream, borderRadius: Radius.md, padding: 14, alignItems: 'center' },
  rateBtnText: { color: Colors.primary, fontWeight: '800', fontSize: 14 },
  reorderBtn: { marginHorizontal: Spacing.md, borderWidth: 1.5, borderColor: Colors.primary, borderRadius: Radius.md, padding: 14, alignItems: 'center' },
  reorderBtnText: { color: Colors.primary, fontWeight: '700', fontSize: 14 },
  starsRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginVertical: 12 },
  star: { fontSize: 40, color: Colors.gray3 },
  starActive: { color: Colors.warning },
  ratingInput: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, padding: 10, fontSize: 14, minHeight: 80, textAlignVertical: 'top', marginBottom: 12 },
  welcomeText: { fontSize: 15, color: Colors.text, lineHeight: 24, marginBottom: 24, textAlign: 'center' },
  loyaltyCard: { backgroundColor: '#fff', borderRadius: Radius.lg, padding: 24, alignItems: 'center', ...Shadow.md },
  loyaltyPoints: { fontSize: 52, fontWeight: '900', color: Colors.primary },
  loyaltyLabel: { fontSize: 14, color: Colors.textSub, fontWeight: '700' },
  loyaltySub: { fontSize: 12, color: Colors.textSub, textAlign: 'center', marginTop: 8, lineHeight: 20 },
  histRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: Radius.md, padding: 12, marginBottom: 8, ...Shadow.sm },
  histDesc: { fontWeight: '600', fontSize: 13 },
  histDate: { fontSize: 11, color: Colors.textLight, marginTop: 2 },
  histPoints: { fontWeight: '800', fontSize: 14 },
  faqCard: { backgroundColor: '#fff', borderRadius: Radius.md, padding: 14, marginBottom: 8, ...Shadow.sm },
  faqQ: { fontWeight: '800', fontSize: 14, marginBottom: 6 },
  faqA: { fontSize: 13, color: Colors.textSub, lineHeight: 20 },
  voucherResult: { backgroundColor: '#F0FFF4', borderRadius: Radius.md, padding: 12, marginBottom: 12 },
  voucherResultOk: { color: Colors.success, fontWeight: '700', fontSize: 14 },
  voucherChip: { backgroundColor: '#fff', borderRadius: Radius.md, padding: 14, marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between', ...Shadow.sm },
  voucherChipCode: { fontWeight: '800', fontSize: 15, color: Colors.primary, letterSpacing: 2 },
  voucherChipArrow: { fontSize: 13, color: Colors.gray4 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: 16 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: Colors.gray5, marginBottom: 6 },
  fieldInput: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginBottom: 8 },
  confirmBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center' },
  confirmBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12 },
  cancelBtnText: { color: Colors.gray4 },
  empty: { alignItems: 'center', paddingVertical: 60 },
  emptyText: { fontSize: 14, color: Colors.gray4, marginTop: 12, textAlign: 'center' },
});
