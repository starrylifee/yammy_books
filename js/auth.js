// ============================================
// 인증 모듈 — Google OAuth
// ============================================
import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { auth } from './firebase-config.js';

const provider = new GoogleAuthProvider();
// 매번 계정 선택 화면 표시
provider.setCustomParameters({ prompt: 'select_account' });

/**
 * Google 팝업 로그인
 */
export async function loginWithGoogle() {
  return signInWithPopup(auth, provider);
}

/**
 * 로그아웃
 */
export async function logout() {
  return signOut(auth);
}

/**
 * 인증 상태 변경 리스너
 * @param {(user: import('firebase/auth').User | null) => void} callback
 */
export function onAuth(callback) {
  return onAuthStateChanged(auth, callback);
}
