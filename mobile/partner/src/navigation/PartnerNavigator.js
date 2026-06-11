// ============================================================
// Partner App Navigation — Auth-based conditional stack + Mode Switch
// ============================================================
import React, { useState } from 'react';
import { Text } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Colors } from '../../shared/theme';
import { useAuth } from '../../shared/auth';

import LoginScreen            from '../screens/LoginScreen';
import OrdersScreen           from '../screens/OrdersScreen';
import MenuScreen             from '../screens/MenuScreen';
import StatsScreen            from '../screens/StatsScreen';
import SettingsScreen         from '../screens/SettingsScreen';
import MapScreen              from '../screens/MapScreen';
import ConfirmHandoverScreen  from '../screens/ConfirmHandoverScreen';
import WalletScreen           from '../screens/WalletScreen';
import LaundryPartnerScreen   from '../screens/LaundryPartnerScreen';
import { usePartnerMode }     from '../screens/PartnerModeSwitch';

const Stack = createNativeStackNavigator();
const Tab   = createBottomTabNavigator();

function Ico({ icon, focused }) {
  return <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.5 }}>{icon}</Text>;
}

function MainTabs() {
  const { mode, setMode } = usePartnerMode();

  if (mode === 'laundry') {
    // Laundry mode — tab đơn giản hơn
    return (
      <Tab.Navigator screenOptions={{
        headerShown: false,
        tabBarStyle: { height: 62, paddingBottom: 8, paddingTop: 6, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#EEE', elevation: 12 },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '700' },
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.gray4,
      }}>
        <Tab.Screen name="LaundryOrders"
          options={{ tabBarLabel: 'Giặt là', tabBarIcon: ({ focused }) => <Ico icon="🧺" focused={focused} /> }}>
          {(props) => <LaundryPartnerScreen {...props} onSwitchMode={() => setMode('food')} />}
        </Tab.Screen>
        <Tab.Screen name="Stats"    component={StatsScreen}
          options={{ tabBarLabel: 'Thống kê', tabBarIcon: ({ focused }) => <Ico icon="📊" focused={focused} /> }} />
        <Tab.Screen name="Settings" component={SettingsScreen}
          options={{ tabBarLabel: 'Cài đặt', tabBarIcon: ({ focused }) => <Ico icon="⚙️" focused={focused} /> }} />
        <Tab.Screen name="SwitchMode"
          options={{ tabBarLabel: '🍜 Đồ ăn', tabBarIcon: ({ focused }) => <Ico icon="⇄" focused={focused} /> }}>
          {(props) => {
            React.useEffect(() => { setMode('food'); }, []);
            return null;
          }}
        </Tab.Screen>
      </Tab.Navigator>
    );
  }

  // Food mode (default)
  return (
    <Tab.Navigator screenOptions={{
      headerShown: false,
      tabBarStyle: { height: 62, paddingBottom: 8, paddingTop: 6, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#EEE', elevation: 12 },
      tabBarLabelStyle: { fontSize: 10, fontWeight: '700' },
      tabBarActiveTintColor: Colors.primary,
      tabBarInactiveTintColor: Colors.gray4,
    }}>
      <Tab.Screen name="Orders"   component={OrdersScreen}
        options={{ tabBarLabel: 'Đơn hàng', tabBarIcon: ({ focused }) => <Ico icon="📦" focused={focused} /> }} />
      <Tab.Screen name="Menu"     component={MenuScreen}
        options={{ tabBarLabel: 'Thực đơn', tabBarIcon: ({ focused }) => <Ico icon="🍽️" focused={focused} /> }} />
      <Tab.Screen name="Stats"    component={StatsScreen}
        options={{ tabBarLabel: 'Thống kê', tabBarIcon: ({ focused }) => <Ico icon="📊" focused={focused} /> }} />
      <Tab.Screen name="Settings" component={SettingsScreen}
        options={{ tabBarLabel: 'Cài đặt', tabBarIcon: ({ focused }) => <Ico icon="⚙️" focused={focused} /> }} />
      <Tab.Screen name="SwitchLaundry"
        options={{ tabBarLabel: '👕 Giặt là', tabBarIcon: ({ focused }) => <Ico icon="⇄" focused={focused} /> }}>
        {() => { React.useEffect(() => { setMode('laundry'); }, []); return null; }}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <Stack.Screen name="Main"            component={MainTabs} />
      <Stack.Screen name="Map"             component={MapScreen} />
      <Stack.Screen name="ConfirmHandover" component={ConfirmHandoverScreen} />
      <Stack.Screen name="Wallet"          component={WalletScreen} />
    </Stack.Navigator>
  );
}

function GuestStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Login" component={LoginScreen} options={{ animation: 'fade' }} />
    </Stack.Navigator>
  );
}

export default function PartnerNavigator() {
  const { isLoggedIn } = useAuth();
  return isLoggedIn ? <AuthStack /> : <GuestStack />;
}
