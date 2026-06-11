// ============================================================
// useRequireAuth — Hook bảo vệ screen cần đăng nhập
// ============================================================
// Cách dùng trong bất kỳ screen nào:
//
//   import { useRequireAuth } from '../../shared/useRequireAuth';
//
//   export default function CheckoutScreen({ navigation }) {
//     const { isLoggedIn, guardAction } = useRequireAuth(navigation);
//     ...
//     // Bọc action cần auth:
//     const handleOrder = guardAction(() => {
//       // code đặt hàng ở đây, chỉ chạy nếu đã đăng nhập
//     });
//
//     return <Button onPress={handleOrder} title="Đặt hàng" />;
//   }
// ============================================================
import { useEffect } from 'react';
import { useAuth } from './auth';

export function useRequireAuth(navigation) {
  const { isLoggedIn, user } = useAuth();

  // Nếu screen này BẮT BUỘC đăng nhập (gọi ở đầu screen):
  const requireAuth = () => {
    if (!isLoggedIn) {
      navigation.navigate('Login');
      return false;
    }
    return true;
  };

  // Bọc một action: chỉ chạy nếu đã đăng nhập
  const guardAction = (fn) => (...args) => {
    if (!isLoggedIn) {
      navigation.navigate('Login');
      return;
    }
    return fn(...args);
  };

  return { isLoggedIn, user, requireAuth, guardAction };
}
