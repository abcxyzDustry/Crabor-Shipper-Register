// ============================================================
// CRABOR — Ride Screen (Đặt xe công nghệ)
// Xe máy: 5,000đ/km | Ô tô: 15,000đ/km | Surge ×1.5
// ============================================================
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, Alert, ActivityIndicator, StatusBar, Modal, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { WebView } from 'react-native-webview';
import { Colors, Spacing, Radius, Shadow, formatCurrency } from '../../shared/theme';
import { RideAPI } from '../../shared/api'; // dùng cho book/cancel
import { useRequireAuth } from '../../shared/useRequireAuth';
import { socket } from '../../App'; // ✅ SỬA: từ ../../../App thành ../../App

// ── Cấu hình giá ─────────────────────────────────────────────
const VEHICLE_TYPES = [
  {
    id: 'bike',
    icon: '🛵',
    label: 'Xe máy',
    subLabel: 'Nhanh & tiết kiệm',
    ratePerKm: 5000,
    minFee: 15000,
    minKm: 1,
    seats: '1 người',
  },
  {
    id: 'car',
    icon: '🚗',
    label: 'Ô tô',
    subLabel: 'Thoải mái & rộng rãi',
    ratePerKm: 15000,
    minFee: 30000,
    minKm: 1,
    seats: '4 người',
  },
];

const SURGE_PERIODS = [
  { startH: 11, endH: 12 },
  { startH: 19, endH: 20 },
];

function getSurge() {
  const h = new Date().getHours();
  const isSurge = SURGE_PERIODS.some(p => h >= p.startH && h < p.endH);
  return { isSurge, multiplier: isSurge ? 1.5 : 1.0 };
}

function calcFare(vehicle, distanceKm, surgeMultiplier = 1.0) {
  const km = Math.max(distanceKm, vehicle.minKm);
  const base = Math.round(km * vehicle.ratePerKm);
  const total = Math.max(vehicle.minFee, Math.round(base * surgeMultiplier));
  return total;
}

