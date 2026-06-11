// ============================================================
// CRABOR Customer — App Navigator
// Mở thẳng vào Main, Login chỉ hiện khi cần auth
// ============================================================
import React from 'react';
import { Text } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Colors } from '../../shared/theme';

// Screens
import HomeScreen            from '../screens/HomeScreen';
import FoodScreen            from '../screens/FoodScreen';
import OrdersScreen          from '../screens/OrdersScreen';
import ProfileScreen         from '../screens/ProfileScreen';
import LoginScreen           from '../screens/LoginScreen'; // Updated: no OTP
import RestaurantMenuScreen  from '../screens/RestaurantMenuScreen';
import CheckoutScreen        from '../screens/CheckoutScreen';
import WalletTopupScreen     from '../screens/WalletTopupScreen';
import PayOSPaymentScreen    from '../screens/PayOSPaymentScreen';
import SettingsScreen        from '../screens/SettingsScreen';
import OrderDetailScreen     from '../screens/OrderDetailScreen';
import WalletScreen          from '../screens/WalletScreen';
import AddressScreen         from '../screens/AddressScreen';
import LoyaltyScreen         from '../screens/LoyaltyScreen';
import VouchersScreen        from '../screens/VouchersScreen';
import SalesScreen           from '../screens/SalesScreen';
import CocoScreen            from '../screens/CocoScreen';
import SupportScreen         from '../screens/SupportScreen';
import CompleteProfileScreen from '../screens/CompleteProfileScreen';
import RideScreen            from '../screens/RideScreen';
import LaundryScreen         from '../screens/LaundryScreen';
import CleaningScreen        from '../screens/CleaningScreen';

const Stack = createNativeStackNavigator();
const Tab   = createBottomTabNavigator();

function Ico({ icon, focused }) {
  return <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.5 }}>{icon}</Text>;
}

// ── Bottom Tabs ──────────────────────────────────────────────
function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          height: 62, paddingBottom: 8, paddingTop: 6,
          backgroundColor: '#fff', borderTopWidth: 1,
          borderTopColor: '#EEE', elevation: 12,
        },
        tabBarLabelStyle:      { fontSize: 10, fontWeight: '700' },
        tabBarActiveTintColor:   Colors.primary,
        tabBarInactiveTintColor: Colors.gray4,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ tabBarLabel: 'Trang chủ', tabBarIcon: ({ focused }) => <Ico icon="🏠" focused={focused} /> }}
      />
      <Tab.Screen
        name="Food"
        component={FoodScreen}
        options={{ tabBarLabel: 'Đặt đồ ăn', tabBarIcon: ({ focused }) => <Ico icon="🍽️" focused={focused} /> }}
      />
      <Tab.Screen
        name="Orders"
        component={OrdersScreen}
        options={{ tabBarLabel: 'Đơn hàng', tabBarIcon: ({ focused }) => <Ico icon="📦" focused={focused} /> }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{ tabBarLabel: 'Tôi', tabBarIcon: ({ focused }) => <Ico icon="👤" focused={focused} /> }}
      />
    </Tab.Navigator>
  );
}

// ── Root Stack ───────────────────────────────────────────────
export default function AppNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="Main"          // ← Luôn vào Main trước
      screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
    >
      {/* Main app - không cần đăng nhập để xem */}
      <Stack.Screen name="Main"    component={MainTabs} />

      {/* Login - push lên khi cần, back được về chỗ cũ */}
      <Stack.Screen
        name="Login"
        component={LoginScreen}
        options={{ animation: 'slide_from_bottom', gestureEnabled: true }}
      />

      {/* Screens cần auth */}
      <Stack.Screen name="Checkout"         component={CheckoutScreen} />
      <Stack.Screen name="WalletTopup"      component={WalletTopupScreen} options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="PayOSPayment"     component={PayOSPaymentScreen} options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="Settings"         component={SettingsScreen} />
      <Stack.Screen name="OrderDetail"      component={OrderDetailScreen} />
      <Stack.Screen name="Wallet"           component={WalletScreen} />
      <Stack.Screen name="Address"          component={AddressScreen} />
      <Stack.Screen name="Loyalty"          component={LoyaltyScreen} />
      <Stack.Screen name="Vouchers"         component={VouchersScreen} />
      <Stack.Screen name="Sales"            component={SalesScreen} />
      <Stack.Screen name="Coco"             component={CocoScreen} />
      <Stack.Screen name="Support"          component={SupportScreen} />
      <Stack.Screen name="CompleteProfile"  component={CompleteProfileScreen} />
      <Stack.Screen name="RestaurantMenu"   component={RestaurantMenuScreen} />
      <Stack.Screen name="Ride"             component={RideScreen} />
      <Stack.Screen name="Laundry"          component={LaundryScreen} />
      <Stack.Screen name="Cleaning"         component={CleaningScreen} />
    </Stack.Navigator>
  );
}
