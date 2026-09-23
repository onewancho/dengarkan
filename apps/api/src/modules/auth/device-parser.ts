// ============================================
// DENGARKAN — Auth Module: Device Parser
//
// Extracts friendly device & browser string from User-Agent.
// Formats: "iPhone (Safari)", "Windows PC (Chrome)", "Android (Chrome)", etc.
// ============================================

export function parseDeviceFromUserAgent(ua: string | undefined | null): string {
  if (!ua || typeof ua !== 'string' || ua.trim() === '') {
    return 'Perangkat Tidak Dikenal';
  }

  const str = ua.trim();

  // 1. Detect Hardware / Operating System
  let os = 'PC / Komputer';
  if (/iPad/i.test(str)) {
    os = 'iPad';
  } else if (/iPhone/i.test(str)) {
    os = 'iPhone';
  } else if (/Android/i.test(str)) {
    if (/Samsung|SM-|GT-/i.test(str)) {
      os = 'Samsung (Android)';
    } else if (/Pixel/i.test(str)) {
      os = 'Google Pixel';
    } else if (/Xiaomi|Redmi|POCO/i.test(str)) {
      os = 'Xiaomi (Android)';
    } else {
      os = 'Android';
    }
  } else if (/Macintosh|Mac OS X/i.test(str)) {
    os = 'Mac';
  } else if (/Windows NT|Windows/i.test(str)) {
    os = 'Windows PC';
  } else if (/Linux/i.test(str)) {
    os = 'Linux PC';
  }

  // 2. Detect Browser
  let browser = 'Browser';
  if (/SamsungBrowser/i.test(str)) {
    browser = 'Samsung Internet';
  } else if (/Edg|Edge/i.test(str)) {
    browser = 'Edge';
  } else if (/OPR|Opera/i.test(str)) {
    browser = 'Opera';
  } else if (/CriOS/i.test(str)) {
    browser = 'Chrome';
  } else if (/FxiOS|Firefox/i.test(str)) {
    browser = 'Firefox';
  } else if (/Chrome/i.test(str) && !/Edge|Edg|OPR/i.test(str)) {
    browser = 'Chrome';
  } else if (/Safari/i.test(str) && !/Chrome|CriOS|Android/i.test(str)) {
    browser = 'Safari';
  }

  return `${os} (${browser})`;
}
