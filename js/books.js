// ============================================
// 책 데이터 모듈 — Firestore CRUD
// ============================================
import {
  collection,
  addDoc,
  doc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  Timestamp,
} from 'firebase/firestore';
import { db } from './firebase-config.js';

/**
 * 사용자의 books 컬렉션 참조
 */
function booksCol(uid) {
  return collection(db, 'users', uid, 'books');
}

/**
 * 특정 책 문서 참조
 */
function bookDoc(uid, bookId) {
  return doc(db, 'users', uid, 'books', bookId);
}

/**
 * 책 추가
 */
export async function addBook(uid, { title, author, publisher, activityNote, confirmed }) {
  return addDoc(booksCol(uid), {
    title: title || '',
    author: author || '',
    publisher: publisher || '',
    activityNote: activityNote || '',
    confirmed: !!confirmed,
    isRead: false,
    availability: {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * CSV 텍스트 파싱 후 일괄 추가
 * @returns {number} 추가된 수
 */
export async function importCSV(uid, csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return 0;

  // BOM 제거
  let header = lines[0].replace(/^\uFEFF/, '');
  const headers = header.split(',').map((h) => h.trim().toLowerCase());

  const titleIdx = headers.findIndex((h) => h === 'title' || h === '제목');
  const authorIdx = headers.findIndex((h) => h === 'author' || h === '저자');
  const publisherIdx = headers.findIndex((h) => h === 'publisher' || h === '출판사');
  const noteIdx = headers.findIndex((h) => h === 'activitynote' || h === '독후활동');
  const confirmedIdx = headers.findIndex((h) => h === 'confirmed' || h === '확인');

  if (titleIdx === -1 || authorIdx === -1) {
    throw new Error('CSV에 title/author (또는 제목/저자) 열이 필요합니다.');
  }

  const batch = writeBatch(db);
  let count = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const title = (cols[titleIdx] || '').trim();
    const author = (cols[authorIdx] || '').trim();
    if (!title || !author) continue;

    const publisher = publisherIdx >= 0 ? (cols[publisherIdx] || '').trim() : '';
    const activityNote = noteIdx >= 0 ? (cols[noteIdx] || '').trim() : '';
    const confirmedRaw = confirmedIdx >= 0 ? (cols[confirmedIdx] || '').trim().toLowerCase() : '';
    const confirmed = ['1', 'true', 'y', 'yes', 'o', '○'].includes(confirmedRaw);

    const ref = doc(booksCol(uid));
    batch.set(ref, {
      title,
      author,
      publisher,
      activityNote,
      confirmed,
      isRead: false,
      availability: {},
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    count++;
  }

  if (count > 0) await batch.commit();
  return count;
}

/**
 * 간단한 CSV 라인 파서 (따옴표 대응)
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/**
 * 읽음 상태 토글
 */
export async function toggleRead(uid, bookId, currentIsRead) {
  return updateDoc(bookDoc(uid, bookId), {
    isRead: !currentIsRead,
    updatedAt: serverTimestamp(),
  });
}

/**
 * 도서관 조회 결과 저장
 */
export async function updateAvailability(uid, bookId, availability) {
  return updateDoc(bookDoc(uid, bookId), {
    availability,
    updatedAt: serverTimestamp(),
  });
}

/**
 * 책 정보 수정 (제목, 저자, 출판사, 메모, 확인표시)
 */
export async function updateBook(uid, bookId, { title, author, publisher, activityNote, confirmed }) {
  return updateDoc(bookDoc(uid, bookId), {
    title: title || '',
    author: author || '',
    publisher: publisher || '',
    activityNote: activityNote || '',
    confirmed: !!confirmed,
    updatedAt: serverTimestamp(),
  });
}

/**
 * 책 삭제
 */
export async function deleteBook(uid, bookId) {
  return deleteDoc(bookDoc(uid, bookId));
}

/**
 * 실시간 책 목록 구독
 * @param {(books: Array) => void} callback
 * @returns {() => void} unsubscribe 함수
 */
export function subscribeBooks(uid, callback) {
  const q = query(booksCol(uid), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snapshot) => {
    const books = [];
    snapshot.forEach((docSnap) => {
      books.push({ id: docSnap.id, ...docSnap.data() });
    });
    callback(books);
  });
}