export default function RideScreen({ navigation }) {
  const { guardAction } = useRequireAuth(navigation);

  const [pickup, setPickup]       = useState('');
  const [dropoff, setDropoff]     = useState('');
  const [pickupCoord, setPickupCoord] = useState(null);
  const [dropoffCoord, setDropoffCoord] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState('bike');
  const [distance, setDistance]   = useState(null); // km
  const [duration, setDuration]   = useState(null); // phút
  const [estimating, setEstimating] = useState(false);
  const [booking, setBooking]     = useState(false);
  const [surge, setSurge]         = useState(getSurge());
  const [activeRide, setActiveRide] = useState(null);
  const [driverInfo, setDriverInfo] = useState(null); // thông tin tài xế sau khi accepted
  const [mapModal, setMapModal]     = useState(null); // 'pickup' | 'dropoff'
  const [mapCoord, setMapCoord]     = useState(null);
  const [mapAddress, setMapAddress] = useState('');
  const [mapLoading, setMapLoading] = useState(false);
  const [confirmModal, setConfirmModal] = useState(false);
  const [locLoading, setLocLoading] = useState(false);
  const surgeTimer = useRef(null);

  useEffect(() => {
    getMyLocation();
    surgeTimer.current = setInterval(() => setSurge(getSurge()), 60000);
    return () => clearInterval(surgeTimer.current);
  }, []);

  // Socket: lắng nghe tài xế xác nhận cuốc
  useEffect(() => {
    if (!socket) return;
    socket.on('ride_accepted', (data) => {
      setDriverInfo(data.shipper);
      setActiveRide(prev => prev ? { ...prev, status: 'accepted', driver: data.shipper } : prev);
    });
    socket.on('ride_completed', () => {
      Alert.alert('✅ Chuyến hoàn thành!', 'Cảm ơn bạn đã dùng CRABOR! 🦀');
      setActiveRide(null);
      setDriverInfo(null);
    });
    return () => {
      socket?.off('ride_accepted');
      socket?.off('ride_completed');
    };
  }, [socket]);

  // Tự estimate lại khi đủ thông tin
  useEffect(() => {
    if (pickupCoord && dropoffCoord) getEstimate();
  }, [pickupCoord, dropoffCoord]); // eslint-disable-line

  // ── Lấy vị trí hiện tại ─────────────────────────────────────
  const getMyLocation = async () => {
    setLocLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Cần quyền vị trí', 'Hãy cho phép ứng dụng truy cập vị trí để đặt xe.');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const { latitude, longitude } = loc.coords;
      setPickupCoord({ lat: latitude, lng: longitude });

      // Dùng expo-location reverse geocode (không cần backend)
      const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
      if (place) {
        const addr = [place.street, place.district, place.city]
          .filter(Boolean).join(', ');
        setPickup(addr || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
      } else {
        setPickup(`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
      }
    } catch (e) {
      console.warn('Location error:', e);
    } finally { setLocLoading(false); }
  };

  // ── Geocode điểm đến ─────────────────────────────────────────
  const geocodeDropoff = async () => {
    if (!dropoff.trim()) return;
    setEstimating(true);
    try {
      // Dùng expo-location geocode (không cần backend)
      const results = await Location.geocodeAsync(dropoff);
      if (results && results.length > 0) {
        const { latitude, longitude } = results[0];
        setDropoffCoord({ lat: latitude, lng: longitude });
      } else {
        Alert.alert('Không tìm thấy địa điểm', 'Hãy nhập địa chỉ cụ thể hơn (ví dụ: "123 Nguyễn Huệ, Q1, HCM")');
      }
    } catch (e) {
      Alert.alert('Lỗi', 'Không thể tìm địa điểm. Thử nhập đầy đủ hơn nhé!');
    } finally { setEstimating(false); }
  };

  // ── Mở map picker ──────────────────────────────────────────
  const openMapPicker = async (type) => {
    const coord = type === 'pickup' ? pickupCoord : dropoffCoord;
    if (coord) {
      setMapCoord(coord);
    } else if (type === 'pickup') {
      // Tự lấy vị trí hiện tại
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setMapCoord({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      } catch {
        setMapCoord({ lat: 10.7769, lng: 106.7009 }); // fallback HCM
      }
    } else {
      setMapCoord(pickupCoord || { lat: 10.7769, lng: 106.7009 });
    }
    setMapAddress(type === 'pickup' ? pickup : dropoff);
    setMapModal(type);
  };

  const confirmMapLocation = async () => {
    if (!mapCoord) return;
    setMapLoading(true);
    try {
      const [place] = await Location.reverseGeocodeAsync({
        latitude: mapCoord.lat,
        longitude: mapCoord.lng,
      });
      const addr = place
        ? [place.street, place.district, place.city].filter(Boolean).join(', ')
        : `${mapCoord.lat.toFixed(5)}, ${mapCoord.lng.toFixed(5)}`;

      if (mapModal === 'pickup') {
        setPickup(addr);
        setPickupCoord(mapCoord);
      } else {
        setDropoff(addr);
        setDropoffCoord(mapCoord);
      }
    } catch {
      if (mapModal === 'pickup') {
        setPickup(`${mapCoord.lat.toFixed(5)}, ${mapCoord.lng.toFixed(5)}`);
        setPickupCoord(mapCoord);
      } else {
        setDropoff(`${mapCoord.lat.toFixed(5)}, ${mapCoord.lng.toFixed(5)}`);
        setDropoffCoord(mapCoord);
      }
    } finally {
      setMapLoading(false);
      setMapModal(null);
    }
  };

  // HTML cho Leaflet map
  const buildMapHtml = (lat, lng) => `
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body, #map { width:100%; height:100vh; }
  #pin {
    position:fixed; top:50%; left:50%; z-index:9999;
    transform:translate(-50%, -100%);
    font-size:36px; pointer-events:none;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4));
  }
</style>
</head>
<body>
<div id="map"></div>
<div id="pin">📍</div>
<script>
  var map = L.map('map', { zoomControl:false, attributionControl:false })
    .setView([${lat}, ${lng}], 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

  // Zoom control - góc phải dưới
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Nút định vị - góc phải trên
  var locBtn = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function() {
      var btn = L.DomUtil.create('button', '');
      btn.innerHTML = '📍';
      btn.title = 'Vị trí của tôi';
      btn.style.cssText = 'width:40px;height:40px;font-size:20px;background:#fff;border:none;border-radius:8px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);margin:8px;';
      L.DomEvent.on(btn, 'click', function(e) {
        L.DomEvent.stopPropagation(e);
        btn.innerHTML = '⏳';
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            function(pos) {
              var lat = pos.coords.latitude, lng = pos.coords.longitude;
              map.setView([lat, lng], 17, { animate: true });
              btn.innerHTML = '📍';
            },
            function() {
              btn.innerHTML = '📍';
              alert('Không thể xác định vị trí');
            },
            { enableHighAccuracy: true, timeout: 8000 }
          );
        }
      });
      return btn;
    }
  });
  new locBtn().addTo(map);

  map.on('moveend', function() {
    var c = map.getCenter();
    window.ReactNativeWebView.postMessage(JSON.stringify({ lat: c.lat, lng: c.lng }));
  });
