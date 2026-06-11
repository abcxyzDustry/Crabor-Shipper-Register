// ============================================================
// CRABOR Design System — shared across all 3 apps
// ============================================================

export const Colors = {
  primary: '#E8504A',      // coral-red
  primaryDark: '#C83B35',
  primaryLight: '#FF6B65',
  cream: '#FFF8F0',
  white: '#FFFFFF',
  black: '#1A1A1A',
  gray1: '#F5F5F5',
  gray2: '#EEEEEE',
  gray3: '#CCCCCC',
  gray4: '#999999',
  gray5: '#666666',
  success: '#27AE60',
  warning: '#F39C12',
  danger: '#E74C3C',
  info: '#3498DB',
  text: '#1A1A1A',
  textSub: '#666666',
  textLight: '#999999',
  border: '#EEEEEE',
  shadow: 'rgba(0,0,0,0.08)',
  overlay: 'rgba(0,0,0,0.5)',
};

export const Typography = {
  h1: { fontSize: 24, fontWeight: '800', color: Colors.text },
  h2: { fontSize: 20, fontWeight: '800', color: Colors.text },
  h3: { fontSize: 17, fontWeight: '700', color: Colors.text },
  h4: { fontSize: 15, fontWeight: '700', color: Colors.text },
  body: { fontSize: 14, fontWeight: '400', color: Colors.text },
  bodyBold: { fontSize: 14, fontWeight: '700', color: Colors.text },
  small: { fontSize: 12, fontWeight: '400', color: Colors.textSub },
  smallBold: { fontSize: 12, fontWeight: '700', color: Colors.textSub },
  caption: { fontSize: 11, fontWeight: '400', color: Colors.textLight },
};

export const Spacing = {
  xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24,
};

export const Radius = {
  sm: 8, md: 12, lg: 16, xl: 20, full: 999,
};

export const Shadow = {
  sm: {
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 4, elevation: 2,
  },
  md: {
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1, shadowRadius: 8, elevation: 4,
  },
  lg: {
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 12, elevation: 8,
  },
};

export const formatCurrency = (n) =>
  (n || 0).toLocaleString('vi-VN') + 'đ';

export const formatDate = (d) =>
  d ? new Date(d).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';

export const formatTime = (d) =>
  d ? new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';

export const formatDateTime = (d) => d ? `${formatTime(d)} ${formatDate(d)}` : '';

export const ORDER_STATUS = {
  pending: { label: 'Chờ xác nhận', color: Colors.warning },
  confirmed: { label: 'Đã xác nhận', color: Colors.info },
  preparing: { label: 'Đang chuẩn bị', color: Colors.info },
  ready: { label: 'Sẵn sàng giao', color: Colors.primary },
  picking_up: { label: 'Đang lấy hàng', color: Colors.primary },
  delivering: { label: 'Đang giao', color: Colors.primary },
  delivered: { label: 'Đã giao', color: Colors.success },
  cancelled: { label: 'Đã huỷ', color: Colors.danger },
};
