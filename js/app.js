// ============================================
// Yammy Books — 메인 앱 로직
// ============================================
import { loginWithGoogle, logout, onAuth } from './auth.js';
import {
  addBook,
  importCSV,
  toggleRead,
  updateAvailability,
  updateBook,
  deleteBook,
  subscribeBooks,
} from './books.js';
import { checkBook, checkMultipleBooks } from './library-search.js';
import YAMMY_BOOKS from './yammy-books-data.js';

// ── DOM Helpers ──
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ── App State ──
const state = {
  user: null,
  books: [],
  unsubBooks: null,
};

// ── Toast Notification ──
function showToast(message, type = 'info') {
  const container = $('#toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ── Google Auth Error → 한글 ──
function authErrorMessage(code) {
  if (code === 'auth/popup-closed-by-user') return '로그인 창이 닫혔습니다.';
  if (code === 'auth/popup-blocked') return '팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.';
  if (code === 'auth/cancelled-popup-request') return '';
  return `로그인 오류: ${code}`;
}

// ── Availability Summary Rendering ──
function availabilitySummary(book, key) {
  const data = book.availability?.[key];
  if (!data) {
    return '<span class="status-pill muted">미조회</span>';
  }
  if (data.error) {
    return `<span class="status-pill no">오류</span><div class="avail-detail">${data.error}</div>`;
  }
  if (!data.matched || !data.result) {
    return '<span class="status-pill no">미소장/불명</span>';
  }
  const result = data.result;
  const cls = result.available ? 'ok' : 'no';
  const statusText = result.statusText || (result.available ? '대출가능' : '대출불가');
  return `
    <span class="status-pill ${cls}">${statusText}</span>
    <div class="avail-detail">${result.libraryName || data.libraryName || ''}</div>
    <div class="avail-detail">${result.shelf || ''}</div>
  `;
}

// ── 독서로(버들초) 검색 링크 생성 ──
// 독서로는 CSR SPA라서 서버 프록시 파싱 불가 → 직접 링크로 연결
const DOKSERO_CONFIG = {
  neisCode: 'B100005384',
  provCode: 'B10',
  schoolName: '서울버들초등학교',
};

function dokseroSearchUrl(title) {
  const params = new URLSearchParams({
    searchKeyword: title,
    provCode: DOKSERO_CONFIG.provCode,
    neisCode: DOKSERO_CONFIG.neisCode,
    schoolName: DOKSERO_CONFIG.schoolName,
  });
  return `https://read365.edunet.net/PureScreen/SchoolSearchResult?${params.toString()}`;
}

function dokseroLink(book) {
  const url = dokseroSearchUrl(book.title);
  return `<a href="${url}" target="_blank" rel="noopener" class="btn-doksero">📖 독서로 검색</a>`;
}

// ── Filter Books ──
function filteredBooks() {
  const q = $('#searchInput').value.trim().toLowerCase();
  const f = $('#statusFilter').value;

  return state.books.filter((book) => {
    const hay = `${book.title} ${book.author} ${book.publisher || ''}`.toLowerCase();
    if (q && !hay.includes(q)) return false;

    const anyAvail = ['spclib', 'sp2lib'].some(
      (k) => book.availability?.[k]?.result?.available
    );
    const anyChecked = ['spclib', 'sp2lib'].some((k) => book.availability?.[k]);

    if (f === 'read' && !book.isRead) return false;
    if (f === 'unread' && book.isRead) return false;
    if (f === 'available' && !anyAvail) return false;
    if (f === 'unavailable' && (!anyChecked || anyAvail)) return false;
    if (f === 'unchecked' && anyChecked) return false;
    return true;
  });
}

// ── Render Books Table ──
function renderBooks() {
  const tbody = $('#booksTbody');
  tbody.innerHTML = '';

  const books = filteredBooks();

  // Update count
  const countEl = $('#bookCount');
  countEl.innerHTML = `표시 <strong>${books.length}</strong> / 전체 <strong>${state.books.length}</strong>권`;

  if (!books.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td colspan="9">
        <div class="empty-state">
          <div class="empty-icon">📚</div>
          <p>아직 표시할 책이 없어요.<br />직접 추가하거나 CSV를 올려보세요.</p>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
    return;
  }

  books.forEach((book) => {
    const tr = document.createElement('tr');
    if (book.isRead) tr.classList.add('is-read');

    tr.innerHTML = `
      <td>
        <input type="checkbox" ${book.isRead ? 'checked' : ''} data-action="toggle" data-id="${book.id}" />
      </td>
      <td class="book-title-cell">
        <div class="book-title-text">${escapeHtml(book.title)}</div>
        ${book.confirmed ? '<div class="book-confirmed">✓ 확인표시</div>' : ''}
      </td>
      <td class="book-meta">${escapeHtml(book.author)}</td>
      <td class="book-meta">${escapeHtml(book.publisher || '')}</td>
      <td class="book-note">${escapeHtml(book.activityNote || '')}</td>
      <td>${availabilitySummary(book, 'spclib')}</td>
      <td>${availabilitySummary(book, 'sp2lib')}</td>
      <td>${dokseroLink(book)}</td>
      <td>
        <div class="action-cell">
          <button class="btn-check" data-action="check" data-id="${book.id}">🔍 조회</button>
          <button class="btn-edit" data-action="edit" data-id="${book.id}">✏️ 수정</button>
          <button class="btn-delete" data-action="delete" data-id="${book.id}">삭제</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Auth UI ──
function renderAuthUI() {
  const authScreen = $('#authScreen');
  const appScreen = $('#appScreen');
  const authBar = $('#authBar');

  if (!state.user) {
    authScreen.classList.remove('hidden');
    appScreen.classList.add('hidden');
    authBar.innerHTML = '';
    return;
  }

  authScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');

  const displayName = state.user.displayName || '사용자';
  const email = state.user.email || '';

  const photoURL = state.user.photoURL || '';
  authBar.innerHTML = `
    <div class="top-user">
      ${photoURL ? `<img src="${photoURL}" class="user-photo" alt="프로필" />` : ''}
      <span class="user-name">${escapeHtml(displayName)}</span>
      <span class="user-email">${escapeHtml(email)}</span>
      <button id="logoutBtn" class="btn-logout">로그아웃</button>
    </div>
  `;

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await logout();
      showToast('로그아웃 되었습니다.', 'info');
    } catch (err) {
      showToast('로그아웃 실패: ' + err.message, 'error');
    }
  });
}

// ── Subscribe to Books (Firestore real-time) ──
function startBookSubscription(uid) {
  if (state.unsubBooks) state.unsubBooks();
  state.unsubBooks = subscribeBooks(uid, (books) => {
    state.books = books;
    renderBooks();
  });
}

// ── Initialize App ──
function init() {

  // Auth state listener
  onAuth((user) => {
    state.user = user;
    renderAuthUI();

    if (user) {
      startBookSubscription(user.uid);
    } else {
      if (state.unsubBooks) {
        state.unsubBooks();
        state.unsubBooks = null;
      }
      state.books = [];
      renderBooks();
    }
  });

  // ── Google 로그인 버튼 ──
  $('#googleLoginBtn').addEventListener('click', async () => {
    const errorEl = $('#googleLoginError');
    errorEl.textContent = '';
    try {
      await loginWithGoogle();
      showToast('환영합니다! 🎉', 'success');
    } catch (err) {
      const msg = authErrorMessage(err.code);
      if (msg) errorEl.textContent = msg;
    }
  });

  // ── Add Book Form ──
  $('#bookForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.user) return;

    const fd = new FormData(e.target);
    const bookData = {
      title: fd.get('title')?.trim() || '',
      author: fd.get('author')?.trim() || '',
      publisher: fd.get('publisher')?.trim() || '',
      activityNote: fd.get('activityNote')?.trim() || '',
      confirmed: fd.get('confirmed') === 'on',
    };

    if (!bookData.title || !bookData.author) {
      showToast('제목과 저자를 입력해주세요.', 'warning');
      return;
    }

    try {
      await addBook(state.user.uid, bookData);
      e.target.reset();
      showToast(`"${bookData.title}" 추가 완료!`, 'success');
    } catch (err) {
      showToast('추가 실패: ' + err.message, 'error');
    }
  });

  // ── CSV Upload ──
  $('#csvUploadBtn').addEventListener('click', async () => {
    if (!state.user) return;

    const file = $('#csvFile').files[0];
    if (!file) {
      showToast('CSV 파일을 골라주세요.', 'warning');
      return;
    }

    try {
      const text = await file.text();
      const count = await importCSV(state.user.uid, text);
      showToast(`${count}권 업로드 완료! 📚`, 'success');
      $('#csvFile').value = '';
    } catch (err) {
      showToast('CSV 업로드 실패: ' + err.message, 'error');
    }
  });

  // ── Check Unread Books (Batch) ──
  $('#checkUnreadBtn').addEventListener('click', async () => {
    if (!state.user) return;

    const btn = $('#checkUnreadBtn');
    const unreadBooks = state.books.filter((b) => !b.isRead);

    if (!unreadBooks.length) {
      showToast('안 읽은 책이 없습니다.', 'info');
      return;
    }

    btn.disabled = true;
    const originalText = btn.textContent;
    btn.innerHTML = `<span class="spinner"></span> 조회 중... (0/${unreadBooks.length})`;

    try {
      let done = 0;
      await checkMultipleBooks(unreadBooks, async (bookId, availability) => {
        await updateAvailability(state.user.uid, bookId, availability);
        done++;
        btn.innerHTML = `<span class="spinner"></span> 조회 중... (${done}/${unreadBooks.length})`;
      });
      showToast(`${unreadBooks.length}권 일괄 조회 완료!`, 'success');
    } catch (err) {
      showToast('일괄 조회 실패: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  // ── Table Click Delegation ──
  $('#booksTbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !state.user) return;

    const bookId = btn.dataset.id;
    const action = btn.dataset.action;

    if (action === 'check') {
      const book = state.books.find((b) => b.id === bookId);
      if (!book) return;

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';

      try {
        const availability = await checkBook(book.title, book.author);
        await updateAvailability(state.user.uid, bookId, availability);
        showToast(`"${book.title}" 조회 완료`, 'success');
      } catch (err) {
        showToast('조회 실패: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '🔍 조회';
      }
    }

    if (action === 'delete') {
      const book = state.books.find((b) => b.id === bookId);
      if (!book) return;

      if (!confirm(`"${book.title}"을(를) 삭제하시겠습니까?`)) return;

      try {
        await deleteBook(state.user.uid, bookId);
        showToast(`"${book.title}" 삭제 완료`, 'info');
      } catch (err) {
        showToast('삭제 실패: ' + err.message, 'error');
      }
    }

    if (action === 'edit') {
      window._openEditModal(bookId);
    }
  });

  // ── Table Checkbox Delegation (Toggle Read) ──
  $('#booksTbody').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-action="toggle"]');
    if (!input || !state.user) return;

    const bookId = input.dataset.id;
    const book = state.books.find((b) => b.id === bookId);
    if (!book) return;

    try {
      await toggleRead(state.user.uid, bookId, book.isRead);
    } catch (err) {
      showToast('상태 변경 실패: ' + err.message, 'error');
    }
  });

  // ── Filters ──
  $('#searchInput').addEventListener('input', renderBooks);
  $('#statusFilter').addEventListener('change', renderBooks);

  // ── Edit Modal ──
  const editModal = $('#editModal');
  const editForm = $('#editBookForm');

  // 모달 열기 (table delegation에서 호출)
  window._openEditModal = function (bookId) {
    const book = state.books.find((b) => b.id === bookId);
    if (!book) return;
    $('#editBookId').value = bookId;
    $('#editTitle').value = book.title || '';
    $('#editAuthor').value = book.author || '';
    $('#editPublisher').value = book.publisher || '';
    $('#editNote').value = book.activityNote || '';
    $('#editConfirmed').checked = !!book.confirmed;
    editModal.classList.remove('hidden');
  };

  // 모달 닫기
  $('#editCancelBtn').addEventListener('click', () => {
    editModal.classList.add('hidden');
  });

  editModal.addEventListener('click', (e) => {
    if (e.target === editModal) editModal.classList.add('hidden');
  });

  // 저장
  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.user) return;
    const bookId = $('#editBookId').value;
    const data = {
      title: $('#editTitle').value.trim(),
      author: $('#editAuthor').value.trim(),
      publisher: $('#editPublisher').value.trim(),
      activityNote: $('#editNote').value.trim(),
      confirmed: $('#editConfirmed').checked,
    };
    if (!data.title || !data.author) {
      showToast('제목과 저자는 필수입니다.', 'warning');
      return;
    }
    try {
      await updateBook(state.user.uid, bookId, data);
      editModal.classList.add('hidden');
      showToast('수정 완료!', 'success');
    } catch (err) {
      showToast('수정 실패: ' + err.message, 'error');
    }
  });

  // ── 야미독서 리스트 학년 선택 ──
  const gradePreview = $('#gradePreview');

  $$('.grade-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      // 선택 상태 토글
      $$('.grade-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const grade = parseInt(btn.dataset.grade);
      const books = YAMMY_BOOKS[grade];
      if (!books || !books.length) {
        gradePreview.classList.add('hidden');
        return;
      }

      // 미리보기 + 불러오기 버튼
      gradePreview.classList.remove('hidden');
      gradePreview.innerHTML = `
        <div class="preview-header">
          <strong>${grade}학년 야미독서 리스트</strong>
          <span class="preview-count">${books.length}권</span>
        </div>
        <div class="preview-list">
          ${books.map((b) => `<span class="preview-item">${b.no}. ${b.title}</span>`).join('')}
        </div>
        <button id="importGradeBtn" class="btn-import-grade" data-grade="${grade}">
          🌟 ${grade}학년 리스트 ${books.length}권 내 목록에 추가
        </button>
      `;

      $('#importGradeBtn').addEventListener('click', async () => {
        if (!state.user) {
          showToast('로그인이 필요합니다.', 'warning');
          return;
        }
        const importBtn = $('#importGradeBtn');
        importBtn.disabled = true;
        importBtn.innerHTML = '<span class="spinner"></span> 추가 중...';

        try {
          let count = 0;
          for (const book of books) {
            await addBook(state.user.uid, {
              title: book.title,
              author: book.author,
              publisher: book.publisher || '',
              activityNote: '',
              confirmed: false,
            });
            count++;
          }
          showToast(`${grade}학년 ${count}권 추가 완료! 🌟`, 'success');
          gradePreview.classList.add('hidden');
          $$('.grade-btn').forEach((b) => b.classList.remove('active'));
        } catch (err) {
          showToast('추가 실패: ' + err.message, 'error');
        } finally {
          importBtn.disabled = false;
        }
      });
    });
  });
}

// ── Boot ──
init();
