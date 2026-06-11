// ============================================================
// Shipper App Navigation
// ============================================================
import React from 'react';
import { Text } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Colors } from '../../shared/theme';

import { LoginScreen, ProfileScreen } from '../screens/LoginProfileScreens';
import ShipperLoginScreen   from '../screens/ShipperLoginScreen';
import HomeScreen           from '../screens/ShipperHomeScreen';
import EarningsScreen       from '../screens/EarningsScreen';
import DeliveryPaymentScreen from '../screens/DeliveryPaymentScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function TabIcon({ icon, focused }) {
  return <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.5 }}>{icon}</Text>;
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { height: 62, paddingBottom: 8, paddingTop: 6, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#EEE', elevation: 12 },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '700' },
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.gray4,
      }}
    >
      <Tab.Screen
        name="Home" component={HomeScreen}
        options={{ tabBarLabel: 'Đơn hàng', tabBarIcon: ({ focused }) => <TabIcon icon="🛵" focused={focused} /> }}
      />
      <Tab.Screen
        name="Earnings" component={EarningsScreen}
        options={{ tabBarLabel: 'Thu nhập', tabBarIcon: ({ focused }) => <TabIcon icon="💰" focused={focused} /> }}
      />
      <Tab.Screen
        name="Profile" component={ProfileScreen}
        options={{ tabBarLabel: 'Hồ sơ', tabBarIcon: ({ focused }) => <TabIcon icon="👤" focused={focused} /> }}
      />
    </Tab.Navigator>
  );
}

export default function ShipperNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="Login"
      screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
    >
      <Stack.Screen name="Login"           component={ShipperLoginScreen} />
      <Stack.Screen name="Main"            component={MainTabs} />
      <Stack.Screen
        name="DeliveryPayment"
        component={DeliveryPaymentScreen}
        options={{ animation: 'slide_from_bottom' }}
      />
    </Stack.Navigator>
  );
}
