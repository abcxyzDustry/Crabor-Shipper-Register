// ============================================================
// CRABOR — useNotificationSound hook
// Âm thanh thông báo riêng cho customer / shipper / partner
// Dùng expo-av (đã có sẵn trong expo SDK)
// ============================================================
import { useEffect, useRef } from 'react';
import { Vibration, Platform } from 'react-native';

// Fallback: nếu expo-av chưa cài, dùng Vibration pattern thay thế
let Audio = null;
try {
  Audio = require('expo-av').Audio;
} catch (_) {}

// Pattern rung tương ứng âm thanh
const VIBRATION_PATTERNS = {
  customer: [0, 200, 100, 200],          // nhẹ nhàng
  shipper:  [0, 400, 100, 400, 100, 600], // mạnh + lặp
  partner:  [0, 300, 100, 300],           // vừa
  success:  [0, 100, 50, 100, 50, 300],
  alert:    [0, 600, 200, 600],
};

// URL âm thanh dự phòng (CDN công khai)
const SOUND_URLS = {
  customer: 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3', // ding nhẹ
  shipper:  'https://assets.mixkit.co/active_storage/sfx/1862/1862-preview.mp3', // alert mạnh
  partner:  'https://assets.mixkit.co/active_storage/sfx/2873/2873-preview.mp3', // notification
  success:  'https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3',
  alert:    'https://assets.mixkit.co/active_storage/sfx/950/950-preview.mp3',
};

export function useNotificationSound(appType = 'customer') {
  const soundRef = useRef(null);

  useEffect(() => {
    // Setup audio mode
    if (Audio) {
      Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      }).catch(() => {});
    }
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  const play = async (type = appType) => {
    // Luôn rung trước
    Vibration.vibrate(VIBRATION_PATTERNS[type] || VIBRATION_PATTERNS.customer);

    if (!Audio) return; // fallback chỉ dùng rung

    try {
      // Unload sound cũ
      if (soundRef.current) {
        await soundRef.current.unloadAsync().catch(() => {});
      }
      const { sound } = await Audio.Sound.createAsync(
        { uri: SOUND_URLS[type] || SOUND_URLS.customer },
        { shouldPlay: true, volume: 1.0, isLooping: false }
      );
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) sound.unloadAsync().catch(() => {});
      });
    } catch (_) {
      // Silent fail — rung đã đủ
    }
  };

  return { play };
}

// ── Standalone helpers ─────────────────────────────────────
export function playNewOrderSound() {
  Vibration.vibrate([0, 400, 100, 400, 100, 600]);
  if (Audio) {
    Audio.Sound.createAsync(
      { uri: SOUND_URLS.shipper },
      { shouldPlay: true, volume: 1.0 }
    ).then(({ sound }) => {
      sound.setOnPlaybackStatusUpdate(s => { if (s.didJustFinish) sound.unloadAsync(); });
    }).catch(() => {});
  }
}

export function playSuccessSound() {
  Vibration.vibrate(VIBRATION_PATTERNS.success);
  if (Audio) {
    Audio.Sound.createAsync(
      { uri: SOUND_URLS.success },
      { shouldPlay: true, volume: 0.8 }
    ).then(({ sound }) => {
      sound.setOnPlaybackStatusUpdate(s => { if (s.didJustFinish) sound.unloadAsync(); });
    }).catch(() => {});
  }
}

export function playAlertSound() {
  Vibration.vibrate(VIBRATION_PATTERNS.alert);
  if (Audio) {
    Audio.Sound.createAsync(
      { uri: SOUND_URLS.alert },
      { shouldPlay: true, volume: 1.0 }
    ).then(({ sound }) => {
      sound.setOnPlaybackStatusUpdate(s => { if (s.didJustFinish) sound.unloadAsync(); });
    }).catch(() => {});
  }
}
