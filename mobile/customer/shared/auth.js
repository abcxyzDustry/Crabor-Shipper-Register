// ============================================================
// CRABOR — Auth Context (customer shared/auth.js — patched)
// ============================================================
import React, { createContext, useContext, useState, useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';
import { AuthAPI, setSessionCookie, clearSession } from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]             = useState(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loading, setLoading]       = useState(true);

  useEffect(() => { restoreSession(); }, []);

  const restoreSession = async () => {
    try {
      const cookie = await SecureStore.getItemAsync('session_cookie');
      if (cookie) {
        try {
          const data = await AuthAPI.me();
          const u = data?.user || data;
          setUser(u);
          setIsLoggedIn(true);
          // Lưu user để socket join room
          if (u?._id) await AsyncStorage.setItem('crabor_user', JSON.stringify(u));
        } catch {
          await clearSession();
        }
      }
    } catch (e) {}
    finally { setLoading(false); }
  };

  const login = async (userData, cookie) => {
    if (cookie) await setSessionCookie(cookie);
    if (userData) {
      setUser(userData);
      // Lưu user vào AsyncStorage để App.js socket có thể đọc
      await AsyncStorage.setItem('crabor_user', JSON.stringify(userData));
    }
    setIsLoggedIn(true);
  };

  const logout = async () => {
    try { await AuthAPI.logout(); } catch {}
    await clearSession();
    await AsyncStorage.removeItem('crabor_user');
    setUser(null);
    setIsLoggedIn(false);
  };

  return (
    <AuthContext.Provider value={{ user, isLoggedIn, loading, login, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
