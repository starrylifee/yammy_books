// ============================================
// 도서관 검색 모듈 — Vercel Serverless 프록시 호출
// ============================================

const LIBRARY_SOURCES = ['spclib', 'sp2lib', 'bdllib'];

async function checkSingleSource(title, author, publisher, source) {
  try {
    const res = await fetch('/api/library-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, title, author, publisher }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.warn(`[조회 실패] ${source} "${title}" → HTTP ${res.status}`, errData);
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    // 브라우저 콘솔 디버그 — 서버가 돌려준 파싱 결과 확인
    console.log(
      `[조회] ${source} "${title}" → matched=${data.matched} ` +
        `items=${data._debug?.items ?? '?'} htmlLen=${data._debug?.htmlLen ?? '?'} ` +
        `status=${data._debug?.status ?? '?'} cookie=${data._debug?.cookieSent ?? '?'}` +
        (data.error ? ` error=${data.error}` : ''),
      data,
    );
    if (data._debug?.htmlHead) {
      console.log(`[조회 HTML] ${source} "${title}":\n`, data._debug.htmlHead);
    }
    return data;
  } catch (err) {
    console.error(`[조회 오류] ${source} "${title}":`, err.message);
    return {
      source,
      error: err.message,
      checkedAt: Math.floor(Date.now() / 1000),
    };
  }
}

/**
 * 단일 책에 대해 모든 도서관 소스 조회
 */
export async function checkBook(title, author, publisher) {
  const results = {};
  for (const source of LIBRARY_SOURCES) {
    results[source] = await checkSingleSource(title, author, publisher, source);
  }
  return results;
}

/**
 * 여러 책 일괄 조회 (모든 도서관)
 */
export async function checkMultipleBooks(books, onResult) {
  for (const book of books) {
    const availability = await checkBook(book.title, book.author, book.publisher);
    await onResult(book.id, availability);
  }
}

/**
 * 여러 책을 특정 도서관 하나만 조회
 * @param {string} source - 'spclib' | 'sp2lib' | 'bdllib'
 * @param {(bookId: string, source: string, result: object) => Promise<void>} onResult
 */
export async function checkBooksForSource(books, source, onResult) {
  for (const book of books) {
    const result = await checkSingleSource(book.title, book.author, book.publisher, source);
    await onResult(book.id, source, result);
  }
}
