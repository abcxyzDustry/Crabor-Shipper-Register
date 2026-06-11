// ============================================================
// CRABOR Shared Socket — tách khỏi App.js để tránh require cycle
// ============================================================
let _socket = null;

export const getSocket = () => _socket;
export const setSocket = (s) => { _socket = s; };
