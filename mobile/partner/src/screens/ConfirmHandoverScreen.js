// ============================================================
// Confirm Handover Screen — Xác nhận đã đưa đồ cho shipper
// ============================================================
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert,
  ActivityIndicator, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Spacing, Radius, Shadow, formatCurrency, formatDateTime } from '../../shared/theme';
import { PartnerAPI } from '../../shared/api';

const getMsg = (e) => e?.message || e?.data?.message || e?.error || 'Đã có lỗi xảy ra';

export default function ConfirmHandoverScreen({ navigation, route }) {
  const { order } = route.params;
  const [note, setNote]       = useState('');
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const handleConfirm = async () => {
    Alert.alert(
      '✅ Xác nhận đã đưa đồ?',
      `Xác nhận đã giao đơn #${order._id?.slice(-6)} cho shipper?`,
      [
        { text: 'Huỷ', style: 'cancel' },
        {
          text: 'Xác nhận', onPress: async () => {
            setLoading(true);
            try {
              await PartnerAPI.updateOrderStatus?.(order._id, 'ready') ||
                await fetch(`https://crabor-shipper-register.onrender.com/api/orders/${order._id}/status`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ status: 'ready', partnerNote: note }),
                });
              setConfirmed(true);
            } catch (e) {
              Alert.alert('Lỗi', getMsg(e));
            } finally { setLoading(false); }
          }
        }
      ]
    );
  };

  if (confirmed) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.successWrap}>
          <Text style={{fontSize:72}}>✅</Text>
          <Text style={s.successTitle}>Đã xác nhận!</Text>
          <Text style={s.successSub}>Shipper đã được thông báo. Đơn hàng đang được giao đến khách.</Text>
          <TouchableOpacity style={s.doneBtn} onPress={() => navigation.navigate('Main')}>
            <Text style={s.doneBtnTxt}>Về trang chính</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
          <Text style={s.backTxt}>←</Text>
        </TouchableOpacity>
        <Text style={s.title}>Xác nhận đưa đồ</Text>
        <View style={{width:40}}/>
      </View>

      <View style={s.content}>
        {/* Order summary */}
        <View style={s.orderCard}>
          <Text style={s.orderCardTitle}>📦 Thông tin đơn hàng</Text>
          <View style={s.orderRow}>
            <Text style={s.orderLabel}>Mã đơn</Text>
            <Text style={s.orderVal}>#{order._id?.slice(-6)}</Text>
          </View>
          <View style={s.orderRow}>
            <Text style={s.orderLabel}>Khách hàng</Text>
            <Text style={s.orderVal}>{order.customerName || 'Khách hàng'}</Text>
          </View>
          <View style={s.orderRow}>
            <Text style={s.orderLabel}>Tổng tiền</Text>
            <Text style={[s.orderVal, {color: Colors.primary, fontWeight:'900'}]}>
              {formatCurrency(order.total)}
            </Text>
          </View>
          {order.items?.map((item, i) => (
            <View key={i} style={s.itemRow}>
              <Text style={s.itemQty}>{item.quantity}×</Text>
              <Text style={s.itemName}>{item.name}</Text>
            </View>
          ))}
        </View>

        {/* Checklist */}
        <View style={s.checkCard}>
          <Text style={s.checkTitle}>✅ Checklist trước khi đưa</Text>
          {[
            'Kiểm tra đơn hàng đầy đủ',
            'Đóng gói cẩn thận, chống đổ',
            'Xác nhận tên khách hàng với shipper',
            'Chụp ảnh nếu cần bằng chứng',
          ].map((item, i) => (
            <View key={i} style={s.checkRow}>
              <Text style={s.checkIco}>▸</Text>
              <Text style={s.checkTxt}>{item}</Text>
            </View>
          ))}
        </View>

        {/* Note */}
        <View style={s.noteCard}>
          <Text style={s.noteLabel}>Ghi chú cho shipper (không bắt buộc)</Text>
          <TextInput
            style={s.noteInput}
            placeholder="VD: Túi màu đỏ, để trong hộp xốp..."
            value={note}
            onChangeText={setNote}
            multiline
            numberOfLines={3}
          />
        </View>

        {/* Confirm button */}
        <TouchableOpacity
          style={[s.confirmBtn, loading && {opacity:0.6}]}
          onPress={handleConfirm}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#fff"/>
            : <>
                <Text style={s.confirmIco}>✅</Text>
                <Text style={s.confirmTxt}>Xác nhận đã đưa đồ cho shipper</Text>
              </>
          }
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex:1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, flexDirection:'row', alignItems:'center', justifyContent:'space-between', padding: Spacing.lg },
  backBtn: { padding:4 },
  backTxt: { color:'#fff', fontSize:24, fontWeight:'700' },
  title: { fontSize:16, fontWeight:'800', color:'#fff' },
  content: { flex:1, padding: Spacing.lg },
  orderCard: { backgroundColor:'#fff', borderRadius: Radius.lg, padding: Spacing.lg, marginBottom:12, ...Shadow.sm },
  orderCardTitle: { fontWeight:'800', fontSize:15, marginBottom:12 },
  orderRow: { flexDirection:'row', justifyContent:'space-between', marginBottom:6 },
  orderLabel: { fontSize:13, color: Colors.textSub, fontWeight:'600' },
  orderVal: { fontSize:13, fontWeight:'700', color: Colors.text },
  itemRow: { flexDirection:'row', alignItems:'center', gap:8, paddingVertical:4, borderTopWidth:1, borderTopColor: Colors.border, marginTop:4 },
  itemQty: { fontWeight:'800', color: Colors.primary, fontSize:13 },
  itemName: { fontSize:13, color: Colors.text, flex:1 },
  checkCard: { backgroundColor:'#fff', borderRadius: Radius.lg, padding: Spacing.lg, marginBottom:12, ...Shadow.sm },
  checkTitle: { fontWeight:'800', fontSize:14, marginBottom:10 },
  checkRow: { flexDirection:'row', alignItems:'flex-start', gap:8, marginBottom:8 },
  checkIco: { color: Colors.success, fontWeight:'800', fontSize:14 },
  checkTxt: { fontSize:13, color: Colors.text, flex:1, lineHeight:20 },
  noteCard: { backgroundColor:'#fff', borderRadius: Radius.lg, padding: Spacing.lg, marginBottom:16, ...Shadow.sm },
  noteLabel: { fontSize:12, fontWeight:'700', color: Colors.gray5, marginBottom:8 },
  noteInput: { borderWidth:1.5, borderColor: Colors.border, borderRadius: Radius.md, padding:12, fontSize:14, textAlignVertical:'top', minHeight:72 },
  confirmBtn: { backgroundColor: Colors.success, borderRadius: Radius.lg, paddingVertical:16, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:10, ...Shadow.md },
  confirmIco: { fontSize:22 },
  confirmTxt: { color:'#fff', fontWeight:'900', fontSize:15 },
  successWrap: { flex:1, alignItems:'center', justifyContent:'center', padding:32 },
  successTitle: { fontSize:24, fontWeight:'900', color: Colors.text, marginTop:16 },
  successSub: { fontSize:14, color: Colors.textSub, textAlign:'center', marginTop:8, lineHeight:22 },
  doneBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical:14, paddingHorizontal:40, marginTop:28 },
  doneBtnTxt: { color:'#fff', fontWeight:'800', fontSize:15 },
});
