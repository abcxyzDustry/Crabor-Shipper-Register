// ============================================================
// CRABOR Shared Auth Context — tách khỏi App.js để tránh require cycle
// ============================================================
import { createContext, useContext } from 'react';

export const AuthContext = createContext({
  isLoggedIn: false,
  setIsLoggedIn: () => {},
});

export const useAuth = () => useContext(AuthContext);