</script>
</body>
</html>`;

  // ── Haversine formula tính khoảng cách thực giữa 2 tọa độ
  const haversineKm = (lat1, lng1, lat2, lng2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
      Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
    return parseFloat((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 1.3).toFixed(1));
  };

  const getEstimate = async () => {
    if (!pickupCoord || !dropoffCoord) return;
    setEstimating(true);
    try {
      const km = haversineKm(pickupCoord.lat, pickupCoord.lng, dropoffCoord.lat, dropoffCoord.lng);
      const min = Math.ceil(km * 3); // ước tính ~20km/h
      setDistance(km);
      setDuration(min);
    } finally { setEstimating(false); }
  };

  // ── Đặt xe ──────────────────────────────────────────────────
  const handleBook = guardAction(async () => {
    if (!pickup || !dropoff) return Alert.alert('Lỗi', 'Nhập điểm đón và điểm đến nhé!');
    if (!pickupCoord) return Alert.alert('Lỗi', 'Chưa xác định được điểm đón.');
    if (!dropoffCoord) {
      await geocodeDropoff();
      return;
    }
    setConfirmModal(true);
  });

  const confirmBook = async () => {
    setConfirmModal(false);
    setBooking(true);
    try {
      const vehicle = VEHICLE_TYPES.find(v => v.id === selectedVehicle);
      const fare = distance ? calcFare(vehicle, distance, surge.multiplier) : vehicle.minFee;
      const res = await RideAPI.book({
        vehicleType:  selectedVehicle,
        fromAddress:  pickup,
        fromLat:      pickupCoord.lat,
        fromLng:      pickupCoord.lng,
        toAddress:    dropoff,
        toLat:        dropoffCoord?.lat,
        toLng:        dropoffCoord?.lng,
        fee:          fare,
        note:         '',
      });
      const booking = res.booking || res;
      setActiveRide(booking);
      // Join socket room để nhận update
      if (socket && booking.orderId) {
        socket.emit('join_order', booking.orderId);
      }
      if (res.noDriver) {
        Alert.alert('Không có tài xế', 'Hiện không có tài xế gần bạn. Vui lòng thử lại sau.');
        setActiveRide(null);
      }
    } catch (e) {
      Alert.alert('Đặt xe thất bại', e.message);
    } finally { setBooking(false); }
  };

  const vehicle = VEHICLE_TYPES.find(v => v.id === selectedVehicle);
  const estimatedFare = distance ? calcFare(vehicle, distance, surge.multiplier) : null;
  const baseFare = distance ? calcFare(vehicle, distance, 1.0) : null;

  // ── Active Ride View ─────────────────────────────────────────
  if (activeRide) {
    const accepted = activeRide.status === 'accepted' || !!driverInfo;
    return (
      <SafeAreaView style={s.safe}>
        <StatusBar barStyle="light-content" backgroundColor={Colors.primary} />
        <View style={s.header}>
          <Text style={s.headerTitle}>
            {accepted ? '🛵 Tài xế đang đến' : '🔍 Đang tìm tài xế...'}
          </Text>
        </View>
        <View style={s.activeCard}>
          {!accepted ? (
            <ActivityIndicator color={Colors.primary} size="large" />
          ) : (
            <Text style={{ fontSize: 52 }}>🛵</Text>
          )}

          {accepted && driverInfo ? (
            <>
              <Text style={s.activeTitle}>Tài xế đang đến đón bạn!</Text>
              <View style={s.driverCard}>
                <Text style={s.driverName}>👤 {driverInfo.name}</Text>
                <Text style={s.driverPlate}>🏍️ {driverInfo.vehiclePlate}</Text>
                <TouchableOpacity
                  style={s.callBtn}
                  onPress={() => Linking.openURL(`tel:${driverInfo.phone}`)}
                >
                  <Text style={s.callBtnText}>📞 Gọi tài xế</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <Text style={s.activeTitle}>Đang kết nối tài xế gần bạn...</Text>
          )}

          <Text style={s.activeSub}>Mã chuyến: #{activeRide.orderId?.slice(-6).toUpperCase() || activeRide._id?.slice(-6).toUpperCase()}</Text>
          <View style={s.activeInfo}>
            <Text style={s.activeInfoRow}>📍 {pickup}</Text>
            <Text style={s.activeInfoArrow}>↓</Text>
            <Text style={s.activeInfoRow}>📌 {dropoff}</Text>
          </View>
          <Text style={s.activeFare}>💰 {formatCurrency(activeRide.fee || estimatedFare)}</Text>
          {!accepted && (
            <TouchableOpacity
              style={s.cancelBtn}
              onPress={() => {
                Alert.alert('Huỷ chuyến?', '', [
                  { text: 'Không', style: 'cancel' },
                  { text: 'Huỷ', style: 'destructive', onPress: () => { setActiveRide(null); setDriverInfo(null); } },
                ]);
              }}
            >
              <Text style={s.cancelBtnText}>Huỷ chuyến</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.primary} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={s.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>🚗 Đặt xe</Text>
        <View style={{ width: 32 }} />
      </View>

      {/* Surge Banner */}
      {surge.isSurge && (
        <View style={s.surgeBanner}>
          <Text style={s.surgeText}>⚡ Giờ cao điểm — Giá tăng 50%</Text>
        </View>
      )}

      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

        {/* Địa điểm */}
        <View style={s.locationCard}>
          <TouchableOpacity style={s.locationRow} onPress={() => openMapPicker('pickup')} activeOpacity={0.7}>
            <View style={s.locationDot} />
            <View style={{ flex: 1 }}>
              <Text style={s.locationLabel}>Điểm đón — bấm để chọn trên bản đồ</Text>
              <Text style={[s.locationInput, !pickup && { color: Colors.gray4 }]} numberOfLines={1}>
                {pickup || 'Chọn vị trí đón...'}
              </Text>
            </View>
            <TouchableOpacity onPress={getMyLocation} disabled={locLoading} style={s.locBtn} hitSlop={{top:10,bottom:10,left:10,right:10}}>
              {locLoading
                ? <ActivityIndicator size="small" color={Colors.primary} />
                : <Text style={s.locBtnText}>📍</Text>
              }
            </TouchableOpacity>
          </TouchableOpacity>

          <View style={s.locationDivider} />

          <TouchableOpacity style={s.locationRow} onPress={() => openMapPicker('dropoff')} activeOpacity={0.7}>
            <View style={[s.locationDot, { backgroundColor: Colors.danger }]} />
            <View style={{ flex: 1 }}>
              <Text style={s.locationLabel}>Điểm đến — bấm để chọn trên bản đồ</Text>
              <Text style={[s.locationInput, !dropoff && { color: Colors.gray4 }]} numberOfLines={1}>
                {dropoff || 'Chọn điểm đến...'}
              </Text>
            </View>
            <View style={s.locBtn}>
              <Text style={s.locBtnText}>🗺️</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Distance info */}
        {estimating && (
          <View style={s.estimatingRow}>
            <ActivityIndicator size="small" color={Colors.primary} />
            <Text style={s.estimatingText}>Đang tính khoảng cách...</Text>
          </View>
        )}
        {distance && !estimating && (
          <View style={s.distanceRow}>
            <Text style={s.distanceText}>📏 {distance} km</Text>
            {duration && <Text style={s.distanceText}>🕐 ~{duration} phút</Text>}
          </View>
        )}

        {/* Chọn loại xe */}
        <Text style={s.sectionTitle}>Chọn loại xe</Text>
        {VEHICLE_TYPES.map(v => {
          const fare = distance ? calcFare(v, distance, surge.multiplier) : v.minFee;
          const isSelected = selectedVehicle === v.id;
          return (
            <TouchableOpacity
              key={v.id}
              style={[s.vehicleCard, isSelected && s.vehicleCardActive]}
              onPress={() => setSelectedVehicle(v.id)}
            >
              <Text style={s.vehicleIcon}>{v.icon}</Text>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={[s.vehicleName, isSelected && s.vehicleNameActive]}>{v.label}</Text>
                <Text style={s.vehicleSub}>{v.subLabel} · {v.seats}</Text>
                <Text style={s.vehicleRate}>{formatCurrency(v.ratePerKm)}/km</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[s.vehicleFare, isSelected && s.vehicleFareActive]}>
                  {formatCurrency(fare)}
                </Text>
                {surge.isSurge && (
                  <Text style={s.vehicleFareBase}>
                    gốc {formatCurrency(calcFare(v, distance || v.minKm, 1.0))}
                  </Text>
                )}
                {!distance && <Text style={s.vehicleFareSub}>tối thiểu</Text>}
              </View>
              {isSelected && <View style={s.selectedCheck}><Text style={{ color: '#fff', fontSize: 12 }}>✓</Text></View>}
            </TouchableOpacity>
          );
        })}

        {/* Breakdown giá */}
        {distance && (
          <View style={s.priceBreakdown}>
            <Text style={s.breakdownTitle}>Chi tiết giá</Text>
            <View style={s.breakdownRow}>
              <Text style={s.breakdownLabel}>Phí cơ bản ({distance} km × {formatCurrency(vehicle.ratePerKm)})</Text>
              <Text style={s.breakdownValue}>{formatCurrency(baseFare)}</Text>
            </View>
            {surge.isSurge && (
              <View style={s.breakdownRow}>
                <Text style={[s.breakdownLabel, { color: Colors.warning }]}>⚡ Giờ cao điểm (+50%)</Text>
                <Text style={[s.breakdownValue, { color: Colors.warning }]}>
                  +{formatCurrency(estimatedFare - baseFare)}
                </Text>
              </View>
            )}
            <View style={[s.breakdownRow, s.breakdownTotal]}>
              <Text style={s.breakdownTotalLabel}>Tổng cộng</Text>
              <Text style={s.breakdownTotalValue}>{formatCurrency(estimatedFare)}</Text>
            </View>
          </View>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Nút đặt xe */}
      <View style={s.bookBar}>
        <View style={{ flex: 1 }}>
          <Text style={s.bookVehicle}>{vehicle.icon} {vehicle.label}</Text>
          <Text style={s.bookFare}>
            {estimatedFare ? formatCurrency(estimatedFare) : `Từ ${formatCurrency(vehicle.minFee)}`}
          </Text>
        </View>
        <TouchableOpacity
          style={[s.bookBtn, booking && s.bookBtnDis]}
          onPress={handleBook}
          disabled={booking}
        >
          {booking
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.bookBtnText}>Đặt xe →</Text>
          }
        </TouchableOpacity>
      </View>

      {/* ══ MAP PICKER MODAL ══ */}
      <Modal visible={!!mapModal} transparent={false} animationType="slide">
        <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
          {/* Header */}
          <View style={s.mapHeader}>
            <TouchableOpacity onPress={() => setMapModal(null)} style={s.mapBackBtn}>
              <Text style={s.mapBackText}>✕</Text>
            </TouchableOpacity>
            <View style={{ flex: 1, marginHorizontal: 12 }}>
              <Text style={s.mapHeaderTitle}>
                {mapModal === 'pickup' ? '📍 Chọn điểm đón' : '🎯 Chọn điểm đến'}
              </Text>
              <Text style={s.mapHeaderSub} numberOfLines={1}>
                {mapAddress || 'Kéo bản đồ để chọn vị trí'}
              </Text>
            </View>
          </View>

          {/* Map */}
          <View style={{ flex: 1 }}>
            {mapCoord && (
              <WebView
                source={{ html: buildMapHtml(mapCoord.lat, mapCoord.lng) }}
                style={{ flex: 1 }}
                onMessage={(e) => {
                  try {
                    const { lat, lng } = JSON.parse(e.nativeEvent.data);
                    setMapCoord({ lat, lng });
                  } catch {}
                }}
                javaScriptEnabled
                domStorageEnabled
                originWhitelist={['*']}
              />
            )}
          </View>

          {/* Confirm button */}
          <View style={s.mapConfirmBar}>
            <TouchableOpacity
              style={[s.mapConfirmBtn, mapLoading && { opacity: 0.6 }]}
              onPress={confirmMapLocation}
              disabled={mapLoading}
            >
              {mapLoading
                ? <ActivityIndicator color="#fff" />
                : <Text style={s.mapConfirmText}>
                    ✅ Chọn vị trí {mapModal === 'pickup' ? 'đón' : 'đến'} này
                  </Text>
              }
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

      {/* Confirm Modal */}
      <Modal visible={confirmModal} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Xác nhận đặt xe</Text>
            <View style={s.modalInfo}>
              <Text style={s.modalRow}>🚗 {vehicle.label}</Text>
              <Text style={s.modalRow}>📍 {pickup}</Text>
              <Text style={s.modalRow}>📌 {dropoff}</Text>
              {distance && <Text style={s.modalRow}>📏 {distance} km · ~{duration || '?'} phút</Text>}
              {surge.isSurge && <Text style={[s.modalRow, { color: Colors.warning }]}>⚡ Giờ cao điểm (+50%)</Text>}
            </View>
            <View style={s.modalFareRow}>
              <Text style={s.modalFareLabel}>Tổng tiền</Text>
              <Text style={s.modalFareValue}>{formatCurrency(estimatedFare || vehicle.minFee)}</Text>
            </View>
            <TouchableOpacity style={s.confirmBtn} onPress={confirmBook}>
              <Text style={s.confirmBtnText}>✅ Xác nhận đặt xe</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.modalCancel} onPress={() => setConfirmModal(false)}>
              <Text style={s.modalCancelText}>Huỷ</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.gray1 },
  header: { backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.lg },
  backBtn: { color: '#fff', fontSize: 24, fontWeight: '700' },
  headerTitle: { color: '#fff', fontWeight: '800', fontSize: 17 },
  surgeBanner: { backgroundColor: '#FF6B00', padding: 10, alignItems: 'center' },
  surgeText: { color: '#fff', fontWeight: '800', fontSize: 13 },

  // Location
  locationCard: { backgroundColor: '#fff', margin: Spacing.md, borderRadius: Radius.lg, padding: Spacing.md, ...Shadow.md },
  locationRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  locationDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: Colors.success, marginRight: 10 },
  locationLabel: { fontSize: 10, color: Colors.gray4, fontWeight: '700', marginBottom: 2 },
  locationInput: { fontSize: 14, color: Colors.text, fontWeight: '600' },
  locationDivider: { height: 1, backgroundColor: Colors.border, marginLeft: 22, marginVertical: 4 },
  locBtn: { padding: 6 },
  locBtnText: { fontSize: 20 },

  estimatingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: Spacing.md, marginBottom: 4 },
  estimatingText: { color: Colors.gray4, fontSize: 13 },
  distanceRow: { flexDirection: 'row', gap: 16, paddingHorizontal: Spacing.md, marginBottom: 8 },
  distanceText: { fontSize: 13, fontWeight: '700', color: Colors.gray5 },

  sectionTitle: { fontSize: 14, fontWeight: '800', color: Colors.text, paddingHorizontal: Spacing.md, marginBottom: 8, marginTop: 4 },

  // Vehicle cards
  vehicleCard: { backgroundColor: '#fff', marginHorizontal: Spacing.md, marginBottom: 10, borderRadius: Radius.lg, padding: Spacing.md, flexDirection: 'row', alignItems: 'center', borderWidth: 2, borderColor: 'transparent', ...Shadow.sm, position: 'relative' },
  vehicleCardActive: { borderColor: Colors.primary, backgroundColor: Colors.cream },
  vehicleIcon: { fontSize: 36 },
  vehicleName: { fontSize: 16, fontWeight: '800', color: Colors.text },
  vehicleNameActive: { color: Colors.primary },
  vehicleSub: { fontSize: 12, color: Colors.textSub, marginTop: 2 },
  vehicleRate: { fontSize: 11, color: Colors.gray4, marginTop: 2 },
  vehicleFare: { fontSize: 18, fontWeight: '900', color: Colors.text },
  vehicleFareActive: { color: Colors.primary },
  vehicleFareBase: { fontSize: 11, color: Colors.gray4, textDecorationLine: 'line-through' },
  vehicleFareSub: { fontSize: 10, color: Colors.gray4 },
  selectedCheck: { position: 'absolute', top: 8, right: 8, width: 20, height: 20, borderRadius: 10, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },

  // Price breakdown
  priceBreakdown: { backgroundColor: '#fff', margin: Spacing.md, borderRadius: Radius.lg, padding: Spacing.md, ...Shadow.sm },
  breakdownTitle: { fontWeight: '800', fontSize: 14, marginBottom: 10 },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  breakdownLabel: { fontSize: 13, color: Colors.textSub, flex: 1 },
  breakdownValue: { fontSize: 13, fontWeight: '700', color: Colors.text },
  breakdownTotal: { borderTopWidth: 1, borderTopColor: Colors.border, marginTop: 6, paddingTop: 8 },
  breakdownTotalLabel: { fontSize: 15, fontWeight: '800', color: Colors.text },
  breakdownTotalValue: { fontSize: 16, fontWeight: '900', color: Colors.primary },

  // Book bar
  bookBar: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', padding: Spacing.lg, gap: 12, ...Shadow.lg },
  bookVehicle: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '600' },
  bookFare: { color: '#fff', fontSize: 20, fontWeight: '900' },
  bookBtn: { backgroundColor: '#fff', borderRadius: Radius.md, paddingVertical: 12, paddingHorizontal: 20 },
  bookBtnDis: { opacity: 0.6 },
  bookBtnText: { color: Colors.primary, fontWeight: '900', fontSize: 15 },

  // Active ride
  activeCard: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  activeTitle: { fontSize: 18, fontWeight: '800', color: Colors.text, marginTop: 16 },
  activeSub: { fontSize: 13, color: Colors.gray4, marginTop: 4 },
  activeInfo: { backgroundColor: Colors.gray1, borderRadius: Radius.lg, padding: 16, marginTop: 20, width: '100%' },
  activeInfoRow: { fontSize: 14, color: Colors.text, fontWeight: '600' },
  activeInfoArrow: { fontSize: 18, color: Colors.gray3, marginVertical: 4, textAlign: 'center' },
  activeFare: { fontSize: 24, fontWeight: '900', color: Colors.primary, marginTop: 16 },
  cancelBtn: { marginTop: 24, borderWidth: 1.5, borderColor: Colors.danger, borderRadius: Radius.md, paddingVertical: 12, paddingHorizontal: 32 },
  cancelBtnText: { color: Colors.danger, fontWeight: '700', fontSize: 15 },
  driverCard: { backgroundColor: Colors.cream, borderRadius: Radius.lg, padding: 16, width: '100%', marginTop: 12, alignItems: 'center', gap: 6 },
  driverName: { fontSize: 16, fontWeight: '800', color: Colors.text },
  driverPlate: { fontSize: 14, fontWeight: '700', color: Colors.primary },
  callBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 10, paddingHorizontal: 24, marginTop: 8 },
  callBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle: { fontSize: 18, fontWeight: '900', marginBottom: 16 },
  modalInfo: { backgroundColor: Colors.gray1, borderRadius: Radius.md, padding: 14, gap: 8, marginBottom: 16 },
  modalRow: { fontSize: 14, color: Colors.text, fontWeight: '600' },
  modalFareRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  modalFareLabel: { fontSize: 16, fontWeight: '700', color: Colors.text },
  modalFareValue: { fontSize: 24, fontWeight: '900', color: Colors.primary },
  confirmBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center' },
  confirmBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  modalCancel: { alignItems: 'center', paddingVertical: 14 },
  modalCancelText: { color: Colors.gray4, fontSize: 14 },

  // Map picker
  mapHeader: {
    backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center',
    padding: Spacing.md, paddingTop: Spacing.lg,
  },
  mapBackBtn:    { padding: 6 },
  mapBackText:   { color: '#fff', fontSize: 20, fontWeight: '700' },
  mapHeaderTitle:{ color: '#fff', fontWeight: '800', fontSize: 15 },
  mapHeaderSub:  { color: 'rgba(255,255,255,0.75)', fontSize: 11, marginTop: 2 },
  mapConfirmBar: {
    backgroundColor: '#fff', padding: Spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.12, shadowRadius: 8, elevation: 10,
  },
  mapConfirmBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.md,
    paddingVertical: 15, alignItems: 'center',
  },
  mapConfirmText: { color: '#fff', fontWeight: '900', fontSize: 15 },
});